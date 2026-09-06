import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { coercePositiveInt, atomicWrite, loadConfig, pidAlive, newStatus, ensureStageEntries, STAGES, pipelinePaths, STAGE_ARTIFACT_FILES, resolvePipelineRel, acquireLockFile, appendLine } from './state.mjs';

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

// ---- v2: run-scoped paths, lock helper, append helper ----------------------

test('pipelinePaths without a runId is unchanged from the v1 shape', () => {
  const p = pipelinePaths('/repo');
  assert.equal(p.dir, '/repo/.pipeline');
  assert.equal(p.status, '/repo/.pipeline/status.json');
  assert.equal(p.events, '/repo/.pipeline/events.jsonl');
  assert.equal(p.logs, '/repo/.pipeline/logs');
  assert.equal(p.lock, '/repo/.pipeline/.lock');
  assert.equal(p.specs, '/repo/.pipeline/specs.md');
  assert.equal(p.runId, null);
  // Explicitly opting out is identical to omitting the option entirely.
  assert.deepEqual(pipelinePaths('/repo', { runId: null }), p);
});

test('pipelinePaths with a runId nests run state under runs/<runId>', () => {
  const p = pipelinePaths('/repo', { runId: 'r1' });
  assert.equal(p.runId, 'r1');
  assert.equal(p.dir, '/repo/.pipeline/runs/r1');
  assert.equal(p.status, '/repo/.pipeline/runs/r1/status.json');
  assert.equal(p.events, '/repo/.pipeline/runs/r1/events.jsonl');
  assert.equal(p.logs, '/repo/.pipeline/runs/r1/logs');
  assert.equal(p.lock, '/repo/.pipeline/runs/r1/.lock');
  assert.equal(p.specs, '/repo/.pipeline/runs/r1/specs.md');
  assert.equal(p.stageHandoff, '/repo/.pipeline/runs/r1/stage-handoff.json');
});

test('pipelinePaths keeps prompts, config and the runs root repo-level for every run', () => {
  const root = pipelinePaths('/repo');
  const run = pipelinePaths('/repo', { runId: 'r1' });
  for (const key of ['root', 'prompts', 'config', 'runs', 'rootDir']) {
    assert.equal(run[key], root[key], `${key} must not be run-scoped`);
  }
  assert.equal(run.prompts, '/repo/.pipeline/prompts');
  assert.equal(run.rootDir, '/repo/.pipeline');
});

test('pipelinePaths exposes the control-tree and worktree paths in both modes', () => {
  for (const p of [pipelinePaths('/repo'), pipelinePaths('/repo', { runId: 'r1' })]) {
    assert.equal(p.control, '/repo/.pipeline/control');
    assert.equal(p.snapshot, '/repo/.pipeline/control/snapshot.json');
    assert.equal(p.roadmapJson, '/repo/.pipeline/control/roadmap.json');
    assert.equal(p.roadmapMd, '/repo/.pipeline/roadmap.md');
    assert.equal(p.decisions, '/repo/.pipeline/control/decisions.jsonl');
    assert.equal(p.attention, '/repo/.pipeline/control/attention.jsonl');
    assert.equal(p.briefs, '/repo/.pipeline/control/briefs');
    assert.equal(p.controlLock, '/repo/.pipeline/control/.lock');
    assert.equal(p.worktrees, '/repo/.pipeline/worktrees');
  }
});

test('pipelinePaths derives per-run meta, verb log, reports and worktree', () => {
  const run = pipelinePaths('/repo', { runId: 'r1' });
  assert.equal(run.runMeta, '/repo/.pipeline/runs/r1/run.json');
  assert.equal(run.runStatusLog, '/repo/.pipeline/runs/r1/run.status');
  assert.equal(run.reports, '/repo/.pipeline/runs/r1/reports');
  assert.equal(run.worktree, '/repo/.pipeline/worktrees/r1');
  // Without a run there is no worktree and no per-run meta.
  const root = pipelinePaths('/repo');
  assert.equal(root.worktree, null);
  assert.equal(root.runMeta, null);
  assert.equal(root.runStatusLog, null);
  assert.equal(root.reports, '/repo/.pipeline/reports');
});

test('resolvePipelineRel maps a .pipeline/ rel onto the run dir, not the repo root', () => {
  const run = pipelinePaths('/repo', { runId: 'r1' });
  assert.equal(resolvePipelineRel(run, '.pipeline/specs.md'), '/repo/.pipeline/runs/r1/specs.md');
  assert.equal(resolvePipelineRel(run, '.pipeline/prompts/coder_prompt.txt'), '/repo/.pipeline/prompts/coder_prompt.txt');
  const root = pipelinePaths('/repo');
  assert.equal(resolvePipelineRel(root, '.pipeline/specs.md'), '/repo/.pipeline/specs.md');
});

test('resolvePipelineRel leaves a non-.pipeline rel anchored at the repo root', () => {
  const run = pipelinePaths('/repo', { runId: 'r1' });
  assert.equal(resolvePipelineRel(run, 'src/index.js'), '/repo/src/index.js');
});

test('acquireLockFile writes the payload and refuses a lock held by a live pid', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-'));
  const file = path.join(dir, '.lock');
  assert.equal(acquireLockFile(file, { pid: process.pid, role: 'supervisor' }), true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).role, 'supervisor');
  // A second acquisition while this process is alive must fail, not clobber.
  assert.equal(acquireLockFile(file, { pid: process.pid }), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('acquireLockFile reclaims a lock whose owning process is gone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-'));
  const file = path.join(dir, '.lock');
  // pid 0 is never a signalable process, so this lock is stale by definition.
  fs.writeFileSync(file, JSON.stringify({ pid: 0, startedAt: 'then' }));
  assert.equal(acquireLockFile(file, { pid: process.pid }), true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, process.pid);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('acquireLockFile reclaims a corrupt lock file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-'));
  const file = path.join(dir, '.lock');
  fs.writeFileSync(file, 'not json at all');
  assert.equal(acquireLockFile(file, { pid: process.pid }), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('appendLine creates parent directories and appends one newline-terminated line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'append-'));
  const file = path.join(dir, 'nested', 'run.status');
  appendLine(file, 'a');
  appendLine(file, 'b');
  assert.equal(fs.readFileSync(file, 'utf8'), 'a\nb\n');
  fs.rmSync(dir, { recursive: true, force: true });
});
