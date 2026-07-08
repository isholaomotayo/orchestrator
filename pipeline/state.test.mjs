import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { coercePositiveInt, atomicWrite, loadConfig, pidAlive } from './state.mjs';

test('coercePositiveInt keeps valid positive integers', () => {
  assert.equal(coercePositiveInt(5, 1, 'x'), 5);
  assert.equal(coercePositiveInt('7', 1, 'x'), 7);
});

test('coercePositiveInt falls back for invalid values', () => {
  assert.equal(coercePositiveInt(0, 3, 'x'), 3);
  assert.equal(coercePositiveInt(-2, 3, 'x'), 3);
  assert.equal(coercePositiveInt('abc', 3, 'x'), 3);
  assert.equal(coercePositiveInt(1.5, 3, 'x'), 3);
});

test('coercePositiveInt returns fallback when undefined', () => {
  assert.equal(coercePositiveInt(undefined, 9, 'x'), 9);
});

test('atomicWrite replaces file contents in place', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-test-'));
  const file = path.join(dir, 'status.json');
  atomicWrite(file, 'first');
  assert.equal(fs.readFileSync(file, 'utf8'), 'first');
  atomicWrite(file, 'second');
  assert.equal(fs.readFileSync(file, 'utf8'), 'second');
  // No leftover temp files.
  assert.deepEqual(fs.readdirSync(dir), ['status.json']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadConfig coerces invalid numeric fields to defaults', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-test-'));
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ uiPort: 'nope', maxCoderCycles: 0, maxReviewCycles: 8 }));
  const cfg = loadConfig({ config: cfgPath });
  assert.equal(cfg.uiPort, 4600);
  assert.equal(cfg.maxCoderCycles, 5);
  assert.equal(cfg.maxReviewCycles, 8);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadConfig returns defaults when file is absent', () => {
  const cfg = loadConfig({ config: '/nonexistent/path/config.json' });
  assert.equal(cfg.uiPort, 4600);
  assert.equal(cfg.runner, 'auto');
});

test('pidAlive reports true for the current process and false for pid 0', () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(0), false);
});
