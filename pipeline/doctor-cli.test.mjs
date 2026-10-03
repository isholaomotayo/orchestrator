import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'doctor-cli.mjs');

function project(runs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-cli-'));
  fs.mkdirSync(path.join(root, '.pipeline', 'runs'), { recursive: true });
  fs.writeFileSync(path.join(root, '.pipeline', 'config.json'), '{}');
  for (const [id, status] of Object.entries(runs)) {
    const dir = path.join(root, '.pipeline', 'runs', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ stages: [], task: `Task ${id}`, ...status }));
    fs.writeFileSync(path.join(dir, 'events.jsonl'), '');
  }
  return root;
}
const run = (root, ...args) => spawnSync(process.execPath, [CLI, '--repo', root, ...args], { encoding: 'utf8' });
const cleanup = (root) => fs.rmSync(root, { recursive: true, force: true });

test('doctor lists runs that need attention with the reason and the fix, and hides the rest', () => {
  const root = project({
    'r-done': { overall: 'done' },
    'r-halt': { overall: 'halted', haltReason: 'INTERRUPTED' },
    'r-regress': { overall: 'halted', haltReason: 'REGRESSION_BLOCKED' },
  });
  const res = run(root);
  assert.equal(res.status, 1, 'something needs attention, so the exit code says so');
  assert.match(res.stdout, /r-halt/);
  assert.match(res.stdout, /halted-recoverable/);
  assert.match(res.stdout, /resume/);
  assert.match(res.stdout, /r-regress/);
  assert.match(res.stdout, /halted-terminal/);
  assert.doesNotMatch(res.stdout, /r-done/, 'finished runs are hidden unless asked for');
  assert.match(run(root, '--all').stdout, /r-done/);
  cleanup(root);
});

test('doctor --json is machine-readable and carries each run\'s diagnosis', () => {
  const root = project({ 'r-halt': { overall: 'halted', haltReason: 'MAX_CYCLES', haltedPhase: 'coder' } });
  const out = JSON.parse(run(root, '--json').stdout);
  assert.equal(out.runs.length, 1);
  assert.equal(out.runs[0].runId, 'r-halt');
  assert.equal(out.runs[0].diagnosis.state, 'halted-recoverable');
  assert.ok(out.runs[0].diagnosis.remedies.some((r) => r.verb === 'extend'));
  assert.equal(out.needsAttention, 1);
  cleanup(root);
});

test('doctor exits 0 when every run is finished or progressing', () => {
  const root = project({ 'r-done': { overall: 'done' } });
  const res = run(root);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /nothing needs attention/i);
  cleanup(root);
});

test('a run waiting on you counts as needing attention; one waiting on someone else does not', () => {
  const root = project({ 'r-plan': { overall: 'awaiting_plan_approval' } });
  const plan = JSON.parse(run(root, '--json').stdout);
  assert.equal(plan.runs[0].diagnosis.waitingOn, 'you');
  assert.equal(plan.needsAttention, 1);
  cleanup(root);
});

test('doctor says plainly when the folder is not an orchestrator project', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-cli-empty-'));
  const res = run(root);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /no \.pipeline/i);
  cleanup(root);
});

test('orchestrate.sh doctor reaches the same command from a consumer project', () => {
  const root = project({ 'r-halt': { overall: 'halted', haltReason: 'INTERRUPTED' } });
  fs.copyFileSync(path.join(HERE, '..', '.pipeline', 'orchestrate.sh'), path.join(root, '.pipeline', 'orchestrate.sh'));
  fs.symlinkSync(HERE, path.join(root, 'pipeline'), 'dir');
  const res = spawnSync('bash', [path.join(root, '.pipeline', 'orchestrate.sh'), 'doctor', '--json'], { cwd: root, encoding: 'utf8' });
  assert.equal(res.status, 1, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.runs[0].runId, 'r-halt');
  assert.equal(out.runs[0].diagnosis.state, 'halted-recoverable');
  cleanup(root);
});

// ---- doctor --fix -------------------------------------------------------------
import { fixPlan } from './doctor-cli.mjs';
import { diagnose } from './doctor.mjs';

const entry = (runId, status, extra = {}) => ({
  runId, featureId: status.featureId ?? null, diagnosis: diagnose({ status, engineAlive: false, now: Date.now(), ...extra }),
});
const argvs = (plan) => plan.map((p) => p.argv.join(' '));

test('fix plans only safe remedies, as the commands a person would have typed', () => {
  const plan = fixPlan([
    entry('r-int', { overall: 'halted', haltReason: 'INTERRUPTED' }),
    entry('root', { overall: 'halted', haltReason: 'INTERRUPTED' }),
    entry('r-max', { overall: 'halted', haltReason: 'MAX_CYCLES', haltedPhase: 'coder' }),
    entry('r-pool', { overall: 'halted', haltReason: 'INTERRUPTED', featureId: 'F1' }),
  ], { maxCycles: 5 });
  assert.deepEqual(argvs(plan), [
    '--resume --run-id r-int',
    '--resume',
    '--resume --extend 5 --run-id r-max',
    'pool resume-run r-pool',
  ]);
});

test('fix never plans a plan approval, a stop, or anything that needs a person\'s call', () => {
  const plan = fixPlan([
    entry('r-plan', { overall: 'awaiting_plan_approval' }),
    entry('r-reg', { overall: 'halted', haltReason: 'REGRESSION_BLOCKED' }),
    entry('r-park', { overall: 'awaiting_chat', awaitingStage: 'coder' }),
  ], { maxCycles: 5 });
  assert.deepEqual(plan, []);
});

test('a dead supervisor is started once, however many runs were waiting on it', () => {
  const sup = { alive: false, pid: 4242, paused: false, heartbeatAt: null };
  const plan = fixPlan([
    entry('r1', { overall: 'halted', haltReason: 'INTERRUPTED', featureId: 'F1' }, { supervisor: sup }),
    entry('r2', { overall: 'halted', haltReason: 'INTERRUPTED', featureId: 'F2' }, { supervisor: sup }),
  ], { maxCycles: 5 });
  assert.equal(argvs(plan).filter((a) => a === 'pool start').length, 1);
  assert.equal(argvs(plan)[0], 'pool start', 'the supervisor comes up before the runs it will drive');
});

test('a paused pool is resumed with the pool verb', () => {
  const plan = fixPlan([entry('mirror', { overall: 'halted', haltReason: 'POOL_PAUSED' })], { maxCycles: 5 });
  assert.deepEqual(argvs(plan), ['pool resume']);
});

function projectWithFakeScript(runs) {
  const root = project(runs);
  const log = path.join(root, 'calls.log');
  fs.writeFileSync(path.join(root, '.pipeline', 'orchestrate.sh'), `#!/usr/bin/env bash\necho "$@" >> "${log}"\n`, { mode: 0o755 });
  return { root, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []) };
}

test('doctor --fix shows the plan and changes nothing without confirmation', () => {
  const p = projectWithFakeScript({ 'r-halt': { overall: 'halted', haltReason: 'INTERRUPTED' } });
  const res = run(p.root, '--fix');
  assert.equal(res.status, 1);
  assert.match(res.stdout, /--resume --run-id r-halt/);
  assert.match(res.stderr, /--yes/);
  assert.deepEqual(p.calls(), [], 'nothing was run');
  cleanup(p.root);
});

test('doctor --fix --yes runs the planned commands and says so', () => {
  const p = projectWithFakeScript({ 'r-halt': { overall: 'halted', haltReason: 'INTERRUPTED' } });
  const res = run(p.root, '--fix', '--yes');
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(p.calls(), ['--resume --run-id r-halt']);
  assert.match(res.stdout, /ran 1/i);
  cleanup(p.root);
});

test('doctor --fix with nothing safe to do says so and runs nothing', () => {
  const p = projectWithFakeScript({ 'r-plan': { overall: 'awaiting_plan_approval' } });
  const res = run(p.root, '--fix', '--yes');
  assert.match(res.stdout, /nothing safe to fix/i);
  assert.deepEqual(p.calls(), []);
  cleanup(p.root);
});

test('doctor --fix reports a command that failed, and exits non-zero', () => {
  const p = projectWithFakeScript({ 'r-halt': { overall: 'halted', haltReason: 'INTERRUPTED' } });
  fs.writeFileSync(path.join(p.root, '.pipeline', 'orchestrate.sh'), '#!/usr/bin/env bash\nexit 1\n', { mode: 0o755 });
  const res = run(p.root, '--fix', '--yes');
  assert.equal(res.status, 1);
  assert.match(res.stdout, /✗/);
  assert.match(res.stdout, /Ran 0 of 1/);
  cleanup(p.root);
});

test('doctor --fix does not wait for a resumed run to finish', () => {
  const p = projectWithFakeScript({ 'r-halt': { overall: 'halted', haltReason: 'INTERRUPTED' } });
  fs.writeFileSync(path.join(p.root, '.pipeline', 'orchestrate.sh'), '#!/usr/bin/env bash\nsleep 30\n', { mode: 0o755 });
  const started = Date.now();
  const res = run(p.root, '--fix', '--yes');
  assert.ok(Date.now() - started < 10_000, 'the CLI returned while the engine was still running');
  assert.equal(res.status, 0, res.stderr);
  const pid = Number(/started \(pid (\d+)\)/.exec(res.stdout)?.[1]);
  assert.ok(pid, res.stdout);
  try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ } // the engine was started in its own process group
  cleanup(p.root);
});
