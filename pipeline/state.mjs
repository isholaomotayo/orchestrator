// Shared state helpers for the pipeline: paths, config, status.json, events.jsonl.
import fs from 'node:fs';
import path from 'node:path';

export const STAGES = ['planner', 'coder', 'tester', 'reviewer'];

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
    testHistory: path.join(dir, 'test_history.json'),
    diff: path.join(dir, 'diff.patch'),
    stageHandoff: path.join(dir, 'stage-handoff.json'),
    runs: path.join(dir, 'runs'),
  };
}

export const STAGE_ARTIFACT_FILES = {
  planner: 'specs.md',
  coder: 'changes.md',
  tester: 'test_suite.md',
  reviewer: 'review_report.md',
};

// True when the given PID belongs to a live process we can signal.
export function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

export function readLock(paths) {
  try { return JSON.parse(fs.readFileSync(paths.lock, 'utf8')); } catch { return null; }
}

export function loadConfig(paths) {
  const defaults = {
    runner: 'auto',
    maxCoderCycles: 5,
    maxPostTesterCycles: 2,
    uiPort: 4600,
    checks: {
      test: 'npm test --silent',
      lint: 'npm run lint --if-present --silent',
      typecheck: 'npm run typecheck --if-present --silent',
    },
    checkTimeoutMs: 300000,
    agentTimeoutMs: 1800000,
  };
  try {
    const raw = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
    return { ...defaults, ...raw, checks: { ...defaults.checks, ...(raw.checks || {}) } };
  } catch {
    return defaults;
  }
}

export function newStatus(task) {
  return {
    task,
    startedAt: new Date().toISOString(),
    endedAt: null,
    overall: 'running', // running | awaiting_chat | done | halted
    invocationMode: 'cli', // chat | cli — how agent stages are executed
    runner: 'auto',
    awaitingStage: null,
    chatResume: null,   // { step, context } — set when handing off to IDE chat
    verdict: null,      // APPROVED | REQUEST_CHANGES | BLOCK
    haltReason: null,   // REGRESSION_BLOCKED | MAX_CYCLES | MISSING_ARTIFACT | AGENT_ERROR
    stages: STAGES.map((name) => ({
      name,
      status: 'pending', // pending | running | passed | failed | blocked
      cycle: 0,
      maxCycles: name === 'coder' ? 5 : 1,
      startedAt: null,
      endedAt: null,
      artifact: null,
      detail: null,
      checks: null, // { passedCount, failedCount } from last checker run
    })),
  };
}

export function writeStatus(paths, status) {
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.writeFileSync(paths.status, JSON.stringify(status, null, 2));
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
