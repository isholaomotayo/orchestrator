import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreRun, aggregate } from './score.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const GOOD = {
  status: { overall: 'done', verdict: 'APPROVED', stages: [{ name: 'coder', cycle: 1 }] },
  reviewReport: '## Verdict: APPROVED',
  changedFiles: ['src/paginate.js'],
  checks: { isPassed: true },
  testCounts: { before: 3, after: 4 },
};

const ASSERTIONS = {
  completed: true,
  verdict: 'APPROVED',
  checksPass: true,
  filesChanged: ['src/paginate.js'],
  filesUnchanged: ['src/unrelated.js'],
  testsNotWeakened: true,
  maxCycles: 2,
};

test('a clean run scores 100%', () => {
  const s = scoreRun(ASSERTIONS, GOOD);
  assert.equal(s.passed, true);
  assert.equal(s.score, 1);
});

test('a run that greens the suite by deleting tests is scored a failure', () => {
  // The exact cheat the pipeline's prompts forbid and could not previously detect.
  const s = scoreRun(ASSERTIONS, { ...GOOD, testCounts: { before: 3, after: 2 } });
  assert.equal(s.passed, false);
  assert.equal(s.results.find((r) => r.name === 'testsNotWeakened').ok, false);
});

test('scope creep is caught even when the bug is fixed', () => {
  const s = scoreRun(ASSERTIONS, { ...GOOD, changedFiles: ['src/paginate.js', 'src/unrelated.js'] });
  assert.equal(s.passed, false);
  const creep = s.results.find((r) => r.name === 'unchanged:src/unrelated.js');
  assert.equal(creep.ok, false);
  assert.match(creep.detail, /scope creep/);
});

test('partial credit distinguishes "fixed it slowly" from "never fixed it"', () => {
  const slow = scoreRun(ASSERTIONS, { ...GOOD, status: { ...GOOD.status, stages: [{ name: 'coder', cycle: 5 }] } });
  const broken = scoreRun(ASSERTIONS, {
    status: { overall: 'halted', haltReason: 'MAX_CYCLES', stages: [{ name: 'coder', cycle: 5 }] },
    reviewReport: '', changedFiles: [], checks: { isPassed: false }, testCounts: { before: 3, after: 3 },
  });
  assert.equal(slow.passed, false);
  assert.equal(broken.passed, false);
  assert.ok(slow.score > broken.score, 'a slow fix must score above a total failure');
});

test('verdict falls back to parsing the report when status lacks one', () => {
  const s = scoreRun({ verdict: 'BLOCK' }, { reviewReport: '## Verdict: BLOCK', status: null });
  assert.equal(s.passed, true);
});

test('a missing verdict is reported, not treated as a pass', () => {
  const s = scoreRun({ verdict: 'APPROVED' }, { reviewReport: 'looks good to me', status: null });
  assert.equal(s.passed, false);
  assert.match(s.results[0].detail, /got none/);
});

test('aggregate summarises repeats and ranks the most common failure', () => {
  const runs = [
    scoreRun(ASSERTIONS, GOOD),
    scoreRun(ASSERTIONS, { ...GOOD, testCounts: { before: 3, after: 1 } }),
    scoreRun(ASSERTIONS, { ...GOOD, testCounts: { before: 3, after: 1 } }),
  ].map((r, i) => ({ ...r, costUsd: 0.5 * (i + 1) }));
  const agg = aggregate(runs);
  assert.equal(agg.n, 3);
  assert.equal(Number(agg.passRate.toFixed(2)), 0.33);
  assert.equal(agg.failuresByAssertion.testsNotWeakened, 2);
  assert.equal(agg.meanCostUsd, 1);
});

test('every task file is valid and points at a fixture that exists', () => {
  const taskDir = path.join(__dirname, 'tasks');
  const files = fs.readdirSync(taskDir).filter((f) => f.endsWith('.json'));
  assert.ok(files.length > 0, 'no eval tasks defined');
  for (const f of files) {
    const task = JSON.parse(fs.readFileSync(path.join(taskDir, f), 'utf8'));
    assert.ok(task.id && task.task && task.fixture, `${f} is missing id/task/fixture`);
    const fixture = path.join(__dirname, 'fixtures', task.fixture);
    assert.ok(fs.existsSync(path.join(fixture, 'package.json')), `${f}: fixture ${task.fixture} has no package.json`);
    assert.ok(Object.keys(task.assertions || {}).length > 0, `${f} asserts nothing`);
    // An assertion set with no outcome to grade would silently score 0/0.
    const scored = scoreRun(task.assertions, {});
    assert.ok(scored.results.length > 0, `${f}: assertions produced no checks`);
  }
});
