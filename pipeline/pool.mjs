// The pool: reading and steering a roadmap run.
//
// Every operator action is a verb here, and every verb is deterministic. The
// coordinator agent decides WHAT to recommend and how to explain it; this file
// decides what is actually pending, what may be approved, and what happens
// next. Keeping that boundary is what makes the agent's judgment auditable —
// it can be wrong about a recommendation, but it cannot be wrong about state.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  pipelinePaths, loadConfig, atomicWrite, pidAlive, readLock,
  newStatus, ensureStageEntries, appendLine,
} from './state.mjs';
import { readRunMeta, readStatusLog, latestVerb, isValidRunId, appendRunVerb } from './run-registry.mjs';
import {
  parseRoadmapMd, compileRoadmap, setFeatureStatus, setRoadmapStatus, nextFeature, FEATURE_STATUSES,
} from './roadmap.mjs';
import { binExists } from './adapters.mjs';
import {
  classifyRun, DEFAULT_THRESHOLDS,
  appendAttention, pendingAttention, ackAttention,
  openDecisions, resolveDecision, readDecisions,
} from './attention.mjs';
import { buildSnapshot, renderDigest } from './snapshot.mjs';

export function poolConfig(config) {
  const raw = config.pool || {};
  return {
    maxParallel: raw.maxParallel ?? 3,
    pollMs: raw.pollMs ?? 2000,
    heartbeatMs: raw.heartbeatMs ?? 300_000,
    staleAfterMs: raw.staleAfterMs ?? DEFAULT_THRESHOLDS.staleAfterMs,
    staleEscalateMs: raw.staleEscalateMs ?? DEFAULT_THRESHOLDS.staleEscalateMs,
    pauseResurfaceMs: raw.pauseResurfaceMs ?? DEFAULT_THRESHOLDS.pauseResurfaceMs,
    autoResumeMax: raw.autoResumeMax ?? 2,
    serializeOnFileOverlap: raw.serializeOnFileOverlap !== false,
    featurePlanApproval: raw.featurePlanApproval !== false,
    // The runner a feature/ticket falls back to when it declares none of its
    // own. Inherits the pre-existing top-level `runner` setting when the
    // operator has one (so an existing single-runner preference still
    // applies in pool mode); otherwise 'auto', which prefers an
    // authenticated CLI, else host — a roadmap runs end to end with zero CLI
    // auth on the machine by default.
    defaultRunner: raw.defaultRunner ?? (config.runner && config.runner !== 'auto' ? config.runner : 'auto'),
    ticketFlags: raw.ticketFlags || {},
    integrationFlags: raw.integrationFlags || { reviewPanel: true, report: true },
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
export function compile(paths, { now = new Date() } = {}) {
  let source;
  try { source = fs.readFileSync(paths.roadmapMd, 'utf8'); }
  catch { return { ok: false, errors: [{ line: 0, message: `No roadmap at ${path.relative(paths.root, paths.roadmapMd)}. Write one, or run "roadmap plan".` }] }; }

  const { roadmap, errors } = parseRoadmapMd(source);
  if (errors.length) return { ok: false, errors };

  const sourceSha256 = crypto.createHash('sha256').update(source).digest('hex');
  const compiled = compileRoadmap(roadmap, readRoadmap(paths), { sourceSha256, now });
  writeRoadmap(paths, compiled);
  const warnings = [];
  if (compiled.review === 'end') {
    const hasCli = ['claude', 'cursor-agent', 'codex', 'agy'].some((bin) => binExists(bin));
    if (!hasCli) {
      warnings.push({
        message: 'review: end will run as attended claim-run items until a CLI (claude, cursor, codex, or antigravity/`agy`) is installed and authenticated.',
      });
    }
  }
  return { ok: true, roadmap: compiled, errors: [], warnings };
}

// ---- run inventory ---------------------------------------------------------

/** Every run directory, newest first, with enough state to classify it. */
export function listRunStates(paths, thresholds = DEFAULT_THRESHOLDS, now = Date.now()) {
  let ids = [];
  try { ids = fs.readdirSync(paths.runs).filter((d) => isValidRunId(d)); } catch { return []; }
  const runs = [];
  for (const runId of ids.sort().reverse()) {
    const runPaths = pipelinePaths(paths.root, { runId });
    let status = null;
    try { status = JSON.parse(fs.readFileSync(runPaths.status, 'utf8')); } catch { /* unreadable stays unknown */ }
    const meta = readRunMeta(runPaths);
    const lock = readLock(runPaths);
    const verbs = readStatusLog(runPaths);
    // `note` is informational by definition. Letting it become the current verb
    // would make every recorded aside look like a state change and re-raise
    // events that were already handled.
    const verb = latestVerb(verbs.filter((v) => v.verb !== 'note')) || latestVerb(verbs);
    let lastOutputAt = null;
    try { lastOutputAt = new Date(fs.statSync(runPaths.events).mtimeMs).toISOString(); } catch { /* no events yet */ }

    const running = status?.stages?.find((s) => s.status === 'running');
    runs.push({
      runId,
      paths: runPaths,
      status,
      meta,
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
      state: classifyRun({ status, pidAlive: pidAlive(lock?.pid ?? meta?.pid), lastOutputAt, lastVerb: verb, now }, thresholds),
      costUsd: 0,
    });
  }
  return runs;
}

export function activeRuns(runs) {
  return runs.filter((r) => ['busy', 'stale', 'awaiting', 'dead', 'unknown'].includes(r.state)
    && !['done', 'halted'].includes(r.status?.overall));
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
    runs: activeRuns(runs).map((r) => ({
      runId: r.runId, featureId: r.featureId, ticketId: r.ticketId, kind: r.kind,
      stage: r.stage, cycle: r.cycle, maxCycles: r.maxCycles, state: r.state,
      verb: r.verb, lastOutputAt: r.lastOutputAt, worktree: r.worktree,
      branch: r.branch, costUsd: r.costUsd,
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

  const status = newStatus(
    roadmap ? `${roadmap.title}${feature ? ` — ${feature.title}` : ''}` : 'Pool run',
    {},
  );
  status.startedAt = snap.supervisor.startedAt || status.startedAt;
  status.invocationMode = 'cli';
  status.runner = config?.runner ?? 'auto';

  if (primary?.status?.stages) {
    status.stages = primary.status.stages;
    status.verdict = primary.status.verdict ?? null;
    status.limits = primary.status.limits ?? status.limits;
  }
  ensureStageEntries(status);

  const featuresSettled = roadmap?.features?.every((f) => ['landed', 'skipped'].includes(f.status));
  const allDone = featuresSettled && (roadmap?.review !== 'end' || roadmap?.roadmapStatus === 'landed');
  const awaitingFinal = roadmap?.review === 'end' && roadmap?.roadmapStatus === 'awaiting_final_review';
  if (!snap.supervisor.alive) status.overall = 'halted', status.haltReason = 'POOL_STOPPED';
  else if (snap.supervisor.paused) status.overall = 'halted', status.haltReason = 'POOL_PAUSED';
  else if (allDone) status.overall = 'done';
  else if (awaitingFinal || (snap.needsDecision.length && !snap.counts.inProgress)) status.overall = 'awaiting_plan_approval';
  else status.overall = 'running';

  status.pool = {
    snapshot: path.relative(paths.root, paths.snapshot),
    primaryRunId: primary?.runId ?? null,
    featureId: roadmap?.currentFeatureId ?? null,
    runIds: runs.map((r) => r.runId),
    decisions: snap.needsDecision.length,
  };
  atomicWrite(paths.status, JSON.stringify(status, null, 2));
  return status;
}

// ---- operator verbs --------------------------------------------------------

/** Queue a note for a stage of a run — the same channel the dashboard uses. */
export function queueFollowup(paths, runId, stage, text) {
  const runPaths = pipelinePaths(paths.root, { runId });
  const dir = path.join(runPaths.dir, 'followups');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, `${stage}.txt`), `${String(text).trim()}\n`);
}

/**
 * Answer an open decision. The answer is recorded in the ledger AND queued as a
 * note for the stage that raised it, so the worker actually sees it when it
 * resumes — a decision that only exists in a ledger changes nothing.
 */
export function decide(paths, decisionId, answer, { by = 'operator', via = 'cli' } = {}) {
  const decision = readDecisions(paths).find((d) => d.decisionId === decisionId);
  if (!decision) throw new Error(`Unknown decision "${decisionId}".`);
  if (decision.kind === 'roadmap-merge' && /^approve$/i.test(String(answer).trim())) {
    return approveRoadmapMerge(paths, { by, via, note: answer });
  }
  const resolved = resolveDecision(paths, decisionId, { decision: answer, by, via });
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
export function approveMerge(paths, featureId, { by = 'operator', via = 'cli', note = null } = {}) {
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
    mergeApproval: { by, via, at: new Date().toISOString(), note },
  }));
  return { featureId, approved: true };
}

export function landRoadmap(paths, opts = {}) {
  return approveRoadmapMerge(paths, opts);
}

export function approveRoadmapMerge(paths, { by = 'operator', via = 'cli', note = null } = {}) {
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
    mergeApproval: { by, via, at: new Date().toISOString(), note },
  }));
  return { roadmap: true, approved: true, workingBranch: roadmap.workingBranch ?? null };
}

/**
 * Reset a failed feature so the supervisor will plan it again from the same
 * baseRef. Tickets and runs are discarded; landed work on earlier features is
 * not touched.
 */
export function retryFeature(paths, featureId) {
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

export function requestChanges(paths, featureId, text, { by = 'operator', via = 'cli' } = {}) {
  const roadmap = readRoadmap(paths);
  const feature = roadmap?.features?.find((f) => f.id === featureId);
  if (!feature) throw new Error(`Unknown feature "${featureId}".`);
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

export function holdFeature(paths, featureId, why = '') {
  const roadmap = readRoadmap(paths);
  if (!roadmap?.features?.some((f) => f.id === featureId)) throw new Error(`Unknown feature "${featureId}".`);
  writeRoadmap(paths, setFeatureStatus(roadmap, featureId, 'held', { heldReason: why || null }));
  return { featureId, status: 'held' };
}

export function releaseFeature(paths, featureId) {
  const roadmap = readRoadmap(paths);
  const feature = roadmap?.features?.find((f) => f.id === featureId);
  if (!feature) throw new Error(`Unknown feature "${featureId}".`);
  if (feature.status !== 'held') throw new Error(`Feature "${featureId}" is ${feature.status}, not held.`);
  writeRoadmap(paths, setFeatureStatus(roadmap, featureId, 'queued', { heldReason: null }));
  return { featureId, status: 'queued' };
}

export function skipFeature(paths, featureId, why = '') {
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
export function claim(paths, runId) {
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
    continueCmd: `node pipeline/orchestrator.mjs --continue --run-id ${runId}`,
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

export { pendingAttention, ackAttention, openDecisions, readDecisions, renderDigest, nextFeature, FEATURE_STATUSES, setRoadmapStatus };
