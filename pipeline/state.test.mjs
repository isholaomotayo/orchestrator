import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { coercePositiveInt, atomicWrite, loadConfig, pidAlive, newStatus, ensureStageEntries, STAGES, pipelinePaths, STAGE_ARTIFACT_FILES } from './state.mjs';

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

test('newStatus builds six stages and marks optional ones skipped by default', () => {
  const s = newStatus('t');
  assert.deepEqual(s.stages.map((x) => x.name), ['planner', 'designer', 'coder', 'tester', 'reviewer', 'handoff']);
  assert.equal(s.stages.find((x) => x.name === 'designer').status, 'skipped');
  assert.equal(s.stages.find((x) => x.name === 'handoff').status, 'skipped');
  assert.equal(s.stages.find((x) => x.name === 'planner').status, 'pending');
});

test('newStatus enables optional stages via flags', () => {
  const s = newStatus('t', { design: true, handoff: true });
  assert.equal(s.stages.find((x) => x.name === 'designer').status, 'pending');
  assert.equal(s.stages.find((x) => x.name === 'handoff').status, 'pending');
});

test('ensureStageEntries backfills a legacy 4-stage status as skipped, in canonical order', () => {
  const legacy = {
    stages: ['planner', 'coder', 'tester', 'reviewer'].map((name) => ({ name, status: 'passed' })),
  };
  ensureStageEntries(legacy);
  assert.deepEqual(legacy.stages.map((x) => x.name), STAGES);
  assert.equal(legacy.stages.find((x) => x.name === 'designer').status, 'skipped');
  assert.equal(legacy.stages.find((x) => x.name === 'handoff').status, 'skipped');
  assert.equal(legacy.stages.find((x) => x.name === 'planner').status, 'passed');
});

test('ensureStageEntries is a no-op on a current six-stage status', () => {
  const s = newStatus('t');
  const before = JSON.stringify(s.stages);
  ensureStageEntries(s);
  assert.equal(JSON.stringify(s.stages), before);
});

test('pipelinePaths exposes design and handoffDoc artifacts', () => {
  const p = pipelinePaths('/repo');
  assert.equal(p.design, '/repo/.pipeline/design.md');
  assert.equal(p.handoffDoc, '/repo/.pipeline/handoff.md');
  assert.equal(STAGE_ARTIFACT_FILES.designer, 'design.md');
  assert.equal(STAGE_ARTIFACT_FILES.handoff, 'handoff.md');
});

test('loadConfig defaults new stage toggles to false', () => {
  const cfg = loadConfig({ config: '/nonexistent/path/config.json' });
  assert.equal(cfg.approvePlan, false);
  assert.equal(cfg.designStage, false);
  assert.equal(cfg.handoffStage, false);
});
