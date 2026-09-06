// Shared state helpers for the pipeline: paths, config, status.json, events.jsonl.
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_MODEL_PROFILES, DEFAULT_STAGE_EFFORT, mergeModelProfiles } from './models.mjs';
import { STAGES, CORE_STAGES, OPTIONAL_STAGES, STAGE_ARTIFACT_FILES } from './stages.mjs';

export { STAGES, CORE_STAGES, OPTIONAL_STAGES, STAGE_ARTIFACT_FILES };

/**
 * Every path the engine reads or writes, derived from the repo root.
 *
 * With no `runId` the result is exactly the v1 layout: run state lives directly
 * in `.pipeline/`. With a `runId` the run's own state (status, events, logs,
 * lock, artifacts) moves under `.pipeline/runs/<runId>/`, so many runs can be
 * live at once. Shared, repo-level inputs — the prompts, config.json, the runs
 * root and the control tree — never move, because they are shared by every run.
 *
 * @param {string} repoRoot
 * @param {{ runId?: string|null }} [opts]
 */
export function pipelinePaths(repoRoot, { runId = null } = {}) {
  const rootDir = path.join(repoRoot, '.pipeline');
  const runs = path.join(rootDir, 'runs');
  const control = path.join(rootDir, 'control');
  // The one line that makes a run self-contained: everything below hangs off
  // `dir`, so the same code writes v1 and v2 layouts unchanged.
  const dir = runId ? path.join(runs, runId) : rootDir;
  return {
    root: repoRoot,
    dir,
    runId,
    rootDir,
    // Shared inputs — repo-level for every run.
    prompts: path.join(rootDir, 'prompts'),
    config: path.join(rootDir, 'config.json'),
    runs,
    roadmapMd: path.join(rootDir, 'roadmap.md'),
    // Control tree (the pool's own state; the supervisor is its only writer).
    control,
    controlLock: path.join(control, '.lock'),
    snapshot: path.join(control, 'snapshot.json'),
    roadmapJson: path.join(control, 'roadmap.json'),
    decisions: path.join(control, 'decisions.jsonl'),
    attention: path.join(control, 'attention.jsonl'),
    briefs: path.join(control, 'briefs'),
    notes: path.join(control, 'notes'),
    supervisorPid: path.join(control, 'supervisor.pid'),
    supervisorLog: path.join(control, 'supervisor.log'),
    paused: path.join(control, 'paused'),
    worktrees: path.join(rootDir, 'worktrees'),
    worktree: runId ? path.join(rootDir, 'worktrees', runId) : null,
    // Per-run state.
    logs: path.join(dir, 'logs'),
    lock: path.join(dir, '.lock'),
    status: path.join(dir, 'status.json'),
    events: path.join(dir, 'events.jsonl'),
    vagueRequest: path.join(dir, 'vague_request.txt'),
    specs: path.join(dir, 'specs.md'),
    changes: path.join(dir, 'changes.md'),
    checkerReport: path.join(dir, 'checker_report.md'),
    testSuite: path.join(dir, 'test_suite.md'),
    reviewReport: path.join(dir, 'review_report.md'),
    design: path.join(dir, 'design.md'),
    handoffDoc: path.join(dir, 'handoff.md'),
    testHistory: path.join(dir, 'test_history.json'),
    diff: path.join(dir, 'diff.patch'),
    stageHandoff: path.join(dir, 'stage-handoff.json'),
    reports: path.join(dir, 'reports'),
    runMeta: runId ? path.join(dir, 'run.json') : null,
    runStatusLog: runId ? path.join(dir, 'run.status') : null,
  };
}

/**
 * Resolve a `.pipeline/`-relative path (the form used in prompts, permission
 * allowlists and CONTROL_PLANE_FILES) against THIS run rather than the repo
 * root. `.pipeline/specs.md` belongs to the run; `.pipeline/prompts/x.txt` and
 * `.pipeline/config.json` are shared and stay put.
 */
export function resolvePipelineRel(paths, rel) {
  const normalized = rel.split(path.sep).join('/');
  if (!normalized.startsWith('.pipeline/')) return path.join(paths.root, rel);
  const tail = normalized.slice('.pipeline/'.length);
  if (tail === 'config.json') return paths.config;
  if (tail === 'roadmap.md') return paths.roadmapMd;
  if (tail.startsWith('prompts/')) return path.join(paths.prompts, tail.slice('prompts/'.length));
  return path.join(paths.dir, tail);
}

// True when the given PID belongs to a live process we can signal.
export function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

export function readLock(paths) {
  try { return JSON.parse(fs.readFileSync(paths.lock, 'utf8')); } catch { return null; }
}

// Coerce a value to a positive integer, or return the fallback (with a warning)
// when it is missing/invalid. Guards against a mistyped config.json silently
// disabling a guardrail (e.g. uiPort: "4600" or maxCoderCycles: 0).
export function coercePositiveInt(value, fallback, label) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (Number.isInteger(n) && n > 0) return n;
  console.warn(`[config] Ignoring invalid ${label}=${JSON.stringify(value)}; using default ${fallback}.`);
  return fallback;
}

export function coerceNonNegativeInt(value, fallback, label) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (Number.isInteger(n) && n >= 0) return n;
  console.warn(`[config] Ignoring invalid ${label}=${JSON.stringify(value)}; using default ${fallback}.`);
  return fallback;
}

const NUMERIC_CONFIG_FIELDS = ['maxCoderCycles', 'maxPostTesterCycles', 'maxReviewCycles', 'uiPort', 'checkTimeoutMs', 'agentTimeoutMs', 'repoScanDepth', 'maxDiffBytes'];
// agentRetries is the one numeric knob where 0 is meaningful (retries disabled),
// so it cannot use coercePositiveInt.

export function loadConfig(paths) {
  const defaults = {
    runner: 'auto',
    maxCoderCycles: 5,
    maxPostTesterCycles: 2,
    maxReviewCycles: 3,
    uiPort: 4600,
    uiIdleTimeoutMs: 3600000, // 0 disables auto-shutdown; see ui-server.mjs
    checks: {
      test: 'npm test --silent',
      lint: 'npm run lint --if-present --silent',
      typecheck: 'npm run typecheck --if-present --silent',
    },
    checkTimeoutMs: 300000,
    agentTimeoutMs: 1800000,
    repoScanDepth: 4,     // how deep to look for nested repos when scoping the diff
    maxDiffBytes: 2000000, // total .pipeline/diff.patch budget across all repos
    agentRetries: 2, // bounded retries for TRANSIENT agent failures only
    approvePlan: false,
    designStage: false,
    handoffStage: false,
    reviewPanel: false, // CLI-only multi-lens review panel (see --review-panel)
    modelProfiles: DEFAULT_MODEL_PROFILES,
    stageEffort: DEFAULT_STAGE_EFFORT,
  };
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
  } catch (err) {
    // ENOENT is the normal "no config file" case — stay silent. Anything else
    // (malformed JSON, permission error) is a real misconfiguration: warn so it
    // is not masked by a silent fallback to defaults.
    if (err.code !== 'ENOENT') {
      console.warn(`[config] Could not read ${paths.config} (${err.message}); using defaults.`);
    }
    return defaults;
  }
  const merged = {
    ...defaults, ...raw,
    checks: { ...defaults.checks, ...(raw.checks || {}) },
    stageEffort: { ...defaults.stageEffort, ...(raw.stageEffort || {}) },
  };
  merged.modelProfiles = mergeModelProfiles({ modelProfiles: raw.modelProfiles });
  for (const field of NUMERIC_CONFIG_FIELDS) {
    merged[field] = coercePositiveInt(raw[field], defaults[field], field);
  }
  merged.agentRetries = coerceNonNegativeInt(raw.agentRetries, defaults.agentRetries, 'agentRetries');
  merged.uiIdleTimeoutMs = coerceNonNegativeInt(raw.uiIdleTimeoutMs, defaults.uiIdleTimeoutMs, 'uiIdleTimeoutMs');
  return merged;
}

export function newStatus(task, { design = false, handoff = false } = {}) {
  return {
    task,
    startedAt: new Date().toISOString(),
    endedAt: null,
    overall: 'running', // running | awaiting_chat | awaiting_plan_approval | done | halted
    invocationMode: 'cli', // chat | cli — how agent stages are executed
    runner: 'auto',
    models: null,
    baseRef: null,      // primary repo's commit SHA at run start; diff is scoped against it
    repos: [],          // every repo in diff scope: { root, label, enclosing, baseRef }
    awaitingStage: null,
    chatResume: null,   // { step, context } — set when handing off to IDE chat
    resumePoint: null,  // { step, context } — tracks last saved checkpoint for resuming
    verdict: null,      // APPROVED | REQUEST_CHANGES | BLOCK
    reviewPass: 0,      // auto review-fix passes completed after a non-APPROVED verdict
    haltReason: null,   // REGRESSION_BLOCKED | MAX_CYCLES | MISSING_ARTIFACT | AGENT_ERROR | INTEGRITY_VIOLATION | INVALID_VERDICT
    stages: STAGES.map((name) => ({
      name,
      // pending | running | passed | failed | blocked | skipped
      status: (name === 'designer' && !design) || (name === 'handoff' && !handoff) ? 'skipped' : 'pending',
      cycle: 0,
      maxCycles: name === 'coder' ? 5 : 1,
      startedAt: null,
      endedAt: null,
      artifact: null,
      detail: null,
      model: null,
      effort: null,  // reasoning-effort level requested for this stage
      checks: null, // { passedCount, failedCount } from last checker run
    })),
  };
}

// Backfill stage entries missing from a legacy (4-stage) status.json so stage
// lookups and the dashboard keep working when resuming an old run. A missing
// optional stage was never enabled, so it resumes as 'skipped'.
export function ensureStageEntries(status) {
  if (!status?.stages) return status;
  const have = new Set(status.stages.map((s) => s.name));
  STAGES.forEach((name, i) => {
    if (have.has(name)) return;
    status.stages.splice(i, 0, {
      name, status: 'skipped', cycle: 0, maxCycles: 1,
      startedAt: null, endedAt: null, artifact: null, detail: null, model: null, effort: null, checks: null,
    });
  });
  return status;
}

// Write to a temp file in the same directory then rename over the target.
// rename(2) is atomic on POSIX within one filesystem, so a crash/kill mid-write
// can never leave readers observing a truncated file.
export function atomicWrite(file, contents) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, file);
}

/**
 * Take a lock file atomically, or report that someone live already holds it.
 *
 * The 'wx' flag is the whole point: two processes starting in the same tick
 * cannot both pass an existsSync check and clobber each other. On EEXIST we
 * inspect the owner and reclaim only when its process is gone (crash, kill -9,
 * reboot), so a stale lock never needs deleting by hand.
 *
 * @returns {boolean} true when the lock is now held by this caller
 */
export function acquireLockFile(file, payload) {
  const body = JSON.stringify({ startedAt: new Date().toISOString(), ...payload });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, body);
      fs.closeSync(fd);
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let owner = null;
      try { owner = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
      // A corrupt lock cannot name a live owner, so it is reclaimable too.
      if (owner && pidAlive(owner.pid)) return false;
      try { fs.unlinkSync(file); } catch {}
    }
  }
  return false;
}

// Append one newline-terminated line, creating the parent directory if needed.
// O_APPEND writes under PIPE_BUF are atomic on POSIX, so short lines from two
// writers interleave safely rather than corrupting each other.
export function appendLine(file, line) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${line}\n`);
}

export function writeStatus(paths, status) {
  fs.mkdirSync(paths.dir, { recursive: true });
  atomicWrite(paths.status, JSON.stringify(status, null, 2));
}

export function appendEvent(paths, event) {
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.appendFileSync(paths.events, JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n');
}

export function tailFile(file, maxLines = 200) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    return lines.slice(Math.max(0, lines.length - maxLines)).join('\n');
  } catch {
    return '';
  }
}
