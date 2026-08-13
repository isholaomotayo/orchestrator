import test from 'node:test';
import assert from 'node:assert/strict';
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
