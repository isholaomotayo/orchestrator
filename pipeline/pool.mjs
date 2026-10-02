// The pool: reading and steering a roadmap run.
//
// Every operator action is a verb here, and every verb is deterministic. The
// coordinator agent decides WHAT to recommend and how to explain it; this file
// decides what is actually pending, what may be approved, and what happens
// next. Keeping that boundary is what makes the agent's judgment auditable —
// it can be wrong about a recommendation, but it cannot be wrong about state.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { readUsage } from './usage.mjs';
import { inspectBridge, bridgeCommand, readBridge } from './bridge.mjs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  pipelinePaths, loadConfig, atomicWrite, pidAlive, readLock, withFileLock,
  newStatus, ensureStageEntries, appendLine, appendEvent,
} from './state.mjs';
import { readRunMeta, readStatusLog, latestVerb, isValidRunId, appendRunVerb } from './run-registry.mjs';
import {
  parseRoadmapMd, compileRoadmap, setFeatureStatus, setRoadmapStatus, nextFeature, FEATURE_STATUSES,
} from './roadmap.mjs';
import { isHostSurface, resolveExecutionSurface } from './adapters.mjs';
import { classifyRun, DEFAULT_THRESHOLDS,
  appendAttention, pendingAttention, ackAttention,
  openDecisions, resolveDecision, readDecisions,
} from './attention.mjs';
import { buildSnapshot, renderDigest } from './snapshot.mjs';
import { queueStageNote } from './events.mjs';
import { recoveryFor, haltedArtifactCheck } from './recoverability.mjs';
import { writePolicyOverride } from './mode.mjs';
import { recordIntervention } from './interventions.mjs';

export function poolConfig(config) {
  const raw = config.pool || {};
  return {
    maxParallel: raw.maxParallel ?? 3,
    maxActiveFeatures: raw.maxActiveFeatures ?? 2,
    pollMs: raw.pollMs ?? 2000,
    heartbeatMs: raw.heartbeatMs ?? 300_000,
    staleAfterMs: raw.staleAfterMs ?? DEFAULT_THRESHOLDS.staleAfterMs,
    staleEscalateMs: raw.staleEscalateMs ?? DEFAULT_THRESHOLDS.staleEscalateMs,
    pauseResurfaceMs: raw.pauseResurfaceMs ?? DEFAULT_THRESHOLDS.pauseResurfaceMs,
    parkedEscalateMs: raw.parkedEscalateMs ?? DEFAULT_THRESHOLDS.parkedEscalateMs,
    autoResumeMax: raw.autoResumeMax ?? 2,
    serializeOnFileOverlap: raw.serializeOnFileOverlap !== false,
    featurePlanApproval: raw.featurePlanApproval === true,
    // An attended chat owns stages by default. A named runner in the pool or
    // top-level config is an explicit opt-in to unattended CLI execution.
    defaultRunner: raw.defaultRunner ?? (config.runner && config.runner !== 'auto' ? config.runner : 'host'),
    ticketFlags: raw.ticketFlags || {},
    integrationFlags: raw.integrationFlags || { reviewPanel: true },
    // Pool-wide limit for active host runs, including plans, tickets,
    // integration and approval gates. The attending chat is sequential.
    hostConcurrency: raw.hostConcurrency ?? 1,
  };
}

export function mergeConfig(config) {
  const raw = config.merge || {};
  return {
    mode: raw.mode || 'pr',
    remote: raw.remote || 'origin',
    mergeMethod: raw.mergeMethod || 'squash',
    requireMergeable: raw.requireMergeable !== false,
    autoMerge: !!raw.autoMerge,
    cleanupOnMerge: raw.cleanupOnMerge !== false,
  };
}

// ---- roadmap ---------------------------------------------------------------

export function readRoadmap(paths) {
  try { return JSON.parse(fs.readFileSync(paths.roadmapJson, 'utf8')); } catch { return null; }
}

export function writeRoadmap(paths, roadmap) {
  fs.mkdirSync(paths.control, { recursive: true });
  atomicWrite(paths.roadmapJson, JSON.stringify(roadmap, null, 2));
  return roadmap;
}

/**
 * Compile `.pipeline/roadmap.md` into control state, preserving progress.
 * Returns errors rather than throwing so a CLI can print them with line numbers.
 */
function compileUnlocked(paths, { now = new Date() } = {}) {
  let source;
  try { source = fs.readFileSync(paths.roadmapMd, 'utf8'); }
  catch { return { ok: false, errors: [{ line: 0, message: `No roadmap at ${path.relative(paths.root, paths.roadmapMd)}. Write one, or run "roadmap plan".` }] }; }

  const { roadmap, errors } = parseRoadmapMd(source);
  if (errors.length) return { ok: false, errors };
  const baseCheck = checkRoadmapBase(paths, roadmap);
  if (baseCheck.errors.length) return { ok: false, errors: baseCheck.errors };

  const sourceSha256 = crypto.createHash('sha256').update(source).digest('hex');
  const compiled = compileRoadmap(roadmap, readRoadmap(paths), { sourceSha256, now });
  writeRoadmap(paths, compiled);
  return { ok: true, roadmap: compiled, errors: [], warnings: baseCheck.warnings };
}

// A base branch that does not exist used to surface only at landing time, as
// a supervisor tick that failed on every poll (petra: 27 times). Check it when
// the roadmap is compiled, where the fix is one push away.
function checkRoadmapBase(paths, roadmap) {
  const errors = [], warnings = [];
  const git = (args) => spawnSync('git', args, { cwd: paths.root, encoding: 'utf8', timeout: 15_000 });
  if (git(['rev-parse', '--is-inside-work-tree']).status !== 0) return { errors, warnings };
  const base = roadmap.base;
  if (git(['rev-parse', '--verify', '--quiet', `${base}^{commit}`]).status !== 0) {
    errors.push({ line: 0, message: `Base branch "${base}" does not exist in this repository. Create it, or set "base:" in the roadmap front matter.` });
  }
  if (roadmap.merge && roadmap.merge !== 'local-only') {
    const remote = mergeConfig(loadConfig(paths)).remote;
    const res = git(['ls-remote', '--exit-code', '--heads', remote, base]);
    if (res.status === 2) {
      errors.push({ line: 0, message: `Base branch "${base}" is not on remote "${remote}", so merge: ${roadmap.merge} cannot land. Push it first: git push -u ${remote} ${base}` });
    } else if (res.status !== 0) {
      warnings.push({ message: `Could not reach remote "${remote}" to confirm base branch "${base}" exists there (${(res.stderr || res.error?.message || 'unknown error').trim().split('\n')[0]}).` });
    }
  }
  return { errors, warnings };
}

function parseRunSpawnTime(runId) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(runId || '');
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
}

// ---- run inventory ---------------------------------------------------------

/** Every run directory, newest first, with enough state to classify it. */
export function listRunStates(paths, thresholds = DEFAULT_THRESHOLDS, now = Date.now()) {
  let ids = [];
  try { ids = fs.readdirSync(paths.runs).filter((d) => isValidRunId(d)); } catch { /* no runs dir */ }
  let dismissedMap = {};
  try { dismissedMap = readBridge(paths.root)?.dismissedRuns || {}; } catch {}
  const runs = [];
  for (const runId of ids.sort().reverse()) {
    const runPaths = pipelinePaths(paths.root, { runId });
    let status = null;
    try { status = JSON.parse(fs.readFileSync(runPaths.status, 'utf8')); } catch { /* unreadable stays unknown */ }
    const meta = readRunMeta(runPaths);
    const isDismissed = !!(status?.dismissed || meta?.dismissed || dismissedMap[runId]);
    if (isDismissed && status) status.dismissed = true;
    const lock = readLock(runPaths);
    const verbs = readStatusLog(runPaths);
    // `note` is informational by definition. Letting it become the current verb
    // would make every recorded aside look like a state change and re-raise
    // events that were already handled.
    const verb = latestVerb(verbs.filter((v) => v.verb !== 'note')) || latestVerb(verbs);
    let lastOutputAt = null;
    try { lastOutputAt = new Date(fs.statSync(runPaths.events).mtimeMs).toISOString(); } catch { /* no events yet */ }

    const running = status?.stages?.find(s => s.name === status.awaitingStage) || status?.stages?.find(s => ['running', 'awaiting_host'].includes(s.status));
    runs.push({
      runId,
      paths: runPaths,
      status,
      meta,
      dismissed: isDismissed,
      featureId: meta?.featureId ?? status?.featureId ?? null,
      ticketId: meta?.ticketId ?? status?.ticketId ?? null,
      kind: meta?.kind ?? 'ticket',
      branch: meta?.branch ?? status?.branch ?? null,
      worktree: meta?.worktree ?? status?.worktree ?? null,
      pid: meta?.pid ?? lock?.pid ?? null,
      pidAlive: pidAlive(lock?.pid ?? meta?.pid),
      verb: verb?.verb ?? null,
      verbDetail: verb?.detail ?? null,
      verbSince: verb?.ts ?? null,
      lastOutputAt,
      stage: running?.name ?? null,
      cycle: running?.cycle ?? null,
      maxCycles: running?.maxCycles ?? null,
      state: classifyRun({
        status,
        pidAlive: pidAlive(lock?.pid ?? meta?.pid),
        lastOutputAt,
        lastVerb: verb,
        meta,
        now,
      }, thresholds),
      ...readUsage(runPaths.events),
      owner: inspectBridge(paths.root, runId).owner,
      handoffId: status?.handoffId ?? null,
      runner: meta?.runner ?? status?.runner ?? null,
      hostClient: status?.hostClient ?? null,
      invocationMode: status?.invocationMode ?? null,
      runnerRequested: status?.runnerRequested ?? null,
      spawnedAt: meta?.spawnedAt ?? status?.startedAt ?? parseRunSpawnTime(runId),
      // A run's own directory (and its reports) outlives its worktree — cleanup
      // on merge only removes the worktree — so this stays available for a
      // landed/accepted run same as a live one. Fallback to control reports when available.
      reportRel: fs.existsSync(path.join(runPaths.reports, 'work-done.html'))
        ? path.relative(paths.root, path.join(runPaths.reports, 'work-done.html'))
        : (meta?.featureId && fs.existsSync(path.join(paths.control, 'reports', meta.featureId, 'work-done.html'))
          ? path.relative(paths.root, path.join(paths.control, 'reports', meta.featureId, 'work-done.html'))
          : null),
      reportError: status?.reportError ?? null,
    });
  }

  const seenRunIds = new Set(runs.map((r) => r.runId));

  // Durable run records from control/runs.jsonl
  if (paths.runsLedger && fs.existsSync(paths.runsLedger)) {
    try {
      const lines = fs.readFileSync(paths.runsLedger, 'utf8').trim().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const entry = JSON.parse(line);
          if (!entry.runId || seenRunIds.has(entry.runId)) continue;
          seenRunIds.add(entry.runId);
          const runPaths = pipelinePaths(paths.root, { runId: entry.runId });
          const spawnedAt = entry.spawnedAt || parseRunSpawnTime(entry.runId) || entry.recordedAt || null;
          runs.push({
            runId: entry.runId,
            paths: runPaths,
            status: {
              overall: entry.overall || 'unknown',
              haltReason: entry.haltReason || null,
              startedAt: spawnedAt,
              endedAt: entry.finishedAt || entry.recordedAt || null,
            },
            meta: {
              runId: entry.runId,
              featureId: entry.featureId,
              ticketId: entry.ticketId,
              kind: entry.kind,
              runner: entry.runner,
              branch: entry.branch,
            },
            dismissed: !!(dismissedMap[entry.runId]),
            featureId: entry.featureId ?? null,
            ticketId: entry.ticketId ?? null,
            kind: entry.kind ?? 'ticket',
            branch: entry.branch ?? null,
            worktree: null,
            pid: null,
            pidAlive: false,
            verb: entry.overall === 'halted' ? 'failed' : entry.overall === 'done' ? 'done' : 'note',
            verbDetail: entry.haltReason || null,
            verbSince: entry.recordedAt ?? null,
            lastOutputAt: entry.finishedAt ?? entry.recordedAt ?? null,
            stage: entry.stage ?? null,
            cycle: null,
            maxCycles: null,
            state: ['done', 'halted'].includes(entry.overall) ? 'idle' : 'unknown',
            costUsd: null,
            tokens: null,
            owner: inspectBridge(paths.root, entry.runId).owner,
            handoffId: null,
            runner: entry.runner ?? null,
            hostClient: entry.hostClient ?? null,
            invocationMode: entry.invocationMode ?? null,
            runnerRequested: entry.runnerRequested ?? null,
            spawnedAt,
            reportRel: entry.reportRel || (entry.featureId && fs.existsSync(path.join(paths.control, 'reports', entry.featureId, 'work-done.html'))
              ? path.relative(paths.root, path.join(paths.control, 'reports', entry.featureId, 'work-done.html'))
              : null),
            reportError: entry.reportError ?? null,
          });
        } catch {}
      }
    } catch {}
  }

  // Synthesize historical runs from roadmap.json if not already present
  try {
    const rm = readRoadmap(paths);
    for (const feature of rm?.features || []) {
      const featureItems = [
        feature.specRunId ? { runId: feature.specRunId, kind: 'plan' } : null,
        ...(feature.tickets || []).map((t) => t.runId ? { runId: t.runId, ticketId: t.id, title: t.title, status: t.status, kind: 'ticket' } : null),
        feature.integrationRunId ? { runId: feature.integrationRunId, kind: 'integration' } : null,
      ].filter(Boolean);

      for (const item of featureItems) {
        if (!item.runId || seenRunIds.has(item.runId)) continue;
        seenRunIds.add(item.runId);
        const spawnedAt = parseRunSpawnTime(item.runId) || feature.startedAt || feature.landedAt || null;
        const isDone = ['landed', 'accepted'].includes(feature.status) || item.status === 'completed';
        const reportRel = feature.reportRel || (fs.existsSync(path.join(paths.control, 'reports', feature.id, 'work-done.html'))
          ? path.relative(paths.root, path.join(paths.control, 'reports', feature.id, 'work-done.html'))
          : null);
        runs.push({
          runId: item.runId,
          paths: pipelinePaths(paths.root, { runId: item.runId }),
          status: {
            overall: isDone ? 'done' : 'idle',
            task: item.title || feature.title,
            startedAt: spawnedAt,
            endedAt: feature.landedAt ?? null,
          },
          meta: {
            runId: item.runId,
            featureId: feature.id,
            ticketId: item.ticketId ?? null,
            kind: item.kind,
            runner: feature.runner ?? 'host',
          },
          dismissed: !!(dismissedMap[item.runId]),
          featureId: feature.id,
          ticketId: item.ticketId ?? null,
          kind: item.kind,
          branch: feature.branch ?? null,
          worktree: null,
          pid: null,
          pidAlive: false,
          verb: isDone ? 'landed' : 'note',
          verbDetail: null,
          verbSince: feature.landedAt ?? spawnedAt,
          lastOutputAt: feature.landedAt ?? spawnedAt,
          stage: 'reporter',
          cycle: 1,
          maxCycles: 1,
          state: isDone ? 'idle' : 'unknown',
          costUsd: null,
          tokens: null,
          owner: inspectBridge(paths.root, item.runId).owner,
          handoffId: null,
          runner: feature.runner ?? 'host',
          hostClient: null,
          invocationMode: null,
          runnerRequested: null,
          spawnedAt,
          reportRel,
          reportError: feature.reportError ?? null,
        });
      }
    }
  } catch {}

  runs.sort((a, b) => String(b.spawnedAt || b.runId).localeCompare(String(a.spawnedAt || a.runId)));
  return runs;
}

export function activeRuns(runs) {
  return runs.filter((r) => {
    if (['done', 'halted'].includes(r.status?.overall)) return false;
    if (r.state === 'unknown' && !r.status?.overall) return false;
    return ['busy', 'stale', 'awaiting', 'dead'].includes(r.state);
  });
}

// ---- supervisor liveness ---------------------------------------------------

export function supervisorState(paths) {
  let pid = null;
  try { pid = Number(fs.readFileSync(paths.supervisorPid, 'utf8').trim()); } catch { /* not started */ }
  const lock = (() => { try { return JSON.parse(fs.readFileSync(paths.controlLock, 'utf8')); } catch { return null; } })();
  const alive = pidAlive(pid);
  return {
    pid: pid || null,
    alive,
    startedAt: lock?.startedAt ?? null,
    heartbeatAt: lock?.heartbeatAt ?? null,
    paused: fs.existsSync(paths.paused),
  };
}

// ---- snapshot --------------------------------------------------------------

export function snapshot(paths, { config = null, now = new Date() } = {}) {
  const cfg = config || loadConfig(paths);
  const pool = poolConfig(cfg);
  const runs = listRunStates(paths, pool, now.getTime());
  const roadmap = readRoadmap(paths);
  const snap = buildSnapshot({
    roadmap,
    runs: runs.map((r) => ({
      runId: r.runId, featureId: r.featureId, ticketId: r.ticketId, kind: r.kind,
      stage: r.stage, cycle: r.cycle, maxCycles: r.maxCycles, state: r.state,
      verb: r.verb, lastOutputAt: r.lastOutputAt, worktree: r.worktree,
      branch: r.branch, costUsd: r.costUsd, costPartial: r.partial, owner: r.owner, handoffId: r.handoffId, overall: r.status?.overall, haltReason: r.status?.haltReason,
      runner: r.runner, hostClient: r.hostClient, invocationMode: r.invocationMode, runnerRequested: r.runnerRequested,
      spawnedAt: r.spawnedAt, reportRel: r.reportRel, reportError: r.reportError,
      dismissed: r.dismissed,
    })),
    decisions: readDecisions(paths),
    attention: pendingAttention(paths),
    supervisor: supervisorState(paths),
    skills: [],
    repoRoot: paths.root,
    now,
  });
  return snap;
}

export function writeSnapshot(paths, snap) {
  fs.mkdirSync(paths.control, { recursive: true });
  atomicWrite(paths.snapshot, JSON.stringify(snap, null, 2));
  return snap;
}

/**
 * Keep `.pipeline/status.json` meaningful while a pool is running.
 *
 * Every v1 guard, the slash commands and the dashboard all ask "is a run
 * active?" by reading this file. In pool mode no single run answers that, so the
 * supervisor mirrors the pool into the same shape: one writer, never a worker.
 */
export function writePrimaryMirror(paths, { snap, runs, config }) {
  const roadmap = readRoadmap(paths);
  const feature = roadmap?.features?.find((f) => f.id === roadmap.currentFeatureId) ?? null;
  const primary = runs.find((r) => r.kind === 'integration' && ['busy', 'stale', 'awaiting'].includes(r.state))
    ?? runs.find((r) => ['busy', 'stale', 'awaiting'].includes(r.state))
    ?? null;
  const awaitingChat = runs.find((r) => r.status?.overall === 'awaiting_chat') ?? null;
  const awaitingPlan = runs.find((r) => r.status?.overall === 'awaiting_plan_approval') ?? null;

  const status = newStatus(
    roadmap ? `${roadmap.title}${feature ? ` — ${feature.title}` : ''}` : 'Pool run',
    {},
  );
  status.startedAt = snap.supervisor.startedAt || status.startedAt;
  const surface = resolveExecutionSurface({
    runner: primary?.status?.runner || primary?.meta?.runner || config?.runner,
    invocationMode: primary?.status?.invocationMode,
    executionSurface: primary?.status?.executionSurface,
  });
  status.executionSurface = surface;
  status.invocationMode = isHostSurface({ executionSurface: surface }) ? 'chat' : (primary?.status?.invocationMode || 'cli');
  status.runner = primary?.status?.runner || primary?.meta?.runner || config?.runner || 'auto';
  status.hostClient = primary?.status?.hostClient || null;
  status.runnerRequested = primary?.status?.runnerRequested || null;
  if (awaitingChat) {
    status.awaitingStage = awaitingChat.status.awaitingStage || null;
    status.chatResume = awaitingChat.status.chatResume || null;
  }

  if (primary?.status?.stages) {
    status.stages = primary.status.stages;
    status.verdict = primary.status.verdict ?? null;
    status.limits = primary.status.limits ?? status.limits;
  }
  ensureStageEntries(status);

  const featuresSettled = roadmap?.features?.every((f) => ['accepted', 'landed', 'skipped'].includes(f.status));
  const allDone = featuresSettled && (roadmap?.review !== 'end' || roadmap?.roadmapStatus === 'landed');
  const awaitingFinal = roadmap?.review === 'end' && roadmap?.roadmapStatus === 'awaiting_final_review';
  if (!snap.supervisor.alive) status.overall = 'halted', status.haltReason = 'POOL_STOPPED';
  else if (snap.supervisor.paused) status.overall = 'halted', status.haltReason = 'POOL_PAUSED';
  else if (allDone) status.overall = 'done';
  else if (awaitingChat) status.overall = 'awaiting_chat';
  else if (awaitingPlan) status.overall = 'awaiting_plan_approval';
  else status.overall = 'running';
  // With no run in flight there is no stage to mirror: say so instead of
  // showing a "done" pool whose every stage is still "pending".
  if (!primary?.status?.stages) {
    for (const st of status.stages) {
      st.status = 'skipped';
      st.detail = 'Pool mirror: stage state lives in each run under .pipeline/runs/<runId>/.';
    }
  }
  if (['done', 'halted'].includes(status.overall)) status.endedAt = status.endedAt || new Date().toISOString();

  status.pool = {
    snapshot: path.relative(paths.root, paths.snapshot),
    primaryRunId: primary?.runId ?? null,
    featureId: roadmap?.currentFeatureId ?? null,
    runIds: runs.map((r) => r.runId),
    decisions: snap.needsDecision.length,
    gate: awaitingFinal ? 'roadmap-merge' : awaitingPlan ? 'plan-approval' : null,
  };
  atomicWrite(paths.status, JSON.stringify(status, null, 2));
  return status;
}

// ---- operator verbs --------------------------------------------------------

/** Queue a note for a stage of a run — the same channel the dashboard uses. */
export function queueFollowup(paths, runId, stage, text) {
  const runPaths = pipelinePaths(paths.root, { runId });
  return queueStageNote(runPaths, stage, text);
}

/**
 * Answer an open decision. The answer is recorded in the ledger AND queued as a
 * note for the stage that raised it, so the worker actually sees it when it
 * resumes — a decision that only exists in a ledger changes nothing.
 */
export function decide(paths, decisionId, answer, { by = 'operator', via = 'cli' } = {}) {
  const decision = readDecisions(paths).find((d) => d.decisionId === decisionId);
  if (!decision) throw new Error(`Unknown decision "${decisionId}".`);
  if (decision.kind === 'merge-approval' && /^approve$/i.test(String(answer).trim())) {
    return approveMerge(paths, decision.featureId, { by, via, note: answer });
  }
  if (decision.kind === 'merge-approval' && /^request-changes\b/i.test(String(answer).trim())) {
    const reason = String(answer).trim().replace(/^request-changes\s*:?\s*/i, '');
    if (!reason) throw new Error('Describe the changes requested after "request-changes:".');
    return requestChanges(paths, decision.featureId, reason, { by, via });
  }
  if (decision.kind === 'roadmap-merge' && /^approve$/i.test(String(answer).trim())) {
    return approveRoadmapMerge(paths, { by, via, note: answer });
  }
  const resolved = resolveDecision(paths, decisionId, { decision: answer, by, via });
  if (decision.runId) recordIntervention(paths.root, decision.runId, { action: `answered ${decision.kind || 'decision'}`, by, via, detail: String(answer).slice(0, 500) });
  if (decision.runId && decision.stage) {
    queueFollowup(paths, decision.runId, decision.stage, `Decision from the operator: ${answer}`);
  }
  if (decision.runId) {
    const runPaths = pipelinePaths(paths.root, { runId: decision.runId });
    appendRunVerb(runPaths, 'resolved', `${decision.kind || 'decision'}: ${answer}`);
    markResumeRequested(paths, decision.runId, 'decision answered');
  }
  return resolved;
}

/**
 * Ask the supervisor to move a run forward. The supervisor owns spawning, so a
 * verb never starts a process itself: it records intent and returns.
 */
/**
 * Operator verb: ask the supervisor to resume one halted run in place. Checks
 * the same recoverability table the engine will apply, so the operator gets
 * the refusal now instead of a silent failed respawn later.
 */
export function requestRunResume(paths, runId) {
  if (!isValidRunId(runId)) return { ok: false, reason: `invalid run id: ${runId}` };
  const runPaths = pipelinePaths(paths.root, { runId });
  let status = null;
  try { status = JSON.parse(fs.readFileSync(runPaths.status, 'utf8')); } catch { /* reported below */ }
  if (!status) return { ok: false, reason: `run ${runId} has no status.json` };
  const recovery = recoveryFor(status, { engineAlive: false });
  if (!recovery.resume) return { ok: false, reason: recovery.reason };
  if (recovery.needsValidArtifact) {
    const check = haltedArtifactCheck(status, runPaths.dir);
    if (!check.ok) return { ok: false, reason: `${check.file ? path.relative(paths.root, check.file) : 'the artifact'} is still unusable (${check.reason})` };
  }
  recordIntervention(paths.root, runId, { action: 'resume requested', via: 'operator' });
  return { ok: true, request: markResumeRequested(paths, runId, 'operator resume-run') };
}

/** Operator verb: change a run's autonomy; it applies at the run's next gate. */
export function setRunAutonomy(paths, runId, autonomy, { by = 'operator', via = 'cli' } = {}) {
  if (runId && !isValidRunId(runId)) throw new Error(`invalid run id: ${runId}`);
  const runPaths = pipelinePaths(paths.root, runId ? { runId } : {});
  if (!fs.existsSync(runPaths.status)) throw new Error(`run ${runId || '(root)'} has no status.json`);
  const record = writePolicyOverride(runPaths.dir, { autonomy, by, via });
  appendEvent(runPaths, { stage: 'orchestrator', type: 'policy_changed', autonomy, by, via });
  recordIntervention(paths.root, runId, { action: `set autonomy ${autonomy}`, by, via });
  return { runId: runId || null, ...record };
}

export function markResumeRequested(paths, runId, why) {
  const runPaths = pipelinePaths(paths.root, { runId });
  const meta = readRunMeta(runPaths) || {};
  const requests = { ...(meta.requests || {}), resume: { at: new Date().toISOString(), why } };
  if (runPaths.runMeta) {
    atomicWrite(runPaths.runMeta, JSON.stringify({ ...meta, requests }, null, 2));
  }
  return requests.resume;
}

export function requestExtend(paths, runId, cycles) {
  const runPaths = pipelinePaths(paths.root, { runId });
  const meta = readRunMeta(runPaths) || {};
  const requests = { ...(meta.requests || {}), extend: { at: new Date().toISOString(), cycles: Number(cycles) } };
  if (runPaths.runMeta) atomicWrite(runPaths.runMeta, JSON.stringify({ ...meta, requests }, null, 2));
  return requests.extend;
}

export function approvePlan(paths, runId, { by = 'operator', via = 'cli' } = {}) {
  const open = openDecisions(paths).find((d) => d.runId === runId && d.kind === 'plan-approval');
  if (open) return decide(paths, open.decisionId, 'approve', { by, via });
  markResumeRequested(paths, runId, 'plan approved');
  return { runId, decision: 'approve' };
}

/**
 * Approve merging a feature, or — when `review: end` is waiting — landing the
 * whole working branch onto `base`. Passing no feature id (or "roadmap") is
 * the final irreversible step. This records consent only; the supervisor still
 * performs a live mergeability read before anything is merged.
 */
function approveMergeUnlocked(paths, featureId, { by = 'operator', via = 'cli', note = null } = {}) {
  const roadmap = readRoadmap(paths);
  if (!roadmap) throw new Error('No compiled roadmap.');
  if (!featureId || featureId === 'roadmap') {
    return approveRoadmapMerge(paths, { by, via, note });
  }
  const feature = roadmap.features?.find((f) => f.id === featureId);
  if (!feature) throw new Error(`Unknown feature "${featureId}".`);
  if (feature.status !== 'awaiting_merge_approval') {
    throw new Error(`Feature "${featureId}" is ${feature.status}, not awaiting merge approval.`);
  }
  const open = openDecisions(paths).find((d) => d.featureId === featureId && d.kind === 'merge-approval');
  if (open) resolveDecision(paths, open.decisionId, { decision: 'approve', note, by, via });
  writeRoadmap(paths, setFeatureStatus(roadmap, featureId, 'merge_approved', {
    mergeApproval: { by, via, at: new Date().toISOString(), note, head: feature.committedSha, target: feature.validatedTarget },
  }));
  return { featureId, approved: true };
}

export function landRoadmap(paths, opts = {}) {
  return approveRoadmapMerge(paths, opts);
}

function approveRoadmapMergeUnlocked(paths, { by = 'operator', via = 'cli', note = null } = {}) {
  const roadmap = readRoadmap(paths);
  if (!roadmap) throw new Error('No compiled roadmap.');
  if (roadmap.review !== 'end') {
    throw new Error('This roadmap reviews per feature; pass a feature id to `approve-merge`.');
  }
  if (roadmap.roadmapStatus !== 'awaiting_final_review') {
    throw new Error(`Roadmap is ${roadmap.roadmapStatus || 'running'}, not awaiting a final review.`);
  }
  const open = openDecisions(paths).find((d) => d.kind === 'roadmap-merge');
  if (open) resolveDecision(paths, open.decisionId, { decision: 'approve', note, by, via });
  writeRoadmap(paths, setRoadmapStatus(roadmap, 'merge_approved', {
    mergeApproval: { by, via, at: new Date().toISOString(), note, head: roadmap.workingSha, target: roadmap.validatedTarget },
  }));
  return { roadmap: true, approved: true, workingBranch: roadmap.workingBranch ?? null };
}

/**
 * Reset a failed feature so the supervisor will plan it again from the same
 * baseRef. Tickets and runs are discarded; landed work on earlier features is
 * not touched.
 */
function retryFeatureUnlocked(paths, featureId) {
  const roadmap = readRoadmap(paths);
  const feature = roadmap?.features?.find((f) => f.id === featureId);
  if (!feature) throw new Error(`Unknown feature "${featureId}".`);
  if (feature.status !== 'failed') {
    throw new Error(`Feature "${featureId}" is ${feature.status}, not failed.`);
  }
  writeRoadmap(paths, setFeatureStatus(roadmap, featureId, 'queued', {
    tickets: [],
    specRunId: null,
    integrationRunId: null,
    conflict: null,
    mergeState: null,
    startedAt: null,
  }));
  return { featureId, status: 'queued' };
}

/**
 * Rerun one failed or held ticket without replanning the feature. Committed
 * tickets and the approved plan are kept; the superseded run id is recorded
 * on the ticket for lineage.
 */
function retryTicketUnlocked(paths, featureId, ticketId) {
  const roadmap = readRoadmap(paths);
  const feature = roadmap?.features?.find((f) => f.id === featureId);
  if (!feature) throw new Error(`Unknown feature "${featureId}".`);
  if (!['failed', 'executing'].includes(feature.status)) {
    throw new Error(`Feature "${featureId}" is ${feature.status}; only an executing or failed feature's tickets can be retried.`);
  }
  const ticket = feature.tickets?.find((t) => t.id === ticketId);
  if (!ticket) throw new Error(`Feature "${featureId}" has no ticket "${ticketId}".`);
  if (!['failed', 'held'].includes(ticket.status)) {
    throw new Error(`Ticket "${ticketId}" is ${ticket.status}; only a failed or held ticket can be retried.`);
  }
  const tickets = feature.tickets.map((t) => (t.id !== ticketId ? t : {
    ...t, status: 'queued', runId: null,
    previousRunIds: [...(t.previousRunIds || []), t.runId].filter(Boolean),
  }));
  writeRoadmap(paths, setFeatureStatus(roadmap, featureId, 'executing', { tickets }));
  if (ticket.runId) recordIntervention(paths.root, ticket.runId, { action: 'retry-ticket', detail: `${featureId}/${ticketId} requeued; this run is superseded` });
  return { featureId, ticketId, status: 'queued', supersedes: ticket.runId || null };
}

function requestChangesUnlocked(paths, featureId, text, { by = 'operator', via = 'cli' } = {}) {
  const roadmap = readRoadmap(paths);
  const feature = roadmap?.features?.find((f) => f.id === featureId);
  if (!feature) throw new Error(`Unknown feature "${featureId}".`);
  const open = openDecisions(paths).find((d) => d.featureId === featureId && d.kind === 'merge-approval');
  if (open) resolveDecision(paths, open.decisionId, { decision: 'request-changes', note: text, by, via });
  const runId = feature.integrationRunId || feature.tickets?.[0]?.runId;
  if (runId) {
    queueFollowup(paths, runId, 'coder', `Changes requested by the operator: ${text}`);
    const runPaths = pipelinePaths(paths.root, { runId });
    appendRunVerb(runPaths, 'held', 'changes requested');
    markResumeRequested(paths, runId, 'changes requested');
  }
  writeRoadmap(paths, setFeatureStatus(roadmap, featureId, 'reviewing', {}));
  appendAttention(paths, { runId, featureId, kind: 'changes-requested', summary: text, escalate: false, by, via });
  return { featureId, runId: runId ?? null };
}

function holdFeatureUnlocked(paths, featureId, why = '') {
  const roadmap = readRoadmap(paths);
  if (!roadmap?.features?.some((f) => f.id === featureId)) throw new Error(`Unknown feature "${featureId}".`);
  writeRoadmap(paths, setFeatureStatus(roadmap, featureId, 'held', { heldReason: why || null }));
  return { featureId, status: 'held' };
}

function releaseFeatureUnlocked(paths, featureId) {
  const roadmap = readRoadmap(paths);
  const feature = roadmap?.features?.find((f) => f.id === featureId);
  if (!feature) throw new Error(`Unknown feature "${featureId}".`);
  if (feature.status !== 'held') throw new Error(`Feature "${featureId}" is ${feature.status}, not held.`);
  writeRoadmap(paths, setFeatureStatus(roadmap, featureId, 'queued', { heldReason: null }));
  return { featureId, status: 'queued' };
}

function skipFeatureUnlocked(paths, featureId, why = '') {
  const roadmap = readRoadmap(paths);
  if (!roadmap?.features?.some((f) => f.id === featureId)) throw new Error(`Unknown feature "${featureId}".`);
  writeRoadmap(paths, setFeatureStatus(roadmap, featureId, 'skipped', { skipReason: why || null }));
  return { featureId, status: 'skipped' };
}

export function addNote(paths, { kind = 'learning', text, runId = null, featureId = null }) {
  fs.mkdirSync(paths.notes, { recursive: true });
  const slug = String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'note';
  const file = path.join(paths.notes, `${new Date().toISOString().slice(0, 10)}-${slug}.md`);
  const body = [
    '---', `kind: ${kind}`, `runId: ${runId ?? ''}`, `featureId: ${featureId ?? ''}`,
    `recordedAt: ${new Date().toISOString()}`, '---', '', String(text).trim(), '',
  ].join('\n');
  fs.writeFileSync(file, body);
  return { file: path.relative(paths.root, file) };
}

/**
 * Claim a host-runner run that is parked at a chat handoff: everything a
 * human (or any attending chat agent, in any client) needs to pick it up and
 * complete that stage exactly as in single-run chat mode.
 */
export function claim(paths, runId, credentials = null) {
  if (credentials) return bridgeCommand('run.claim', {project:paths.root,runId,...credentials});
  const runPaths = pipelinePaths(paths.root, { runId });
  let status;
  try { status = JSON.parse(fs.readFileSync(runPaths.status, 'utf8')); }
  catch { throw new Error(`Unknown run "${runId}".`); }
  if (status.overall !== 'awaiting_chat') {
    throw new Error(`Run "${runId}" is not awaiting a chat handoff (overall=${status.overall}).`);
  }
  const meta = readRunMeta(runPaths);
  return {
    runId,
    featureId: status.featureId ?? null,
    ticketId: status.ticketId ?? null,
    stage: status.awaitingStage ?? null,
    worktree: path.relative(paths.root, runPaths.worktree),
    brief: meta?.brief ?? null,
    stageHandoff: path.relative(paths.root, runPaths.stageHandoff),
    handoffId: status.handoffId ?? null,
    continueCmd: `node pipeline/orchestrator.mjs --continue --run-id ${runId}${status.handoffId ? ` --handoff-id ${status.handoffId}` : ''}`,
  };
}

export function pause(paths, why = '') {
  fs.mkdirSync(paths.control, { recursive: true });
  fs.writeFileSync(paths.paused, JSON.stringify({ at: new Date().toISOString(), why }));
  return { paused: true };
}

export function resume(paths) {
  try { fs.unlinkSync(paths.paused); } catch { /* already running */ }
  return { paused: false };
}

export function dismissRun(paths, runId, reason = 'Dismissed by operator', { via = 'cli' } = {}) {
  const res = bridgeCommand('run.dismiss', { project: paths.root, runId, reason });
  if (!res.alreadyDismissed) recordIntervention(paths.root, runId, { action: 'dismissed', via, detail: reason });
  return res;
}

// Uncommitted changes, or commits not yet on the base: work that exists
// nowhere else. A git error counts as "has work" — never guess towards deleting.
function worktreeHasUnsavedWork(worktree, base) {
  const git = (args) => spawnSync('git', ['-C', worktree, ...args], { encoding: 'utf8', timeout: 30_000 });
  const dirty = git(['status', '--porcelain']);
  if (dirty.status !== 0) return true;
  if (dirty.stdout.trim()) return true;
  const ahead = git(['rev-list', '--count', `${base}..HEAD`]);
  if (ahead.status !== 0) return true;
  return Number(ahead.stdout.trim()) > 0;
}

export function reset(paths, { archive = true, hard = false, discardUnmerged = false } = {}) {
  // Never reset under live work: the old reset removed the lock and every
  // worktree of a running pool.
  const supervisorPid = (() => { try { return Number(fs.readFileSync(paths.supervisorPid, 'utf8').trim()); } catch { return null; } })();
  if (supervisorPid && pidAlive(supervisorPid)) throw new Error(`The supervisor is running (pid ${supervisorPid}); stop it first with \`pool stop\`.`);
  const runsDir = paths.runs;
  const runIds = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).filter((d) => isValidRunId(d)) : [];
  for (const id of [null, ...runIds]) {
    const lock = readLock(pipelinePaths(paths.root, id ? { runId: id } : {}));
    if (lock && pidAlive(lock.pid)) throw new Error(`${id ? `Run ${id}` : 'A run'} is active (pid ${lock.pid}); stop it before resetting the pool.`);
  }

  spawnSync('git', ['worktree', 'prune'], { cwd: paths.root, encoding: 'utf8' });
  // Resolve the base in the main repository: inside a worktree, "HEAD" is the
  // worktree's own tip, which would make every commit look already merged.
  const baseName = readRoadmap(paths)?.base || 'HEAD';
  const resolvedBase = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${baseName}^{commit}`], { cwd: paths.root, encoding: 'utf8' });
  const base = resolvedBase.status === 0 ? resolvedBase.stdout.trim() : baseName;
  const kept = [];
  const worktreesDir = paths.worktrees;
  if (fs.existsSync(worktreesDir)) {
    for (const name of fs.readdirSync(worktreesDir)) {
      const wt = path.join(worktreesDir, name);
      if (!discardUnmerged && fs.existsSync(path.join(wt, '.git')) && worktreeHasUnsavedWork(wt, base)) { kept.push(name); continue; }
      spawnSync('git', ['worktree', 'remove', '--force', wt], { cwd: paths.root, encoding: 'utf8', timeout: 60_000 });
      fs.rmSync(wt, { recursive: true, force: true });
    }
    if (!kept.length) fs.rmSync(worktreesDir, { recursive: true, force: true });
  }
  for (const dir of runIds) {
    if (kept.includes(dir)) continue; // its worktree still holds work
    const p = path.join(runsDir, dir);
    if (hard) {
      fs.rmSync(p, { recursive: true, force: true });
    } else if (archive) {
      fs.mkdirSync(path.join(runsDir, 'archived'), { recursive: true });
      fs.renameSync(p, path.join(runsDir, 'archived', dir));
    }
  }
  const rootLock = readLock(paths);
  if (!(rootLock && pidAlive(rootLock.pid))) fs.rmSync(paths.lock, { force: true });
  fs.rmSync(path.join(paths.control, 'snapshot.json'), { force: true });
  fs.rmSync(path.join(paths.control, 'supervisor.log'), { force: true });
  if (hard) {
    fs.rmSync(path.join(paths.control, 'attention.jsonl'), { force: true });
    fs.rmSync(path.join(paths.control, 'decisions.jsonl'), { force: true });
  }
  if (supervisorPid && !pidAlive(supervisorPid)) fs.rmSync(paths.supervisorPid, { force: true });
  return { reset: true, keptWorktrees: kept };
}

export { pendingAttention, ackAttention, openDecisions, readDecisions, renderDigest, nextFeature, FEATURE_STATUSES, setRoadmapStatus };

// Operator verbs and the supervisor tick both read-modify-write roadmap.json;
// without one lock an operator's retry could be overwritten by a tick that
// started before it (lost update).
const underRoadmapLock = (fn) => (paths, ...rest) => withFileLock(paths.roadmapLock, () => fn(paths, ...rest));
export const compile = underRoadmapLock(compileUnlocked);
export const approveMerge = underRoadmapLock(approveMergeUnlocked);
export const approveRoadmapMerge = underRoadmapLock(approveRoadmapMergeUnlocked);
export const retryFeature = underRoadmapLock(retryFeatureUnlocked);
export const retryTicket = underRoadmapLock(retryTicketUnlocked);
export const requestChanges = underRoadmapLock(requestChangesUnlocked);
export const holdFeature = underRoadmapLock(holdFeatureUnlocked);
export const releaseFeature = underRoadmapLock(releaseFeatureUnlocked);
export const skipFeature = underRoadmapLock(skipFeatureUnlocked);
