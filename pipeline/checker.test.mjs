import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseTestCounts } from './checker.mjs';

test('parseTestCounts reads node --test TAP summary', () => {
  const out = '# tests 4\n# pass 3\n# fail 1\n';
  assert.deepEqual(parseTestCounts(out), { passedCount: 3, failedCount: 1 });
});

test('parseTestCounts reads jest/pytest style', () => {
  assert.deepEqual(parseTestCounts('Tests: 5 passed, 2 failed'), { passedCount: 5, failedCount: 2 });
  assert.deepEqual(parseTestCounts('10 passed'), { passedCount: 10, failedCount: 0 });
});

test('parseTestCounts reads mocha style', () => {
  assert.deepEqual(parseTestCounts('3 passing\n1 failing'), { passedCount: 3, failedCount: 1 });
});

test('parseTestCounts returns nulls when nothing matches', () => {
  assert.deepEqual(parseTestCounts('no recognizable output'), { passedCount: null, failedCount: null });
  assert.deepEqual(parseTestCounts(''), { passedCount: null, failedCount: null });
});

test('parseTestCounts takes the summary at the END, not the first match', () => {
  // A failing test prints "2 passed" inside its own captured output; the real
  // summary comes last. Taking the first match made the regression guard compare
  // against a number that had nothing to do with the suite.
  const output = [
    'FAIL src/thing.test.js',
    '  expected the report to say "3 passed" but got "1 passed"',
    '',
    'Tests: 1 failed, 41 passed, 42 total',
  ].join('\n');
  assert.deepEqual(parseTestCounts(output), { passedCount: 41, failedCount: 1 });
});

test('parseTestCounts still reads a plain TAP summary', () => {
  const output = '# tests 12\n# pass 10\n# fail 2\n';
  assert.deepEqual(parseTestCounts(output), { passedCount: 10, failedCount: 2 });
});

test('parseTestCounts returns nulls when no counts are present', () => {
  assert.deepEqual(parseTestCounts('build succeeded'), { passedCount: null, failedCount: null });
});

test('parseTestCounts sums every TAP summary in multi-suite output', () => {
  // `npm test` across workspaces prints one TAP summary per suite; reading only
  // the last one made the regression guard see a fraction of the suite.
  const output = [
    '# tests 76', '# pass 76', '# fail 0', '',
    '# tests 47', '# pass 45', '# fail 2', '',
    '# tests 47', '# pass 47', '# fail 0',
  ].join('\n');
  assert.deepEqual(parseTestCounts(output), { passedCount: 168, failedCount: 2 });
});

test('a check that times out is killed with its whole process tree', async () => {
  const { runChecks } = await import('./checker.mjs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chk-'));
  const pidFile = path.join(dir, 'worker.pid');
  // A "test runner" that forks a worker and hangs.
  const cmd = `node -e "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('fs').writeFileSync('${pidFile}',String(c.pid));setInterval(()=>{},1000)"`;
  const paths = { checkerReport: path.join(dir, 'checker_report.md'), events: path.join(dir, 'events.jsonl'), dir };
  const res = runChecks({ cwd: dir, config: { checks: { test: cmd }, checkTimeoutMs: 1500 }, paths });
  assert.equal(res.isPassed, false);
  const worker = Number(fs.readFileSync(pidFile, 'utf8'));
  let alive = true;
  try { process.kill(worker, 0); } catch { alive = false; }
  if (alive) process.kill(worker, 'SIGKILL');
  assert.equal(alive, false, 'the forked worker must not outlive the timed-out check');
  assert.match(fs.readFileSync(paths.checkerReport, 'utf8'), /timed out/);
  fs.rmSync(dir, { recursive: true, force: true });
});
