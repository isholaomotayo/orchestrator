// Shared state helpers for the pipeline: paths, config, status.json, events.jsonl.
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_MODEL_PROFILES, mergeModelProfiles } from './models.mjs';

export const STAGES = ['planner', 'designer', 'coder', 'tester', 'reviewer', 'handoff'];
// The four always-on stages; designer/handoff are opt-in and default to 'skipped'.
export const CORE_STAGES = ['planner', 'coder', 'tester', 'reviewer'];
export const OPTIONAL_STAGES = ['designer', 'handoff'];

export function pipelinePaths(repoRoot) {
  const dir = path.join(repoRoot, '.pipeline');
  return {
    root: repoRoot,
    dir,
    prompts: path.join(dir, 'prompts'),
    logs: path.join(dir, 'logs'),
    config: path.join(dir, 'config.json'),
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
    runs: path.join(dir, 'runs'),
  };
}

export const STAGE_ARTIFACT_FILES = {
  planner: 'specs.md',
  designer: 'design.md',
  coder: 'changes.md',
  tester: 'test_suite.md',
  reviewer: 'review_report.md',
  handoff: 'handoff.md',
};

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

const NUMERIC_CONFIG_FIELDS = ['maxCoderCycles', 'maxPostTesterCycles', 'maxReviewCycles', 'uiPort', 'checkTimeoutMs', 'agentTimeoutMs'];

export function loadConfig(paths) {
  const defaults = {
    runner: 'auto',
    maxCoderCycles: 5,
    maxPostTesterCycles: 2,
    maxReviewCycles: 3,
    uiPort: 4600,
    checks: {
      test: 'npm test --silent',
      lint: 'npm run lint --if-present --silent',
      typecheck: 'npm run typecheck --if-present --silent',
    },
    checkTimeoutMs: 300000,
    agentTimeoutMs: 1800000,
    approvePlan: false,
    designStage: false,
    handoffStage: false,
    modelProfiles: DEFAULT_MODEL_PROFILES,
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
  const merged = { ...defaults, ...raw, checks: { ...defaults.checks, ...(raw.checks || {}) } };
  merged.modelProfiles = mergeModelProfiles({ modelProfiles: raw.modelProfiles });
  for (const field of NUMERIC_CONFIG_FIELDS) {
    merged[field] = coercePositiveInt(raw[field], defaults[field], field);
  }
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
    baseRef: null,      // commit SHA the run started from; diff is scoped against it
    awaitingStage: null,
    chatResume: null,   // { step, context } — set when handing off to IDE chat
    resumePoint: null,  // { step, context } — tracks last saved checkpoint for resuming
    verdict: null,      // APPROVED | REQUEST_CHANGES | BLOCK
    reviewPass: 0,      // auto review-fix passes completed after a non-APPROVED verdict
    haltReason: null,   // REGRESSION_BLOCKED | MAX_CYCLES | MISSING_ARTIFACT | AGENT_ERROR
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
      startedAt: null, endedAt: null, artifact: null, detail: null, model: null, checks: null,
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
