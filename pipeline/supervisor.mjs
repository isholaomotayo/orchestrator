// The supervisor: the only thing that starts workers, and the only thing that
// advances a roadmap.
//
// It runs no model. Every decision here is a deterministic reading of files on
// disk — which is what makes it cheap enough to sit in a loop, and what makes
// its behaviour reproducible in a test with an injected clock and a fake spawn.
// Judgment belongs to the coordinator agent and the operator; this process only
// notices, classifies, and escalates.
//
// One feature runs at a time. Within a feature, tickets run in parallel:
//
//   plan  ──▶ tickets (parallel, one worktree each) ──▶ integrate ──▶ merge
//    │              │                                      │            │
//    └─ specs.md    └─ each commits on its own branch       └─ reviews   └─ operator
//                                                             the whole    approves,
//                                                             feature      then a live
//                                                                          check runs
import fs from 'node:fs';
import path from 'node:path';
import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import {
  pipelinePaths, loadConfig, acquireLockFile, atomicWrite, pidAlive, appendLine,
} from './state.mjs';
import { newRunId, writeRunMeta, readRunMeta, appendRunVerb, renderBrief } from './run-registry.mjs';
import { resolvePoolRunner, checkRunnerAvailable } from './adapters.mjs';
import { parseTickets, sliceSpecForTicket, scheduleTickets } from './tickets.mjs';
import { setFeatureStatus, nextFeature } from './roadmap.mjs';
import { classifyEvent, appendAttention, openDecision, openDecisions } from './attention.mjs';
import * as pool from './pool.mjs';
import {
  createRunWorktree, removeRunWorktree, commitRunWork, currentSha, changedFiles,
} from './worktrees.mjs';
import {
  mergeTransition, openPullRequest, checkMergeable, mergePullRequest, prBodyFrom, detectForge,
} from './merging.mjs';

const ENGINE = 'pipeline/orchestrator.mjs';

export function createSupervisor({
  repoRoot = process.cwd(),
  spawn = nodeSpawn,
  now = () => Date.now(),
  log = (line) => appendLine(pipelinePaths(repoRoot).supervisorLog, `${new Date().toISOString()} ${line}`),
} = {}) {
  const paths = pipelinePaths(repoRoot);
  const config = loadConfig(paths);
  const poolCfg = pool.poolConfig(config);
  const mergeCfg = pool.mergeConfig(config);
  // Per-run memory of what we last saw, so an unchanged state does not
  // re-escalate on every tick.
  const seen = new Map();

  function roadmap() { return pool.readRoadmap(paths); }
  function saveRoadmap(next) { return pool.writeRoadmap(paths, next); }

  // First candidate that names an actual runner rather than deferring
  // further — 'auto' and unset both mean "keep looking" — falling back to
  // 'auto' itself once every candidate has deferred.
  function pickRunner(...candidates) {
    for (const c of candidates) if (c && c !== 'auto') return c;
    return 'auto';
  }

  // A feature/ticket's runner may resolve to a real CLI (spawned headless, in
  // the background, for genuine unattended parallel automation) or to 'host'
  // (no subprocess at all — the run is left for a human to claim and complete
  // in chat, exactly like single-run mode already works). Only the former
  // needs an authenticated CLI on the machine; the latter is the zero-setup
  // default a roadmap runs under with nothing authenticated anywhere.
  function spawnWorker({ runId, featureId, ticketId, kind, brief, branch, baseRef, runner, extra = [] }) {
    const runPaths = pipelinePaths(repoRoot, { runId });
    fs.mkdirSync(runPaths.dir, { recursive: true });

    const avail = checkRunnerAvailable(runner, config);
    if (!avail.ok) {
      // Fails clean, as an attention item — not as a throw inside a detached
      // child process nobody is watching.
      appendAttention(paths, {
        runId, featureId, ticketId, kind: 'runner-unavailable', escalate: true,
        summary: `Resolved runner "${runner}" for ${featureId}${ticketId ? `/${ticketId}` : ''} is not usable: ${avail.reason}`,
      });
      log(`runner unavailable for ${runId}: ${avail.reason}`);
      return { runId, pid: null, blocked: true };
    }

    const args = [
      ENGINE,
      '--run-id', runId,
      '--mode', 'cli',
      '--runner', runner,
      '--feature-id', featureId,
      ...(ticketId ? ['--ticket-id', ticketId] : []),
      ...(brief ? ['--brief-file', brief] : []),
      ...(branch ? ['--branch', branch] : []),
      ...(baseRef ? ['--base-ref', baseRef] : []),
      ...extra,
    ];
    const outFile = path.join(runPaths.dir, 'orchestrator.out');
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    const out = fs.openSync(outFile, 'a');
    const metaBase = {
      runId, featureId, ticketId, kind, branch, baseRef, runner,
      worktree: path.relative(repoRoot, runPaths.worktree),
      brief: brief ? path.relative(repoRoot, brief) : null,
    };

    if (runner === 'host') {
      // A host invocation always does setup, hands off exactly one stage, and
      // exits — it never blocks (adapters.mjs's runAgent returns immediately
      // for 'host') — so a bounded foreground call is safe here, and it
      // reuses 100% of orchestrator.mjs's own setup logic (locking, worktree
      // creation, run.json, status.json) instead of duplicating it.
      writeRunMeta(runPaths, { ...metaBase, pid: null, phase: 'spawned', spawnedAt: new Date(now()).toISOString() });
      appendRunVerb(runPaths, 'note', `spawned ${kind} run (host)`);
      const result = spawnSync(process.execPath, args, {
        cwd: repoRoot, env: { ...process.env }, stdio: ['ignore', out, out], timeout: 30_000,
      });
      if (result.error) log(`host spawn error for ${runId}: ${result.error.message}`);
      log(`spawned ${kind} run ${runId} for ${featureId}${ticketId ? `/${ticketId}` : ''} — host runner, awaiting chat`);
      return { runId, pid: null };
    }

    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      env: { ...process.env },
      stdio: ['ignore', out, out],
      detached: true,
    });
    if (child.unref) child.unref();
    writeRunMeta(runPaths, { ...metaBase, pid: child.pid ?? null, phase: 'spawned', spawnedAt: new Date(now()).toISOString() });
    appendRunVerb(runPaths, 'note', `spawned ${kind} run`);
    log(`spawned ${kind} run ${runId} for ${featureId}${ticketId ? `/${ticketId}` : ''} (pid ${child.pid})`);
    return { runId, pid: child.pid ?? null };
  }

  function writeBrief({ runId, title, featureId, ticketId, mode, base, branch, body }) {
    fs.mkdirSync(paths.briefs, { recursive: true });
    const file = path.join(paths.briefs, `${runId}.md`);
    fs.writeFileSync(file, renderBrief({
      title,
      header: { run: runId, feature: featureId, ticket: ticketId ?? '', mode, base: base ?? '', branch: branch ?? '' },
      body,
    }));
    return file;
  }

  // ---- feature lifecycle ---------------------------------------------------

  function startFeature(rm, feature) {
    const baseRef = feature.baseRef || currentSha(repoRoot, rm.base);
    const runId = newRunId({ featureId: feature.id, kind: 'plan' });
    const brief = writeBrief({
      runId, title: feature.title, featureId: feature.id, ticketId: null,
      mode: feature.mode, base: baseRef, branch: feature.branch,
      body: [
        feature.description,
        '',
        feature.acceptance?.length ? `Acceptance criteria:\n${feature.acceptance.map((a) => `- ${a}`).join('\n')}` : '',
      ].filter(Boolean).join('\n'),
    });
    spawnWorker({
      runId, featureId: feature.id, ticketId: null, kind: 'plan',
      brief, branch: `pipeline/work/${feature.id}/plan-${runId}`, baseRef,
      runner: resolvePoolRunner(pickRunner(feature.runner, poolCfg.defaultRunner)),
      extra: ['--plan-only', ...(poolCfg.featurePlanApproval ? ['--approve-plan'] : [])],
    });
    saveRoadmap(setFeatureStatus(rm, feature.id, 'planning', {
      baseRef, specRunId: runId, startedAt: new Date(now()).toISOString(),
    }));
  }

  function startTickets(rm, feature, runs) {
    const specRunPaths = pipelinePaths(repoRoot, { runId: feature.specRunId });
    let specs;
    try { specs = fs.readFileSync(specRunPaths.specs, 'utf8'); } catch { return; }
    const tickets = parseTickets(specs);
    if (!tickets.length) {
      // A feature small enough to need no decomposition still needs building:
      // treat the whole specification as a single ticket.
      tickets.push({ id: 'T1', title: feature.title, files: [], dependsOn: [], runner: null, body: feature.description, block: '' });
    }

    const recorded = feature.tickets?.length ? feature.tickets : tickets.map((t) => ({ id: t.id, title: t.title, runId: null, status: 'queued' }));
    const done = recorded.filter((t) => t.status === 'committed').map((t) => t.id);
    const running = recorded.filter((t) => t.status === 'running').map((t) => t.id);
    const runningFiles = Object.fromEntries(recorded
      .filter((t) => t.status === 'running' && t.runId)
      .map((t) => [t.runId, tickets.find((x) => x.id === t.id)?.files || []]));

    const wave = scheduleTickets(tickets, {
      done, running,
      maxParallel: feature.maxParallel || poolCfg.maxParallel,
      runningFiles,
      serializeOnFileOverlap: poolCfg.serializeOnFileOverlap,
    });

    const updated = [...recorded];
    for (const ticket of wave) {
      const runId = newRunId({ featureId: feature.id, ticketId: ticket.id, kind: 'ticket' });
      const sliceFile = path.join(paths.briefs, `${runId}.specs.md`);
      fs.mkdirSync(paths.briefs, { recursive: true });
      fs.writeFileSync(sliceFile, tickets.length > 1 && ticket.block ? sliceSpecForTicket(specs, ticket.id) : specs);
      const brief = writeBrief({
        runId, title: ticket.title, featureId: feature.id, ticketId: ticket.id,
        mode: feature.mode, base: feature.baseRef, branch: `pipeline/work/${feature.id}/${runId}`,
        body: ticket.body || feature.description,
      });
      spawnWorker({
        runId, featureId: feature.id, ticketId: ticket.id, kind: 'ticket',
        brief, branch: `pipeline/work/${feature.id}/${runId}`, baseRef: feature.baseRef,
        runner: resolvePoolRunner(pickRunner(ticket.runner, feature.runner, poolCfg.defaultRunner)),
        extra: [
          '--specs-file', sliceFile,
          ...(poolCfg.ticketFlags.reviewPanel ? ['--review-panel'] : []),
        ],
      });
      const row = updated.find((t) => t.id === ticket.id);
      if (row) { row.runId = runId; row.status = 'running'; } else { updated.push({ id: ticket.id, title: ticket.title, runId, status: 'running' }); }
    }
    if (wave.length || !feature.tickets?.length) {
      saveRoadmap(setFeatureStatus(roadmap(), feature.id, 'executing', { tickets: updated }));
    }
  }

  /** A ticket run finished: commit its work so the branch can be merged. */
  function commitTicket(feature, ticketRow, run) {
    const runPaths = pipelinePaths(repoRoot, { runId: run.runId });
    const worktree = runPaths.worktree;
    if (!fs.existsSync(worktree)) return { ok: false, reason: 'worktree is gone' };
    const files = changedFiles(worktree, run.meta?.baseRef || feature.baseRef);
    const res = commitRunWork({
      worktreePath: worktree,
      message: `feat(${feature.id}${ticketRow.id ? `/${ticketRow.id}` : ''}): ${ticketRow.title}\n\nRun: ${run.runId}`,
    });
    writeRunMeta(runPaths, { phase: 'committed', committedSha: res.sha, changedFiles: files });
    appendRunVerb(runPaths, 'note', res.nothingToCommit ? 'no changes to commit' : `committed ${res.sha?.slice(0, 8)}`);
    return { ok: true, ...res };
  }

  /** Every ticket committed: merge them onto the feature branch and review it. */
  function integrateFeature(rm, feature) {
    const runId = newRunId({ featureId: feature.id, kind: 'integration' });
    const runPaths = pipelinePaths(repoRoot, { runId });
    fs.mkdirSync(runPaths.dir, { recursive: true });

    // The feature branch starts where the feature started, then each ticket
    // branch is merged onto it in ticket order.
    createRunWorktree({
      repoRoot, runDir: runPaths.dir, worktreePath: runPaths.worktree,
      branch: feature.branch, baseRef: feature.baseRef,
    });

    for (const ticket of feature.tickets || []) {
      if (!ticket.runId) continue;
      const ticketMeta = readRunMeta(pipelinePaths(repoRoot, { runId: ticket.runId }));
      const branch = ticketMeta?.branch;
      if (!branch || ticketMeta?.committedSha == null) continue;
      const merged = tryMerge(runPaths.worktree, branch);
      if (!merged.ok) {
        // A conflict is a judgment call, not something to guess at.
        const decision = openDecision(paths, {
          runId, featureId: feature.id, kind: 'merge-conflict', stage: 'coder',
          question: `Ticket ${ticket.id} conflicts with the rest of ${feature.id}. How should it be resolved?`,
          options: ['rerun-ticket', 'resolve-manually', 'drop-ticket'],
          recommended: 'rerun-ticket',
          artifacts: [path.relative(repoRoot, runPaths.worktree)],
        });
        appendAttention(paths, {
          runId, featureId: feature.id, kind: 'merge-conflict', decisionId: decision.id,
          summary: `${feature.id}: ticket ${ticket.id} conflicts on ${merged.files.join(', ') || 'unknown files'}`,
        });
        appendRunVerb(runPaths, 'blocked', `merge-conflict ${ticket.id}`);
        saveRoadmap(setFeatureStatus(roadmap(), feature.id, 'integrating', { integrationRunId: runId, conflict: { ticketId: ticket.id } }));
        return;
      }
    }

    // Review the whole feature against where it started, not against the branch
    // head it was just built from — otherwise the diff is empty.
    const specRunPaths = pipelinePaths(repoRoot, { runId: feature.specRunId });
    const changesFile = collectTicketChanges(feature, runPaths);
    const brief = writeBrief({
      runId, title: `Integrate ${feature.title}`, featureId: feature.id, ticketId: null,
      mode: feature.mode, base: feature.baseRef, branch: feature.branch,
      body: `Verify and review the complete feature "${feature.title}" now that every ticket has been merged onto ${feature.branch}.`,
    });
    spawnWorker({
      runId, featureId: feature.id, ticketId: null, kind: 'integration',
      brief, branch: null, baseRef: feature.baseRef,
      runner: resolvePoolRunner(pickRunner(feature.runner, poolCfg.defaultRunner)),
      extra: [
        '--worktree', path.relative(repoRoot, runPaths.worktree),
        '--specs-file', specRunPaths.specs,
        ...(changesFile ? ['--changes-file', changesFile] : []),
        '--start-at', 'tester',
        ...(poolCfg.integrationFlags.reviewPanel ? ['--review-panel'] : []),
        ...(poolCfg.integrationFlags.report ? ['--report'] : []),
      ],
    });
    saveRoadmap(setFeatureStatus(roadmap(), feature.id, 'reviewing', { integrationRunId: runId }));
  }

  function tryMerge(worktree, branch) {
    const res = spawnSync('git', ['merge', '--no-ff', '--no-edit', branch], { cwd: worktree, encoding: 'utf8' });
    if (res.status === 0) return { ok: true, files: [] };
    const conflicted = spawnSync('git', ['diff', '--name-only', '--diff-filter=U'], { cwd: worktree, encoding: 'utf8' });
    spawnSync('git', ['merge', '--abort'], { cwd: worktree, encoding: 'utf8' });
    return { ok: false, files: (conflicted.stdout || '').trim().split('\n').filter(Boolean) };
  }

  function collectTicketChanges(feature, runPaths) {
    const parts = [];
    for (const ticket of feature.tickets || []) {
      if (!ticket.runId) continue;
      const p = pipelinePaths(repoRoot, { runId: ticket.runId });
      try { parts.push(`## ${ticket.id}: ${ticket.title}\n\n${fs.readFileSync(p.changes, 'utf8')}`); } catch { /* nothing recorded */ }
    }
    if (!parts.length) return null;
    const file = path.join(runPaths.dir, 'merged-changes.md');
    fs.writeFileSync(file, `# Changes\n\n${parts.join('\n\n---\n\n')}\n\n## Self-Review\n\nCompiled from each ticket's own self-review above.\n`);
    return file;
  }

  // ---- landing -------------------------------------------------------------

  function landFeature(rm, feature, run) {
    const runPaths = pipelinePaths(repoRoot, { runId: run.runId });
    const state = feature.mergeState || 'reviewing';

    if (state === 'reviewing') {
      const res = commitRunWork({
        worktreePath: runPaths.worktree,
        message: `feat(${feature.id}): ${feature.title}\n\n${(feature.acceptance || []).join('\n')}\nRun: ${run.runId}`,
      });
      const next = mergeTransition('reviewing', 'approved');
      saveRoadmap(setFeatureStatus(roadmap(), feature.id, 'awaiting_merge_approval', {
        mergeState: mergeCfg.mode === 'pr' ? next : mergeTransition(next, 'local_ready'),
        committedSha: res.sha ?? currentSha(runPaths.worktree),
      }));
      return;
    }
    if (state === 'committed' && mergeCfg.mode === 'pr') {
      const pushed = gitIn(repoRoot, ['push', '-u', mergeCfg.remote, feature.branch]);
      if (pushed.status !== 0) {
        escalate(feature, run, 'push_failed', `Could not push ${feature.branch}: ${pushed.stderr.trim()}`);
        saveRoadmap(setFeatureStatus(roadmap(), feature.id, 'awaiting_merge_approval', { mergeState: 'push_failed' }));
        return;
      }
      const remoteUrl = gitIn(repoRoot, ['remote', 'get-url', mergeCfg.remote]).stdout.trim();
      const provider = detectForge(remoteUrl) || 'github';
      const bodyFile = path.join(runPaths.dir, 'pr_body.md');
      fs.writeFileSync(bodyFile, prBodyFrom({
        report: readIfExists(path.join(runPaths.reports, 'work-done.md')),
        feature, verdict: run.status?.verdict,
      }));
      const pr = openPullRequest({
        cwd: repoRoot, provider, base: rm.base, head: feature.branch,
        title: `${feature.id}: ${feature.title}`, bodyFile,
      });
      if (!pr.ok) {
        escalate(feature, run, 'pr_failed', `Could not open a pull request: ${pr.error}`);
        saveRoadmap(setFeatureStatus(roadmap(), feature.id, 'awaiting_merge_approval', { mergeState: 'pr_failed' }));
        return;
      }
      askForMergeApproval(feature, run, pr);
      return;
    }
    if (state === 'awaiting_merge_approval' || (state === 'committed' && mergeCfg.mode !== 'pr')) {
      if (!openDecisions(paths).some((d) => d.featureId === feature.id && d.kind === 'merge-approval')) {
        askForMergeApproval(feature, run, feature.pr);
      }
    }
  }

  function askForMergeApproval(feature, run, pr = null) {
    const decision = openDecision(paths, {
      runId: run.runId, featureId: feature.id, kind: 'merge-approval', stage: 'reviewer',
      question: `${feature.id} (${feature.title}) is reviewed and ready. Merge it into ${roadmap().base}?`,
      options: ['approve', 'request-changes'],
      recommended: 'approve',
      artifacts: [
        path.relative(repoRoot, pipelinePaths(repoRoot, { runId: run.runId }).reviewReport),
        ...(pr?.url ? [pr.url] : []),
      ],
    });
    appendAttention(paths, {
      runId: run.runId, featureId: feature.id, kind: 'merge-approval', decisionId: decision.id,
      summary: `${feature.id} is ready to merge${pr?.url ? ` — ${pr.url}` : ''}`,
    });
    saveRoadmap(setFeatureStatus(roadmap(), feature.id, 'awaiting_merge_approval', {
      mergeState: 'awaiting_merge_approval',
      pr: pr ? { provider: pr.provider ?? null, url: pr.url ?? null, number: pr.number ?? null, head: pr.head ?? null } : feature.pr ?? null,
    }));
    // The operator may have pre-authorised merging; even then the live check runs.
    if (mergeCfg.autoMerge) pool.approveMerge(paths, feature.id, { by: 'config', via: 'autoMerge' });
  }

  function performMerge(rm, feature) {
    if (mergeCfg.mode === 'pr' && feature.pr?.url) {
      const check = checkMergeable({
        cwd: repoRoot, provider: feature.pr.provider || 'github', url: feature.pr.url,
        expectedHead: feature.pr.head, requireMergeable: mergeCfg.requireMergeable,
      });
      if (!check.ok) {
        escalate(feature, { runId: feature.integrationRunId }, 'not_mergeable', `Not merging ${feature.id}: ${check.reason}`);
        saveRoadmap(setFeatureStatus(roadmap(), feature.id, 'awaiting_merge_approval', { mergeState: 'not_mergeable' }));
        return;
      }
      const merged = mergePullRequest({
        cwd: repoRoot, provider: feature.pr.provider || 'github', url: feature.pr.url, method: mergeCfg.mergeMethod,
      });
      if (!merged.ok) {
        escalate(feature, { runId: feature.integrationRunId }, 'merge_failed', `Merge of ${feature.id} did not land: ${merged.reason}`);
        saveRoadmap(setFeatureStatus(roadmap(), feature.id, 'awaiting_merge_approval', { mergeState: 'merge_failed' }));
        return;
      }
      gitIn(repoRoot, ['fetch', mergeCfg.remote, rm.base]);
      finishLanding(feature, currentSha(repoRoot, `${mergeCfg.remote}/${rm.base}`));
      return;
    }

    // local-only: merge the feature branch into the base in this repository.
    const merged = gitIn(repoRoot, ['merge', '--no-ff', '--no-edit', feature.branch]);
    if (merged.status !== 0) {
      escalate(feature, { runId: feature.integrationRunId }, 'merge_failed', `Local merge of ${feature.branch} failed: ${merged.stderr.trim()}`);
      saveRoadmap(setFeatureStatus(roadmap(), feature.id, 'awaiting_merge_approval', { mergeState: 'merge_failed' }));
      return;
    }
    finishLanding(feature, currentSha(repoRoot));
  }

  function finishLanding(feature, landedSha) {
    const runPaths = feature.integrationRunId ? pipelinePaths(repoRoot, { runId: feature.integrationRunId }) : null;
    if (runPaths) appendRunVerb(runPaths, 'landed', landedSha?.slice(0, 8) || '');
    let rm = setFeatureStatus(roadmap(), feature.id, 'landed', {
      mergeState: 'landed',
      landedSha,
      landedAt: new Date(now()).toISOString(),
      reportRel: runPaths && fs.existsSync(path.join(runPaths.reports, 'work-done.html'))
        ? path.relative(repoRoot, path.join(runPaths.reports, 'work-done.html'))
        : null,
    });
    // The next feature starts from what actually landed, not from where this
    // one started.
    const upcoming = nextFeature(rm);
    if (upcoming) rm = setFeatureStatus(rm, upcoming.id, 'queued', { baseRef: landedSha });
    saveRoadmap(rm);
    appendAttention(paths, {
      featureId: feature.id, kind: 'landed', escalate: false,
      summary: `${feature.id} (${feature.title}) landed`,
    });
    if (mergeCfg.cleanupOnMerge) cleanupFeature(feature);
    log(`landed ${feature.id} at ${landedSha}`);
  }

  function cleanupFeature(feature) {
    const targets = [
      ...(feature.tickets || []).map((t) => t.runId).filter(Boolean),
      feature.integrationRunId,
      feature.specRunId,
    ].filter(Boolean);
    for (const runId of targets) {
      const runPaths = pipelinePaths(repoRoot, { runId });
      const meta = readRunMeta(runPaths);
      const res = removeRunWorktree({
        repoRoot, worktreePath: runPaths.worktree,
        branch: meta?.branch ?? null, integratedInto: feature.branch,
      });
      if (!res.ok) {
        // Never delete work that has not landed. A refusal is recorded and left.
        appendRunVerb(runPaths, 'note', `cleanup refused: ${res.reason}`);
        log(`cleanup refused for ${runId}: ${res.reason}`);
      }
    }
  }

  function escalate(feature, run, kind, summary) {
    appendAttention(paths, { runId: run?.runId ?? null, featureId: feature?.id ?? null, kind, summary });
    log(`escalated ${kind}: ${summary}`);
  }

  // ---- one pass ------------------------------------------------------------

  function tick() {
    const rm = roadmap();
    if (!rm) return { ok: false, reason: 'no compiled roadmap' };

    const runs = pool.listRunStates(paths, poolCfg, now());
    const paused = fs.existsSync(paths.paused);

    // 1. Notice what changed, and tell a human when it matters.
    for (const run of runs) {
      const previous = seen.get(run.runId) || { state: null, verb: null };
      const current = {
        state: run.state, verb: run.verb, detail: run.verbDetail, status: run.status,
      };
      const event = classifyEvent({
        runId: run.runId, featureId: run.featureId, previous, current,
        staleSince: run.lastOutputAt, verbSince: run.verbSince, now: now(),
      }, poolCfg);
      if (event) {
        if (event.escalate) {
          const decisionId = event.kind === 'plan-approval'
            ? openDecision(paths, {
              runId: run.runId, featureId: run.featureId, kind: 'plan-approval', stage: 'planner',
              question: `Approve the plan for ${run.featureId}${run.ticketId ? `/${run.ticketId}` : ''}?`,
              options: ['approve', 'revise'], recommended: 'approve',
              artifacts: [path.relative(repoRoot, pipelinePaths(repoRoot, { runId: run.runId }).specs)],
            }).id
            : null;
          appendAttention(paths, { ...event, ...(decisionId ? { decisionId } : {}) });
        }
        log(`${run.runId}: ${event.kind} — ${event.summary}`);
      }
      seen.set(run.runId, { state: run.state, verb: run.verb });
    }

    // 2. Honour resume/extend requests recorded by the operator's verbs.
    if (!paused) for (const run of runs) {
      const requests = run.meta?.requests;
      if (!requests) continue;
      if (requests.extend && run.status?.overall === 'halted') {
        respawn(run, ['--resume', '--extend', String(requests.extend.cycles)]);
        clearRequests(run);
      } else if (requests.resume && ['halted', 'awaiting_plan_approval'].includes(run.status?.overall)) {
        // Deliberately excludes 'awaiting_chat': that state is only ever
        // advanced by a human's own --continue after claiming the run (see
        // `pool claim`), never by the supervisor respawning it — and
        // orchestrator.mjs's own --resume guard does not accept that state
        // anyway.
        respawn(run, run.status.overall === 'awaiting_plan_approval' ? ['--continue'] : ['--resume']);
        clearRequests(run);
      }
    }

    // 3. Advance the feature currently in flight.
    if (!paused) advanceFeature(rm, runs);

    // 4. Publish state for the dashboard and the coordinator.
    const snap = pool.snapshot(paths, { config, now: new Date(now()) });
    pool.writeSnapshot(paths, snap);
    pool.writePrimaryMirror(paths, { snap, runs, config });
    touchHeartbeat();
    return { ok: true, snapshot: snap, runs };
  }

  function advanceFeature(rm, runs) {
    const current = rm.features.find((f) => f.id === rm.currentFeatureId)
      ?? rm.features.find((f) => !['landed', 'skipped', 'failed', 'held', 'queued'].includes(f.status));

    if (!current) {
      const upcoming = nextFeature(rm);
      if (upcoming) startFeature(rm, upcoming);
      return;
    }
    const byRun = (id) => runs.find((r) => r.runId === id);

    switch (current.status) {
      case 'queued':
        startFeature(rm, current);
        return;
      case 'planning': {
        const planRun = byRun(current.specRunId);
        if (planRun?.status?.overall === 'done') startTickets(rm, current, runs);
        else if (planRun?.status?.overall === 'halted') {
          escalate(current, planRun, 'halted', `Planning for ${current.id} halted: ${planRun.status.haltReason}`);
          saveRoadmap(setFeatureStatus(rm, current.id, 'failed', {}));
        }
        return;
      }
      case 'executing': {
        let changed = false;
        const tickets = (current.tickets || []).map((t) => ({ ...t }));
        for (const ticket of tickets) {
          if (ticket.status !== 'running' || !ticket.runId) continue;
          const run = byRun(ticket.runId);
          if (!run) continue;
          if (run.status?.overall === 'done') {
            commitTicket(current, ticket, run);
            ticket.status = 'committed';
            changed = true;
          } else if (run.status?.overall === 'halted') {
            ticket.status = 'failed';
            changed = true;
            escalate(current, run, 'halted', `${current.id}/${ticket.id} halted: ${run.status.haltReason}`);
          }
        }
        if (changed) saveRoadmap(setFeatureStatus(roadmap(), current.id, 'executing', { tickets }));
        const after = roadmap().features.find((f) => f.id === current.id);
        const all = after.tickets || [];
        if (all.length && all.every((t) => t.status === 'committed')) {
          integrateFeature(roadmap(), after);
        } else if (all.some((t) => t.status === 'failed')) {
          saveRoadmap(setFeatureStatus(roadmap(), current.id, 'failed', {}));
        } else {
          startTickets(roadmap(), after, runs);
        }
        return;
      }
      case 'reviewing': {
        const run = byRun(current.integrationRunId);
        if (!run) return;
        if (run.status?.overall === 'done' && run.status?.verdict === 'APPROVED') {
          landFeature(rm, current, run);
        } else if (run.status?.overall === 'halted' || (run.status?.overall === 'done' && run.status?.verdict !== 'APPROVED')) {
          escalate(current, run, 'review-failed', `${current.id} was not approved: ${run.status.verdict || run.status.haltReason}`);
          saveRoadmap(setFeatureStatus(rm, current.id, 'failed', {}));
        }
        return;
      }
      case 'awaiting_merge_approval': {
        const run = byRun(current.integrationRunId) || { runId: current.integrationRunId, status: null };
        if (['committed', 'push_failed', 'pr_failed'].includes(current.mergeState)) landFeature(rm, current, run);
        else landFeature(rm, current, run);
        return;
      }
      case 'merge_approved':
        performMerge(rm, current);
        return;
      default:
    }
  }

  function respawn(run, extra) {
    const meta = run.meta || {};
    // Reuse whatever runner this run was actually spawned with — never
    // re-derive from the feature, which may have been edited since.
    spawnWorker({
      runId: run.runId, featureId: meta.featureId, ticketId: meta.ticketId,
      kind: meta.kind || 'ticket', brief: null, branch: null, baseRef: null,
      runner: resolvePoolRunner(meta.runner),
      extra,
    });
  }

  function clearRequests(run) {
    const runPaths = pipelinePaths(repoRoot, { runId: run.runId });
    const meta = readRunMeta(runPaths) || {};
    delete meta.requests;
    if (runPaths.runMeta) atomicWrite(runPaths.runMeta, JSON.stringify(meta, null, 2));
  }

  function touchHeartbeat() {
    try {
      const lock = JSON.parse(fs.readFileSync(paths.controlLock, 'utf8'));
      atomicWrite(paths.controlLock, JSON.stringify({ ...lock, heartbeatAt: new Date(now()).toISOString() }));
    } catch { /* not holding the lock (e.g. a test driving tick directly) */ }
  }

  let timer = null;
  function start() {
    if (!acquireLockFile(paths.controlLock, { pid: process.pid, role: 'supervisor' })) {
      throw new Error('Another supervisor is already running for this project.');
    }
    // Hold the repo-level lock too, so every v1 "is this repo busy?" check stays
    // truthful while a pool is active.
    acquireLockFile(paths.lock, { pid: process.pid, role: 'supervisor' });
    fs.writeFileSync(paths.supervisorPid, String(process.pid));
    log(`supervisor started (pid ${process.pid})`);
    const loop = () => { try { tick(); } catch (err) { log(`tick failed: ${err.stack || err.message}`); } };
    loop();
    timer = setInterval(loop, poolCfg.pollMs);
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop(signal));
    return { pid: process.pid };
  }

  function stop(signal = null) {
    if (timer) clearInterval(timer);
    // Workers are asked to stop, never killed outright: the engine's own signal
    // handler marks them INTERRUPTED so they can be resumed rather than lost.
    for (const run of pool.listRunStates(paths, poolCfg, now())) {
      if (run.pidAlive && run.pid) {
        try { process.kill(run.pid, 'SIGTERM'); } catch { /* already gone */ }
        appendRunVerb(pipelinePaths(repoRoot, { runId: run.runId }), 'paused', 'supervisor stopping');
      }
    }
    for (const lockFile of [paths.controlLock, paths.lock]) {
      try {
        const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
        if (lock.pid === process.pid) fs.unlinkSync(lockFile);
      } catch { /* not ours */ }
    }
    try { fs.unlinkSync(paths.supervisorPid); } catch { /* already gone */ }
    log(`supervisor stopped${signal ? ` (${signal})` : ''}`);
    if (signal) process.exit(0);
  }

  return { tick, start, stop, paths, config, poolCfg, mergeCfg };
}

// Small helpers kept at the bottom so the lifecycle above reads top to bottom.
function gitIn(cwd, args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function readIfExists(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}
