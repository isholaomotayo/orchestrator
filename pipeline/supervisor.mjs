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
//
// With `review: end`, the last column is deferred: each approved feature is
// accepted onto a working branch and the next one starts immediately. The
// operator reviews once, when the list is done, before anything reaches base.
import fs from 'node:fs';
import path from 'node:path';
import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from 'node:child_process';
import {
  pipelinePaths, loadConfig, acquireLockFile, atomicWrite, pidAlive, appendLine,
  writeStatus, newStatus,
} from './state.mjs';
import { newRunId, writeRunMeta, readRunMeta, appendRunVerb, renderBrief } from './run-registry.mjs';
import { resolvePoolRunner, checkRunnerAvailable, resolveExecutionSurface } from './adapters.mjs';
import { parseTickets, sliceSpecForTicket, scheduleTickets } from './tickets.mjs';
import { setFeatureStatus, nextFeature, featureBriefContext, setRoadmapStatus } from './roadmap.mjs';
import { classifyEvent, appendAttention, openDecision, openDecisions, readDecisions } from './attention.mjs';
import * as pool from './pool.mjs';
import {
  createRunWorktree, removeRunWorktree, commitRunWork, currentSha, changedFiles, branchExists,
} from './worktrees.mjs';
import {
  mergeTransition, openPullRequest, checkMergeable, mergePullRequest, prBodyFrom, detectForge,
} from './merging.mjs';

const ENGINE = 'pipeline/orchestrator.mjs';

export function createSupervisor({
  repoRoot = process.cwd(),
  spawn = nodeSpawn,
  spawnSync = nodeSpawnSync,
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
  let resumingThisTick = new Set();
  let schedulingOffset = 0;

  function roadmap() { return pool.readRoadmap(paths); }
  // Before the first feature is accepted, `rm.workingBranch` is only a name —
  // the git ref itself materializes on the first `acceptOntoWorkingBranch`.
  function targetRef(rm) {
    return rm.review === 'end' && branchExists(repoRoot, rm.workingBranch) ? rm.workingBranch : rm.base;
  }
  function saveRoadmap(next) { return pool.writeRoadmap(paths, next); }

  // First candidate that names an actual runner rather than deferring
  // further — 'auto' and unset both mean "keep looking" — falling back to
  // 'auto' itself once every candidate has deferred.
  function pickRunner(...candidates) {
    for (const c of candidates) if (c && c !== 'auto') return c;
    return 'auto';
  }

  function persistRunRecord(runPaths, {
    runId, featureId, ticketId, kind, runner, branch, baseRef, brief, pid = null,
    phase = 'spawned', haltReason = null, haltDetail = null,
  }) {
    const surface = resolveExecutionSurface({ runner });
    let existing = null;
    try { existing = JSON.parse(fs.readFileSync(runPaths.status, 'utf8')); } catch { /* first write */ }
    // A resume must not clobber the orchestrator's halt record — otherwise
    // MAX_CYCLES looks "running" again and the feature never fails. Bootstrap
    // status.json only for a brand-new run, or overwrite when this spawn is
    // itself the terminal failure (runner unavailable, host early-exit).
    if (haltReason || !existing) {
      const status = existing && haltReason ? { ...existing } : newStatus(`${kind} ${featureId}${ticketId ? `/${ticketId}` : ''}`, {});
      status.runner = runner;
      status.executionSurface = surface;
      status.invocationMode = surface === 'host-handoff' ? 'chat' : 'cli';
      status.featureId = featureId;
      status.ticketId = ticketId;
      status.runId = runId;
      if (haltReason) {
        status.overall = 'halted';
        status.haltReason = haltReason;
        status.haltTransient = false;
        status.endedAt = new Date(now()).toISOString();
        if (haltDetail) {
          const row = (status.stages || []).find((s) => s.name === 'planner') || status.stages?.[0];
          if (row) { row.status = 'failed'; row.detail = haltDetail; }
        }
      }
      writeStatus(runPaths, status);
    }
    writeRunMeta(runPaths, {
      runId, featureId, ticketId, kind, branch, baseRef, runner,
      worktree: runPaths.worktree ? path.relative(repoRoot, runPaths.worktree) : null,
      brief, pid, phase, spawnedAt: new Date(now()).toISOString(),
      executionSurface: surface,
    });
  }

  function alreadyPending(runId, kind, handoffId = null) {
    return pool.pendingAttention(paths).some((item) => item.runId === runId && item.kind === kind && (!handoffId || item.handoffId === handoffId));
  }

  function raiseAttention(item) {
    if (item.runId && item.kind && alreadyPending(item.runId, item.kind)) return null;
    return appendAttention(paths, item);
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
      persistRunRecord(runPaths, {
        runId, featureId, ticketId, kind, runner, branch, baseRef,
        brief: brief ? path.relative(repoRoot, brief) : null,
        phase: 'failed', haltReason: 'RUNNER_UNAVAILABLE', haltDetail: avail.reason,
      });
      appendRunVerb(runPaths, 'failed', `runner-unavailable: ${avail.reason}`);
      raiseAttention({
        runId, featureId, ticketId, kind: 'runner-unavailable', escalate: true,
        summary: `Resolved runner "${runner}" for ${featureId}${ticketId ? `/${ticketId}` : ''} is not usable: ${avail.reason}`,
      });
      log(`runner unavailable for ${runId}: ${avail.reason}`);
      return { runId, pid: null, blocked: true };
    }

    const surface = resolveExecutionSurface({ runner });
    const mode = surface === 'host-handoff' ? 'chat' : 'cli';
    const args = [
      ENGINE,
      '--run-id', runId,
      '--mode', mode,
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
      worktree: runPaths.worktree ? path.relative(repoRoot, runPaths.worktree) : null,
      brief: brief ? path.relative(repoRoot, brief) : null,
      executionSurface: surface,
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
      try { fs.closeSync(out); } catch { /* already closed */ }
      if (result.error || (result.status !== 0 && result.status != null)) {
        const detail = result.error?.message || `host orchestrator exited ${result.status}`;
        persistRunRecord(runPaths, {
          ...metaBase, pid: null, phase: 'failed',
          haltReason: 'AGENT_ERROR', haltDetail: detail,
        });
        appendRunVerb(runPaths, 'failed', detail);
        log(`host spawn error for ${runId}: ${detail}`);
        return { runId, pid: null, blocked: true };
      }
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
    persistRunRecord(runPaths, { ...metaBase, pid: child.pid ?? null, phase: 'spawned' });
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

  function availableSlots() { return Math.max(0, poolCfg.maxParallel - pool.activeRuns(pool.listRunStates(paths,poolCfg,now())).length); }

  function startFeature(rm, feature) {
    if (!availableSlots()) return;
    if (feature.specRunId) {
      let existing = null;
      try { existing = JSON.parse(fs.readFileSync(pipelinePaths(repoRoot, { runId: feature.specRunId }).status, 'utf8')); } catch { /* gone */ }
      if (existing && !['done', 'halted'].includes(existing.overall)) return;
    }
    const baseRef = feature.baseRef || currentSha(repoRoot, targetRef(rm));
    const runId = newRunId({ featureId: feature.id, kind: 'plan' });
    const brief = writeBrief({
      runId, title: feature.title, featureId: feature.id, ticketId: null,
      mode: feature.mode, base: baseRef, branch: feature.branch,
      body: planBriefBody(rm, feature),
    });
    const wantPlanApproval = poolCfg.featurePlanApproval && rm.review !== 'end';
    const spawned = spawnWorker({
      runId, featureId: feature.id, ticketId: null, kind: 'plan',
      brief, branch: `pipeline/work/${feature.id}/plan-${runId}`, baseRef,
      runner: resolvePoolRunner(pickRunner(feature.runner, poolCfg.defaultRunner)),
      extra: ['--plan-only', ...(wantPlanApproval ? ['--approve-plan'] : [])],
    });
    if (spawned.blocked) {
      saveRoadmap(setFeatureStatus(rm, feature.id, 'failed', {
        baseRef, specRunId: runId, startedAt: new Date(now()).toISOString(),
      }));
      return;
    }
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
    const done = recorded.filter((t) => t.status === 'committed' || t.status === 'dropped').map((t) => t.id);
    const running = recorded.filter((t) => t.status === 'running').map((t) => t.id);
    const runningFiles = Object.fromEntries(recorded
      .filter((t) => t.status === 'running' && t.runId)
      .map((t) => [t.runId, tickets.find((x) => x.id === t.id)?.files || []]));

    const wave = scheduleTickets(tickets, {
      done, running,
      maxParallel: Math.min(feature.maxParallel || poolCfg.maxParallel, running.length + availableSlots()),
      runningFiles,
      serializeOnFileOverlap: poolCfg.serializeOnFileOverlap,
    });

    const updated = [...recorded];
    for (const ticket of wave) {
      const foreign = pool.activeRuns(pool.listRunStates(paths,poolCfg,now())).filter(r => r.featureId !== feature.id && r.kind === 'ticket');
      if (poolCfg.serializeOnFileOverlap && foreign.some(r => !ticket.files.length || !r.meta?.files?.length || ticket.files.some(f => r.meta.files.some(b => f === b || f.startsWith(b + '/') || b.startsWith(f + '/'))))) continue;
      const runId = newRunId({ featureId: feature.id, ticketId: ticket.id, kind: 'ticket' });
      const sliceFile = path.join(paths.briefs, `${runId}.specs.md`);
      fs.mkdirSync(paths.briefs, { recursive: true });
      fs.writeFileSync(sliceFile, tickets.length > 1 && ticket.block ? sliceSpecForTicket(specs, ticket.id) : specs);
      const brief = writeBrief({
        runId, title: ticket.title, featureId: feature.id, ticketId: ticket.id,
        mode: feature.mode, base: feature.baseRef, branch: `pipeline/work/${feature.id}/${runId}`,
        body: ticket.body || feature.description,
      });
      const dependencyRows = ticket.dependsOn.map(id => recorded.find(t => t.id === id));
      const inputShas = dependencyRows.map(t => t?.runId && readRunMeta(pipelinePaths(repoRoot,{runId:t.runId}))?.committedSha);
      if (inputShas.some(sha => !sha)) { escalate(feature,null,'dependency-missing',`Prerequisite commit missing for ${ticket.id}`); continue; }
      let ticketBase = feature.baseRef;
      if (inputShas.length) {
        const target = pipelinePaths(repoRoot,{runId});
        createRunWorktree({repoRoot,runDir:target.dir,worktreePath:target.worktree,branch:`pipeline/work/${feature.id}/${runId}`,baseRef:ticketBase});
        for (const sha of inputShas) {
          const merged = tryMerge(target.worktree,sha);
          if (!merged.ok) { escalate(feature,{runId},'dependency-conflict',`Cannot combine prerequisites for ${ticket.id}`); return; }
        }
        ticketBase = currentSha(target.worktree);
      }
      const runPaths = pipelinePaths(repoRoot,{runId});
      fs.mkdirSync(runPaths.dir, {recursive:true});
      writeRunMeta(runPaths,{files:ticket.files,inputShas});
      const spawned = spawnWorker({
        runId, featureId: feature.id, ticketId: ticket.id, kind: 'ticket',
        brief, branch: `pipeline/work/${feature.id}/${runId}`, baseRef: ticketBase,
        runner: resolvePoolRunner(pickRunner(ticket.runner, feature.runner, poolCfg.defaultRunner)),
        extra: [
          '--specs-file', sliceFile,
          ...(poolCfg.ticketFlags.reviewPanel ? ['--review-panel'] : []),
        ],
      });
      const row = updated.find((t) => t.id === ticket.id);
      const ticketStatus = spawned.blocked ? 'failed' : 'running';
      if (row) { row.runId = runId; row.status = ticketStatus; }
      else { updated.push({ id: ticket.id, title: ticket.title, runId, status: ticketStatus }); }
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
    if (!availableSlots()) return;
    const validatedTarget = currentSha(repoRoot, targetRef(rm));
    const runId = newRunId({ featureId: feature.id, kind: 'integration' });
    const runPaths = pipelinePaths(repoRoot, { runId });
    fs.mkdirSync(runPaths.dir, { recursive: true });

    const branchTaken = gitIn(repoRoot,['show-ref','--verify','--quiet',`refs/heads/${feature.branch}`]).status === 0;
    if (branchTaken) feature = {...feature,branch:`${feature.branch}-retry-${runId.slice(-8)}`};
    saveRoadmap(setFeatureStatus(roadmap(),feature.id,'integrating',{branch:feature.branch,validatedTarget}));
    // The feature branch starts where the feature started, then each ticket
    // branch is merged onto it in ticket order.
    createRunWorktree({
      repoRoot, runDir: runPaths.dir, worktreePath: runPaths.worktree,
      branch: feature.branch, baseRef: validatedTarget,
    });

    for (const ticket of feature.tickets || []) {
      if (!ticket.runId || ticket.status === 'dropped') continue;
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
      ],
    });
    saveRoadmap(setFeatureStatus(roadmap(), feature.id, 'reviewing', { integrationRunId: runId }));
  }

  function tryMerge(worktree, branch) {
    const res = nodeSpawnSync('git', [
      '-c', 'user.name=Orchestrator',
      '-c', 'user.email=orchestrator@local',
      'merge', '--no-ff', '--no-edit', branch,
    ], { cwd: worktree, encoding: 'utf8' });
    if (res.status === 0) return { ok: true, files: [] };
    const conflicted = nodeSpawnSync('git', ['diff', '--name-only', '--diff-filter=U'], { cwd: worktree, encoding: 'utf8' });
    nodeSpawnSync('git', ['merge', '--abort'], { cwd: worktree, encoding: 'utf8' });
    return { ok: false, files: (conflicted.stdout || '').trim().split('\n').filter(Boolean), error: (res.stderr || '').trim() };
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

  function acceptOntoWorkingBranch(sha, expected) {
    const rm = roadmap();
    const branch = rm.workingBranch;
    // The working branch doesn't exist until the first feature is accepted onto
    // it; git's compare-and-swap needs the all-zero SHA as "oldvalue" to assert
    // that, rather than the base commit `expected` was actually computed from.
    const oldval = branchExists(repoRoot, branch) ? expected : '0'.repeat(40);
    const updated = gitIn(repoRoot, ['update-ref', `refs/heads/${branch}`, sha, oldval]);
    if (updated.status !== 0) throw new Error('Roadmap target moved before acceptance.');
    saveRoadmap({ ...roadmap(), workingBranch: branch, workingSha: sha });
    return sha;
  }

  function planBriefBody(rm, feature) {
    const ctx = featureBriefContext(rm, feature);
    return [
      `This feature is ${feature.id}: ${feature.title}. It is one slice of the roadmap "${ctx.roadmapTitle}". Implement only this feature; do not start the others.`,
      '',
      feature.description,
      '',
      feature.acceptance?.length ? `Acceptance criteria:\n${feature.acceptance.map((a) => `- ${a}`).join('\n')}` : '',
      ctx.dependsOn.length ? `Depends on:\n${ctx.dependsOn.map((d) => `- ${d}`).join('\n')}` : '',
      ctx.landed.length ? `Already accepted:\n${ctx.landed.map((d) => `- ${d}`).join('\n')}` : '',
      ctx.remaining.length ? `Still queued after this:\n${ctx.remaining.map((d) => `- ${d}`).join('\n')}` : '',
    ].filter(Boolean).join('\n');
  }

  function landFeature(rm, feature, run) {
    const runPaths = pipelinePaths(repoRoot, { runId: run.runId });
    const state = feature.mergeState || 'reviewing';

    if (state === 'reviewing') {
      const res = commitRunWork({
        worktreePath: runPaths.worktree,
        message: `feat(${feature.id}): ${feature.title}\n\n${(feature.acceptance || []).join('\n')}\nRun: ${run.runId}`,
      });
      const sha = res.sha ?? currentSha(runPaths.worktree);
      if (roadmap().review === 'end') {
        if (currentSha(repoRoot,targetRef(roadmap())) !== feature.validatedTarget) {
          integrateFeature(roadmap(),feature); return;
        }
        acceptOntoWorkingBranch(sha,feature.validatedTarget);
        finishLanding(feature, sha, { deferred: true });
        return;
      }
      const next = mergeTransition('reviewing', 'approved');
      saveRoadmap(setFeatureStatus(roadmap(), feature.id, 'awaiting_merge_approval', {
        mergeState: mergeCfg.mode === 'pr' ? next : mergeTransition(next, 'local_ready'),
        committedSha: sha,
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
    const target = currentSha(repoRoot,rm.base);
    if (feature.validatedTarget && (target !== feature.validatedTarget || (feature.mergeApproval?.head && currentSha(repoRoot,feature.branch) !== feature.mergeApproval.head))) {
      escalate(feature,{runId:feature.integrationRunId},'approval-stale','Target or candidate changed; integration and approval must be repeated.');
      integrateFeature(rm,{...feature,mergeApproval:null}); return;
    }
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

    if (gitIn(repoRoot,['branch','--show-current']).stdout.trim() !== rm.base) { escalate(feature,{runId:feature.integrationRunId},'wrong-branch',`Check out ${rm.base} before local landing.`); return; }
    // local-only: merge the feature branch into the base in this repository.
    const merged = gitIn(repoRoot, ['merge', '--no-ff', '--no-edit', feature.branch]);
    if (merged.status !== 0) {
      escalate(feature, { runId: feature.integrationRunId }, 'merge_failed', `Local merge of ${feature.branch} failed: ${merged.stderr.trim()}`);
      saveRoadmap(setFeatureStatus(roadmap(), feature.id, 'awaiting_merge_approval', { mergeState: 'merge_failed' }));
      return;
    }
    finishLanding(feature, currentSha(repoRoot));
  }

  // A stale approval must lead to new evidence, never another approval of the
  // same stale pair of commits. Keep every attempt in its own worktree.
  function revalidateRoadmap(rm) {
    const previous = rm.finalValidation;
    if (previous?.state === 'running') {
      const run = pool.listRunStates(paths, poolCfg, now()).find(r => r.runId === previous.runId);
      if (!run || run.status?.overall !== 'done' || run.status?.verdict !== 'APPROVED') return;
      const p = pipelinePaths(repoRoot, { runId: previous.runId });
      try {
        if (currentSha(repoRoot, rm.base) !== previous.target || currentSha(repoRoot, rm.workingBranch) !== previous.inputHead) {
          saveRoadmap(setRoadmapStatus(rm, 'running', { finalValidation: { ...previous, state: 'superseded' }, mergeState: 'target-moved' }));
          return;
        }
        const committed = commitRunWork({ worktreePath: p.worktree, message: `Validate combined roadmap: ${rm.title}` });
        const sha = committed.sha || currentSha(p.worktree);
        const updated = gitIn(repoRoot, ['update-ref', `refs/heads/${rm.workingBranch}`, sha, previous.inputHead]);
        if (updated.status !== 0) throw new Error('Working branch moved during validation acceptance.');
        saveRoadmap(setRoadmapStatus(roadmap(), 'running', {
          workingSha: sha, validatedTarget: previous.target, mergeApproval: null, mergeState: null,
          finalValidation: { ...previous, state: 'approved', sha },
        }));
        maybeEnterFinalReview(roadmap());
      } catch (error) {
        escalate(null, { runId: previous.runId }, 'validation-blocked', error.message);
      }
      return;
    }
    if (!availableSlots()) return;
    const runId = newRunId({ featureId: 'roadmap', kind: 'integration' });
    const p = pipelinePaths(repoRoot, { runId });
    const target = currentSha(repoRoot, rm.base), inputHead = currentSha(repoRoot, rm.workingBranch);
    const branch = `pipeline/roadmap-validation/${runId}`;
    const validation = { runId, target, inputHead, state: 'running' };
    saveRoadmap(setRoadmapStatus(rm, 'running', { mergeApproval: null, mergeState: 'revalidating', finalValidation: validation }));
    try {
      createRunWorktree({ repoRoot, runDir: p.dir, worktreePath: p.worktree, branch, baseRef: target });
      const merged = tryMerge(p.worktree, inputHead);
      if (!merged.ok) {
        if (!merged.files.length && merged.error) throw new Error(`Combined roadmap merge failed: ${merged.error}`);
        throw new Error(`Combined roadmap conflicts with target: ${merged.files.join(', ')}`);
      }
      const specs = path.join(p.dir, 'combined-specs.md');
      const parts = rm.features.filter(f => f.status !== 'skipped').map(f => {
        if (!f.specRunId) throw new Error(`Missing specification run for ${f.id}.`);
        return fs.readFileSync(pipelinePaths(repoRoot, { runId: f.specRunId }).specs, 'utf8');
      });
      fs.writeFileSync(specs, parts.join('\n\n---\n\n'));
      const brief = writeBrief({ runId, title: `Revalidate ${rm.title}`, featureId: 'roadmap', mode: 'integration', base: target, branch,
        body: `Test and review the entire combined roadmap against target ${target}. Candidate input: ${inputHead}. Retain all accepted features. Human landing approval is still required.` });
      spawnWorker({ runId, featureId: 'roadmap', kind: 'integration', brief, branch: null, baseRef: target,
        runner: resolvePoolRunner(pickRunner(poolCfg.defaultRunner)),
        extra: ['--worktree', path.relative(repoRoot, p.worktree), '--specs-file', specs, '--start-at', 'tester'],
      });
    } catch (error) {
      persistRunRecord(p, { runId, featureId: 'roadmap', kind: 'integration', runner: 'host', branch, baseRef: target,
        haltReason: 'INTEGRITY_ERROR', haltDetail: error.message, phase: 'failed' });
      escalate(null, { runId }, 'validation-blocked', error.message);
    }
  }

  function performRoadmapMerge(rm) {
    if (rm.validatedTarget && (currentSha(repoRoot,rm.base) !== rm.validatedTarget || rm.mergeApproval?.head !== currentSha(repoRoot,rm.workingBranch))) {
      saveRoadmap(setRoadmapStatus(rm,'running',{mergeApproval:null,mergeState:'target-moved',finalValidation:null}));
      escalate(null,null,'approval-stale','Roadmap target moved. Revalidating the combined working branch before a new approval.');
      revalidateRoadmap(roadmap()); return;
    }
    const branch = rm.workingBranch;
    const fakeFeature = { id: 'roadmap', title: rm.title, integrationRunId: null, branch };
    if (mergeCfg.mode === 'pr') {
      const pushed = gitIn(repoRoot, ['push', '-u', mergeCfg.remote, branch]);
      if (pushed.status !== 0) {
        escalate(fakeFeature, null, 'push_failed', `Could not push ${branch}: ${pushed.stderr.trim()}`);
        saveRoadmap(setRoadmapStatus(roadmap(), 'awaiting_final_review', { mergeState: 'push_failed' }));
        return;
      }
      const remoteUrl = gitIn(repoRoot, ['remote', 'get-url', mergeCfg.remote]).stdout.trim();
      const provider = detectForge(remoteUrl) || 'github';
      const bodyFile = path.join(paths.control, 'roadmap_pr_body.md');
      fs.mkdirSync(paths.control, { recursive: true });
      fs.writeFileSync(bodyFile, `# ${rm.title}\n\nLand the working branch \`${branch}\` onto \`${rm.base}\`.\n`);
      const pr = openPullRequest({
        cwd: repoRoot, provider, base: rm.base, head: branch,
        title: `${rm.title}: land roadmap`, bodyFile,
      });
      if (!pr.ok) {
        escalate(fakeFeature, null, 'pr_failed', `Could not open a pull request: ${pr.error}`);
        saveRoadmap(setRoadmapStatus(roadmap(), 'awaiting_final_review', { mergeState: 'pr_failed', pr }));
        return;
      }
      const check = checkMergeable({
        cwd: repoRoot, provider: pr.provider || 'github', url: pr.url,
        expectedHead: pr.head, requireMergeable: mergeCfg.requireMergeable,
      });
      if (!check.ok) {
        escalate(fakeFeature, null, 'not_mergeable', `Not merging roadmap: ${check.reason}`);
        saveRoadmap(setRoadmapStatus(roadmap(), 'awaiting_final_review', {
          mergeState: 'not_mergeable',
          pr: { provider: pr.provider ?? null, url: pr.url ?? null, number: pr.number ?? null, head: pr.head ?? null },
        }));
        return;
      }
      const merged = mergePullRequest({
        cwd: repoRoot, provider: pr.provider || 'github', url: pr.url, method: mergeCfg.mergeMethod,
      });
      if (!merged.ok) {
        escalate(fakeFeature, null, 'merge_failed', `Roadmap merge did not land: ${merged.reason}`);
        saveRoadmap(setRoadmapStatus(roadmap(), 'awaiting_final_review', { mergeState: 'merge_failed' }));
        return;
      }
      gitIn(repoRoot, ['fetch', mergeCfg.remote, rm.base]);
      saveRoadmap(setRoadmapStatus(roadmap(), 'landed', {
        landedSha: currentSha(repoRoot, `${mergeCfg.remote}/${rm.base}`),
        landedAt: new Date(now()).toISOString(),
        pr: { provider: pr.provider ?? null, url: pr.url ?? null, number: pr.number ?? null, head: pr.head ?? null },
      }));
      log(`landed roadmap onto ${rm.base}`);
      return;
    }

    if (gitIn(repoRoot,['branch','--show-current']).stdout.trim() !== rm.base) { escalate(fakeFeature,null,'wrong-branch',`Check out ${rm.base} before local landing.`); return; }
    const merged = gitIn(repoRoot, ['merge', '--no-ff', '--no-edit', branch]);
    if (merged.status !== 0) {
      escalate(fakeFeature, null, 'merge_failed', `Local merge of ${branch} failed: ${merged.stderr.trim()}`);
      saveRoadmap(setRoadmapStatus(roadmap(), 'awaiting_final_review', { mergeState: 'merge_failed' }));
      return;
    }
    saveRoadmap(setRoadmapStatus(roadmap(), 'landed', {
      landedSha: currentSha(repoRoot),
      landedAt: new Date(now()).toISOString(),
    }));
    appendAttention(paths, {
      kind: 'landed', escalate: false,
      summary: `Roadmap "${rm.title}" landed onto ${rm.base}`,
    });
    log(`landed roadmap onto ${rm.base}`);
  }

  function maybeEnterFinalReview(rm) {
    if (rm.review !== 'end') return;
    if (['awaiting_final_review', 'merge_approved', 'landed'].includes(rm.roadmapStatus)) return;
    const features = rm.features || [];
    if (!features.length) return;
    if (features.some((f) => !['accepted', 'landed', 'skipped'].includes(f.status))) return;
    if (openDecisions(paths).some((d) => d.kind === 'roadmap-merge')) {
      saveRoadmap(setRoadmapStatus(rm, 'awaiting_final_review', {}));
      return;
    }
    const decision = openDecision(paths, {
      runId: null, featureId: null, kind: 'roadmap-merge', stage: 'reviewer',
      question: `All features of "${rm.title}" are tested and accepted onto ${rm.workingBranch}. Land them into ${rm.base}?`,
      options: ['approve', 'request-changes'],
      recommended: 'approve',
      artifacts: [rm.workingBranch, rm.base].filter(Boolean),
    });
    appendAttention(paths, {
      kind: 'roadmap-merge', decisionId: decision.id, escalate: true,
      summary: `Roadmap "${rm.title}" is ready for a final review — land with \`pool approve-merge\` or \`pool land-roadmap\`.`,
    });
    saveRoadmap(setRoadmapStatus(roadmap(), 'awaiting_final_review', {validatedTarget:rm.finalValidation?.state === 'approved' ? rm.finalValidation.target : currentSha(repoRoot,rm.base)}));
  }

  function finishLanding(feature, landedSha, { deferred = false } = {}) {
    const runPaths = feature.integrationRunId ? pipelinePaths(repoRoot, { runId: feature.integrationRunId }) : null;
    if (runPaths) appendRunVerb(runPaths, 'landed', landedSha?.slice(0, 8) || '');
    let rm = setFeatureStatus(roadmap(), feature.id, deferred ? 'accepted' : 'landed', {
      mergeState: deferred ? 'accepted' : 'landed',
      acceptedSha: deferred ? landedSha : null,
      deliveryBranch: deferred ? roadmap().workingBranch : roadmap().base,
      landedSha,
      landedAt: new Date(now()).toISOString(),
      reportRel: runPaths && fs.existsSync(path.join(runPaths.reports, 'work-done.html'))
        ? path.relative(repoRoot, path.join(runPaths.reports, 'work-done.html'))
        : null,
    });
    saveRoadmap(rm);
    const branch = rm.workingBranch;
    appendAttention(paths, {
      featureId: feature.id, kind: 'landed', escalate: false,
      summary: deferred
        ? `${feature.id} (${feature.title}) accepted onto ${branch}`
        : `${feature.id} (${feature.title}) landed`,
    });
    if (mergeCfg.cleanupOnMerge) cleanupFeature(feature);
    log(`${deferred ? 'accepted' : 'landed'} ${feature.id} at ${landedSha}`);
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
    raiseAttention({ runId: run?.runId ?? null, featureId: feature?.id ?? null, kind, summary, escalate: true });
    log(`escalated ${kind}: ${summary}`);
  }

  // ---- one pass ------------------------------------------------------------

  function tick() {
    const rm = roadmap();
    if (!rm) return { ok: false, reason: 'no compiled roadmap' };

    const runs = pool.listRunStates(paths, poolCfg, now());
    const paused = fs.existsSync(paths.paused);
    resumingThisTick = new Set();

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
        if (event.escalate && !alreadyPending(run.runId, event.kind, event.handoffId)) {
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
      seen.set(run.runId, { state: run.state, verb: run.verb, handoffId: run.status?.handoffId, stage: run.status?.awaitingStage });
    }

    // 2. Honour resume/extend requests, then auto-resume recoverable halts.
    if (!paused) {
      for (const run of runs) {
        const requests = run.meta?.requests;
        if (!requests) continue;
        if (requests.extend && run.status?.overall === 'halted') {
          respawn(run, ['--resume', '--extend', String(requests.extend.cycles)]);
          resumingThisTick.add(run.runId);
          clearRequests(run);
        } else if (requests.resume && ['halted', 'awaiting_plan_approval'].includes(run.status?.overall)) {
          // Deliberately excludes 'awaiting_chat': that state is only ever
          // advanced by a human's own --continue after claiming the run (see
          // `pool claim`), never by the supervisor respawning it — and
          // orchestrator.mjs's own --resume guard does not accept that state
          // anyway.
          respawn(run, run.status.overall === 'awaiting_plan_approval' ? ['--continue'] : ['--resume']);
          resumingThisTick.add(run.runId);
          clearRequests(run);
        }
      }
      for (const run of runs) {
        if (resumingThisTick.has(run.runId)) continue;
        if (!resumableHalt(run)) continue;
        const reason = run.status.haltReason;
        const extra = reason === 'MAX_CYCLES'
          ? ['--resume', '--extend', String(config.maxCoderCycles ?? 5)]
          : ['--resume'];
        recordAutoResume(run, reason);
        respawn(run, extra);
        resumingThisTick.add(run.runId);
        log(`auto-resumed ${run.runId} (${reason})`);
      }
    }

    // 3. Advance the feature currently in flight.
    if (!paused) advanceFeatures();

    // 4. Publish state for the dashboard and the coordinator.
    const snap = pool.snapshot(paths, { config, now: new Date(now()) });
    pool.writeSnapshot(paths, snap);
    pool.writePrimaryMirror(paths, { snap, runs, config });
    touchHeartbeat();
    return { ok: true, snapshot: snap, runs };
  }

  function advanceFeatures() {
    let rm = roadmap();
    if (rm.roadmapStatus === 'merge_approved') { performRoadmapMerge(rm); return; }
    if (rm.finalValidation?.state === 'running' || rm.mergeState === 'target-moved') { revalidateRoadmap(rm); return; }
    if (['awaiting_final_review','landed'].includes(rm.roadmapStatus)) return;
    const active = rm.features.filter(f => !['queued','accepted','landed','skipped','held','failed'].includes(f.status));
    const ordered = active.slice(schedulingOffset % Math.max(1,active.length)).concat(active.slice(0,schedulingOffset % Math.max(1,active.length)));
    schedulingOffset++;
    for (const feature of ordered) advanceFeature({...roadmap(),currentFeatureId:feature.id},pool.listRunStates(paths,poolCfg,now()));
    rm = roadmap();
    let slots = poolCfg.maxActiveFeatures - rm.features.filter(f => !['queued','accepted','landed','skipped','held','failed'].includes(f.status)).length;
    for (const feature of rm.features) {
      if (slots <= 0 || !availableSlots()) break;
      if (feature.status !== 'queued' || !(feature.dependsOn || []).every(id => ['accepted','landed','skipped'].includes(roadmap().features.find(f=>f.id===id)?.status))) continue;
      startFeature(roadmap(),feature); slots--;
    }
    maybeEnterFinalReview(roadmap());
  }

  function advanceFeature(rm, runs) {
    if (rm.roadmapStatus === 'merge_approved') {
      performRoadmapMerge(rm);
      return;
    }
    if (rm.roadmapStatus === 'awaiting_final_review' || rm.roadmapStatus === 'landed') return;

    const current = rm.features.find((f) => f.id === rm.currentFeatureId)
      ?? rm.features.find((f) => !['accepted', 'landed', 'skipped', 'failed', 'held', 'queued'].includes(f.status));

    if (!current) {
      const upcoming = nextFeature(rm);
      if (upcoming) startFeature(rm, upcoming);
      else maybeEnterFinalReview(rm);
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
        else if (planRun?.status?.overall === 'halted' && !isRetrying(planRun)) {
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
            const committed = commitTicket(current, ticket, run);
            ticket.status = committed.ok ? 'committed' : 'failed';
            if (!committed.ok) escalate(current, run, 'commit-failed', committed.reason);
            changed = true;
          } else if (run.status?.overall === 'halted' && !isRetrying(run)) {
            ticket.status = 'failed';
            changed = true;
            escalate(current, run, 'halted', `${current.id}/${ticket.id} halted: ${run.status.haltReason}`);
          }
        }
        if (changed) saveRoadmap(setFeatureStatus(roadmap(), current.id, 'executing', { tickets }));
        const after = roadmap().features.find((f) => f.id === current.id);
        const all = after.tickets || [];
        const live = all.filter((t) => t.status !== 'dropped');
        if (live.length && live.every((t) => t.status === 'committed')) {
          integrateFeature(roadmap(), after);
        } else if (live.some((t) => t.status === 'failed')) {
          saveRoadmap(setFeatureStatus(roadmap(), current.id, 'failed', {}));
        } else {
          startTickets(roadmap(), after, runs);
        }
        return;
      }
      case 'integrating': {
        resolveIntegrationConflict(current, runs);
        return;
      }
      case 'reviewing': {
        const run = byRun(current.integrationRunId);
        if (!run) return;
        if (run.status?.overall === 'done' && run.status?.verdict === 'APPROVED') {
          landFeature(rm, current, run);
        } else if (run.status?.overall === 'halted' && isRetrying(run)) {
          return;
        } else if (run.status?.overall === 'halted' || (run.status?.overall === 'done' && run.status?.verdict !== 'APPROVED')) {
          escalate(current, run, 'review-failed', `${current.id} was not approved: ${run.status.verdict || run.status.haltReason}`);
          saveRoadmap(setFeatureStatus(rm, current.id, 'failed', {}));
        }
        return;
      }
      case 'awaiting_merge_approval': {
        const run = byRun(current.integrationRunId) || { runId: current.integrationRunId, status: null };
        landFeature(rm, current, run);
        return;
      }
      case 'merge_approved':
        performMerge(rm, current);
        return;
      default:
    }
  }

  function resolveIntegrationConflict(feature, runs) {
    const open = openDecisions(paths).find((d) => d.featureId === feature.id && d.kind === 'merge-conflict' && d.status === 'open');
    if (open) return;
    const resolved = readDecisions(paths)
      .filter((d) => d.featureId === feature.id && d.kind === 'merge-conflict' && d.status === 'resolved')
      .sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')))[0];
    if (!resolved) return;
    const answer = String(resolved.decision || '').toLowerCase();
    const ticketId = feature.conflict?.ticketId;
    if (answer.startsWith('rerun-ticket')) {
      const tickets = (feature.tickets || []).map((t) => (t.id === ticketId ? { ...t, status: 'queued', runId: null } : t));
      saveRoadmap(setFeatureStatus(roadmap(), feature.id, 'executing', { tickets, conflict: null, integrationRunId: null }));
      const after = roadmap().features.find((f) => f.id === feature.id);
      startTickets(roadmap(), after, runs);
      return;
    }
    if (answer.startsWith('drop-ticket')) {
      const tickets = (feature.tickets || []).map((t) => (t.id === ticketId ? { ...t, status: 'dropped' } : t));
      saveRoadmap(setFeatureStatus(roadmap(), feature.id, 'executing', { tickets, conflict: null }));
      const after = roadmap().features.find((f) => f.id === feature.id);
      const live = (after.tickets || []).filter((t) => t.status !== 'dropped');
      if (live.length && live.every((t) => t.status === 'committed')) integrateFeature(roadmap(), after);
      else startTickets(roadmap(), after, runs);
      return;
    }
    if (answer.startsWith('resolve-manually')) {
      saveRoadmap(setFeatureStatus(roadmap(), feature.id, 'executing', { conflict: null }));
      integrateFeature(roadmap(), { ...feature, conflict: null });
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

  function resumableHalt(run) {
    if (run.status?.overall !== 'halted') return false;
    const reason = run.status.haltReason;
    if (Number(run.meta?.autoResumes || 0) >= poolCfg.autoResumeMax) return false;
    if (reason === 'MAX_CYCLES') {
      if (Number(run.meta?.autoCycleExtends || 0) >= 1) return false;
      return true;
    }
    return reason === 'AGENT_ERROR' && run.status.haltTransient === true;
  }

  function isRetrying(run) {
    if (!run) return false;
    if (resumingThisTick.has(run.runId)) return true;
    if (run.meta?.requests?.extend || run.meta?.requests?.resume) return true;
    return resumableHalt(run);
  }

  function recordAutoResume(run, reason) {
    const runPaths = pipelinePaths(repoRoot, { runId: run.runId });
    const meta = readRunMeta(runPaths) || {};
    const next = {
      ...meta,
      autoResumes: Number(meta.autoResumes || 0) + 1,
      ...(reason === 'MAX_CYCLES' ? { autoCycleExtends: Number(meta.autoCycleExtends || 0) + 1 } : {}),
    };
    if (runPaths.runMeta) atomicWrite(runPaths.runMeta, JSON.stringify(next, null, 2));
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
  const res = nodeSpawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function readIfExists(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}
