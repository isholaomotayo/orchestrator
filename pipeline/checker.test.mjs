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
