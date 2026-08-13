import test from 'node:test';
import assert from 'node:assert/strict';
import { paginate } from '../src/paginate.js';

test('splits evenly divisible input', () => {
  assert.deepEqual(paginate([1, 2, 3, 4], 2), [[1, 2], [3, 4]]);
});

test('keeps the final partial page', () => {
  assert.deepEqual(paginate([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test('rejects a non-positive page size', () => {
  assert.throws(() => paginate([1], 0), RangeError);
});
