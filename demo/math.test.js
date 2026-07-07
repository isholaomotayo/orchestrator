import test from 'node:test';
import assert from 'node:assert/strict';
import { add, multiply, divide } from './math.js';

test('add sums two numbers', () => {
  assert.equal(add(2, 3), 5);
});

test('multiply multiplies two numbers', () => {
  assert.equal(multiply(3, 4), 12);
});

test('divide divides and guards zero', () => {
  assert.equal(divide(10, 2), 5);
  assert.throws(() => divide(1, 0), RangeError);
});
