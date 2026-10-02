// Field-failure regression suite: each failure mode observed in real usage
// (petra, Sep 2026; "spirit and life bible", Oct 2026), reproduced against the
// real engine on BOTH execution surfaces, so "runs are flawless in chat and
// CLI mode" is something the test suite checks rather than a hope.
//
// CLI surface: a fake agent CLI (customRunners) that reads which stage it is
// from its system prompt and writes that stage's artifact — or misbehaves the
// way a real agent did, as scripted per test. Host surface: the test plays the
// chat agent, writing artifacts and running --continue exactly as a host does.
// No model, no network, no data from those projects.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pipelinePaths } from './state.mjs';

const ENGINE = new URL('./orchestrator.mjs', import.meta.url).pathname;
const STAGES = ['planner', 'plan_reviewer', 'designer', 'coder', 'tester', 'reviewer', 'handoff', 'reporter'];
const FILES = { planner: 'specs.md', plan_reviewer: 'plan_review.md', coder: 'changes.md', tester: 'test_suite.md', reviewer: 'review_report.md', handoff: 'handoff.md', reporter: 'reporter.md' };

const pad = (s) => s.padEnd(260, ' ');
const VALID = {
  planner: pad('# Specification\n\n## Objective\nAdd the module.\n\n## Failure Modes\n| ID | Case |\n|---|---|\n| E1 | empty input |\n\n## 3. Tracer-Bullet Tickets\n\n### Ticket 1: Module\n- **Files:** src/mod.js\n- **Dependencies:** None\n\n## Acceptance\nTests pass.\n'),
  plan_reviewer: pad('# PLAN APPROVAL REVIEW\n\n## Verdict: APPROVED\n\n## Spec Coverage\nAll rows covered.\n\n## Required Revisions\nNone.\n'),
  coder: pad('## Fix Cycle 1\nImplemented src/mod.js.\n\n## Self-Review\nE1 handled in src/mod.js:3.\n'),
  tester: pad('# Test Suite\n\n## Coverage Map\n| E1 | mod.test.js |\n\n## Uncovered\nNone.\n'),
  reviewer: pad('# Review\n\n## Verdict: APPROVED\n\n## Spec Coverage\n| ID | Status | Evidence |\n|---|---|---|\n| E1 | covered | mod.test.js |\n'),
  handoff: pad('# Handoff\n\nAll done; nothing pending.\n'),
  reporter: pad('## Summary\nAdded the module with a test.\n'),
};
const WITHOUT_SELF_REVIEW = pad('## Fix Cycle 1\nImplemented src/mod.js; forgot the review section.\n');

// The fake agent: argv[2] is the system prompt ("prompt for <stage>").
const FAKE_AGENT = `
import fs from 'node:fs';
const stage = (/prompt for (\\w+)/.exec(process.argv[2] || '') || [])[1];
const valid = JSON.parse(fs.readFileSync('fake-valid.json', 'utf8'));
const script = fs.existsSync('fake-script.json') ? JSON.parse(fs.readFileSync('fake-script.json', 'utf8')) : {};
const countsFile = 'fake-counts.json';
const counts = fs.existsSync(countsFile) ? JSON.parse(fs.readFileSync(countsFile, 'utf8')) : {};
counts[stage] = (counts[stage] || 0) + 1;
fs.writeFileSync(countsFile, JSON.stringify(counts));
const plan = script[stage];
const files = ${JSON.stringify(FILES)};
if (plan === 'fail-529-once' && counts[stage] === 1) {
  console.log('ok 1 - rejects_unauthorized_discussion_list');
  console.log('not ok 2 - permission denied for guest');
  console.error('Error: 529 overloaded_error: Overloaded');
  process.exit(1);
}
if (!files[stage]) process.exit(0);
const content = plan === 'omit-self-review-once' && counts[stage] === 1 ? script.omitted : valid[stage];
fs.writeFileSync('.pipeline/' + files[stage], content);
`;

function repo({ config = {}, script = null } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'field-')));
  const git = (...args) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(root, 'README.md'), 'demo\n');
  git('add', '-A'); git('commit', '-q', '-m', 'init');
  const paths = pipelinePaths(root);
  fs.mkdirSync(paths.prompts, { recursive: true });
  for (const stage of STAGES) fs.writeFileSync(path.join(paths.prompts, `${stage}_prompt.txt`), `prompt for ${stage}`);
  fs.writeFileSync(path.join(root, 'fake-agent.mjs'), FAKE_AGENT);
  fs.writeFileSync(path.join(root, 'fake-valid.json'), JSON.stringify(VALID));
  if (script) fs.writeFileSync(path.join(root, 'fake-script.json'), JSON.stringify(script));
  fs.writeFileSync(paths.config, JSON.stringify({
    bridge: { required: false }, agentTimeoutMs: 20000, agentRetries: 1,
    checks: { lint: '', typecheck: '', test: 'echo "# pass 3"; echo "# fail 0"' },
    customRunners: { fake: { command: process.execPath, args: ['fake-agent.mjs', '{systemPrompt}'] } },
    ...config,
  }));
  return { root, paths, cleanup: () => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
}

const engine = (root, args, env = {}) => spawnSync(process.execPath, [ENGINE, ...args, '--no-ui'], { cwd: root, encoding: 'utf8', timeout: 60000, env: { ...process.env, ...env } });
const status = (paths) => JSON.parse(fs.readFileSync(paths.status, 'utf8'));
const events = (paths) => fs.readFileSync(paths.events, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

// Play the chat agent: complete whatever stage is handed off, until done.
function driveHost(root, paths, { maxSteps = 20, override = {} } = {}) {
  for (let i = 0; i < maxSteps; i++) {
    const s = status(paths);
    if (s.overall !== 'awaiting_chat') return s;
    const stage = s.awaitingStage;
    if (FILES[stage]) fs.writeFileSync(path.join(paths.dir, FILES[stage]), override[stage] ?? VALID[stage]);
    const res = engine(root, ['--continue']);
    if (res.status !== 0 && res.status !== 2) return { ...status(paths), lastStderr: res.stderr };
  }
  return status(paths);
}

// ---- happy paths, both surfaces ---------------------------------------------

test('CLI surface: a full run completes APPROVED with the fake agent', () => {
  const { root, paths, cleanup } = repo();
  try {
    const res = engine(root, ['--task', 'add a module', '--runner', 'fake', '--mode', 'cli']);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    const s = status(paths);
    assert.equal(s.overall, 'done');
    assert.equal(s.verdict, 'APPROVED');
    assert.equal(s.surface, 'cli');
  } finally { cleanup(); }
});

test('host surface: a full run completes APPROVED by handoff and --continue', () => {
  const { root, paths, cleanup } = repo();
  try {
    assert.equal(engine(root, ['--task', 'add a module', '--runner', 'host', '--mode', 'chat']).status, 0);
    const s = driveHost(root, paths);
    assert.equal(s.overall, 'done', s.lastStderr);
    assert.equal(s.verdict, 'APPROVED');
    assert.equal(s.surface, 'host');
  } finally { cleanup(); }
});

// ---- missing artifact section (5 of 7 petra halts) ------------------------

test('host surface: an artifact missing a section is rejected without halting; the fix continues', () => {
  const { root, paths, cleanup } = repo();
  try {
    engine(root, ['--task', 'add a module', '--runner', 'host', '--mode', 'chat']);
    // Planner and plan review done normally, then the coder forgets Self-Review.
    for (const stage of ['planner', 'plan_reviewer']) {
      fs.writeFileSync(path.join(paths.dir, FILES[stage]), VALID[stage]);
      assert.equal(engine(root, ['--continue']).status, 0, stage);
    }
    assert.equal(status(paths).awaitingStage, 'coder');
    fs.writeFileSync(paths.changes, WITHOUT_SELF_REVIEW);
    const rejected = engine(root, ['--continue']);
    assert.equal(rejected.status, 2);
    assert.match(rejected.stderr, /self-review/);
    assert.equal(status(paths).overall, 'awaiting_chat', 'the run is not halted');
    const s = driveHost(root, paths);
    assert.equal(s.overall, 'done', s.lastStderr);
  } finally { cleanup(); }
});

test('CLI surface, guided: an incomplete artifact halts as recoverable; fixing it and --resume finishes the run', () => {
  const { root, paths, cleanup } = repo({ script: { coder: 'omit-self-review-once', omitted: WITHOUT_SELF_REVIEW } });
  try {
    const first = engine(root, ['--task', 'add a module', '--runner', 'fake', '--mode', 'cli']);
    assert.notEqual(first.status, 0);
    assert.equal(status(paths).haltReason, 'MISSING_ARTIFACT');
    fs.writeFileSync(paths.changes, VALID.coder);
    const resumed = engine(root, ['--resume']);
    assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
    assert.equal(status(paths).overall, 'done');
  } finally { cleanup(); }
});

test('CLI surface, autonomous: an incomplete artifact gets one told-what-was-wrong rerun and the run finishes', () => {
  const { root, paths, cleanup } = repo({ script: { coder: 'omit-self-review-once', omitted: WITHOUT_SELF_REVIEW } });
  try {
    const res = engine(root, ['--task', 'add a module', '--runner', 'fake', '--mode', 'cli', '--autonomy', 'autonomous']);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.equal(status(paths).overall, 'done');
    assert.ok(events(paths).some((e) => e.type === 'artifact_retry' && e.stage === 'coder'));
  } finally { cleanup(); }
});

// ---- the duplicate --continue race (spirit and life bible, 2026-10-02) ----

test('host surface: a second --continue 0.3s after a handoff waits for the stage instead of halting', () => {
  const { root, paths, cleanup } = repo();
  try {
    engine(root, ['--task', 'add a module', '--runner', 'host', '--mode', 'chat']);
    fs.writeFileSync(paths.specs, VALID.planner);
    assert.equal(engine(root, ['--continue']).status, 0, 'the dashboard\'s continue');
    const duplicate = engine(root, ['--continue']); // the host's own continue for the planner
    assert.equal(duplicate.status, 2);
    assert.equal(status(paths).overall, 'awaiting_chat');
    assert.equal(status(paths).awaitingStage, 'plan_reviewer');
    assert.equal(driveHost(root, paths).overall, 'done');
  } finally { cleanup(); }
});

// ---- transient errors and misclassification -------------------------------

test('CLI surface: a 529 with auth-looking test output is retried as transient, not halted as fatal auth', () => {
  const { root, paths, cleanup } = repo({ script: { planner: 'fail-529-once' } });
  try {
    const res = engine(root, ['--task', 'add a module', '--runner', 'fake', '--mode', 'cli']);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.equal(status(paths).overall, 'done');
    assert.ok(events(paths).some((e) => e.type === 'agent_retry' && e.stage === 'planner'));
  } finally { cleanup(); }
});

// ---- stale engine / interrupted runs, both surfaces ------------------------

for (const surface of ['cli', 'host']) {
  test(`${surface} surface: a run whose engine died mid-stage resumes (stale resume used to be impossible)`, () => {
    const { root, paths, cleanup } = repo();
    try {
      const args = surface === 'cli' ? ['--runner', 'fake', '--mode', 'cli'] : ['--runner', 'host', '--mode', 'chat'];
      if (surface === 'cli') {
        // Start, then simulate a crash: status says running, no live lock.
        engine(root, ['--task', 'add a module', ...args, '--plan-only']);
        fs.writeFileSync(paths.status, JSON.stringify({ ...status(paths), overall: 'running', haltReason: null }));
      } else {
        engine(root, ['--task', 'add a module', ...args]);
        fs.writeFileSync(paths.status, JSON.stringify({ ...status(paths), overall: 'running' }));
      }
      const res = engine(root, ['--resume']);
      assert.equal(res.status, 0, res.stdout + res.stderr);
      assert.ok(['done', 'awaiting_chat'].includes(status(paths).overall));
      assert.equal(status(paths).surface, surface, 'resuming never changes the surface');
    } finally { cleanup(); }
  });
}

test('the surface of a CLI run survives a resume from a chat-looking environment', () => {
  const { root, paths, cleanup } = repo({ script: { coder: 'omit-self-review-once', omitted: WITHOUT_SELF_REVIEW } });
  try {
    engine(root, ['--task', 'add a module', '--runner', 'fake', '--mode', 'cli']);
    fs.writeFileSync(paths.changes, VALID.coder);
    const res = engine(root, ['--resume'], { CLAUDECODE: '1' });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    const s = status(paths);
    assert.equal(s.overall, 'done', 'still driven by the CLI agent, not parked for a chat nobody has open');
    assert.equal(s.surface, 'cli');
  } finally { cleanup(); }
});
