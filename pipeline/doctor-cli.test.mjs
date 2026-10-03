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
