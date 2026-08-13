import test from 'node:test';
import assert from 'node:assert/strict';
import { addMoney } from '../src/money.js';

test('adds whole units', () => { assert.equal(addMoney(1, 2), 3); });
test('adds fractional units without float drift', () => { assert.equal(addMoney(0.1, 0.2), 0.3); });
test('handles negatives', () => { assert.equal(addMoney(-0.3, 0.1), -0.2); });
