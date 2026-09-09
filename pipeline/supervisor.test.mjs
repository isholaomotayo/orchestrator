import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pipelinePaths, writeStatus, newStatus } from './state.mjs';
import { writeRunMeta } from './run-registry.mjs';
import { createSupervisor } from './supervisor.mjs';
import { compile, writeRoadmap, readRoadmap, listRunStates, pendingAttention } from './pool.mjs';
import { classifyRun } from './attention.mjs';

function tmpRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sup-'));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  fs.writeFileSync(path.join(root, 'README.md'), 'demo\n');
  spawnSync('git', ['add', '-A'], { cwd: root });
  spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd: root });
  const paths = pipelinePaths(root);
  fs.mkdirSync(paths.control, { recursive: true });
  fs.mkdirSync(paths.prompts, { recursive: true });
  fs.writeFileSync(paths.config, JSON.stringify({
    runner: 'host',
    customRunners: { cursor: { command: process.execPath, args: ['-e', ''] } },
    pool: { autoResumeMax: 2, featurePlanApproval: false },
  }));
  fs.writeFileSync(paths.roadmapMd, [
    '---', 'title: Demo', 'base: main', 'merge: local-only', '---', '',
    '## F1: First', '', '- depends_on: none', '',
    '### Description', '', 'Do the thing.', '',
    '### Acceptance', '', '- it works', '',
  ].join('\n'));
  spawnSync('git', ['add', '-A'], { cwd: root });
  spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'pipeline'], { cwd: root });
  return { root, paths };
}

test('a host pool worker is spawned as a chat handoff, never --mode cli', () => {
  const { root, paths } = tmpRepo();
  compile(paths);
  const spawned = [];
  const sup = createSupervisor({
    repoRoot: root,
    spawn: () => { throw new Error('CLI spawn should not run for host'); },
    spawnSync: (bin, args) => {
      spawned.push(args);
      const runId = args[args.indexOf('--run-id') + 1];
      const runPaths = pipelinePaths(root, { runId });
      fs.mkdirSync(runPaths.dir, { recursive: true });
      const status = newStatus('plan');
      status.overall = 'awaiting_chat';
      status.awaitingStage = 'planner';
      status.runner = 'host';
      status.invocationMode = 'chat';
      status.executionSurface = 'host-handoff';
      writeStatus(runPaths, status);
      writeRunMeta(runPaths, { runId, runner: 'host', phase: 'awaiting_chat', pid: null });
      return { status: 0 };
    },
  });
  sup.tick();
  assert.ok(spawned.length >= 1);
  const args = spawned[0];
  assert.equal(args[args.indexOf('--mode') + 1], 'chat');
  assert.equal(args[args.indexOf('--runner') + 1], 'host');
  const rm = readRoadmap(paths);
  assert.equal(rm.features[0].status, 'planning');
  fs.rmSync(root, { recursive: true, force: true });
});

test('an unavailable runner writes a terminal halted run instead of a status-less unknown', () => {
  const { root, paths } = tmpRepo();
  fs.writeFileSync(paths.config, JSON.stringify({ runner: 'not-configured' }));
  compile(paths);
  const sup = createSupervisor({
    repoRoot: root,
    spawn: () => { throw new Error('must not spawn'); },
    spawnSync: () => { throw new Error('must not spawnSync'); },
  });
  sup.tick();
  const rm = readRoadmap(paths);
  assert.equal(rm.features[0].status, 'failed');
  const runId = rm.features[0].specRunId;
  const status = JSON.parse(fs.readFileSync(pipelinePaths(root, { runId }).status, 'utf8'));
  assert.equal(status.haltReason, 'RUNNER_UNAVAILABLE');
  assert.equal(status.haltTransient, false);
  const state = classifyRun({
    status, pidAlive: false, lastOutputAt: null, now: Date.now(),
    meta: JSON.parse(fs.readFileSync(pipelinePaths(root, { runId }).runMeta, 'utf8')),
  });
  assert.equal(state, 'idle');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a fatal AGENT_ERROR is not auto-resumed; a transient one is', () => {
  const fatal = tmpRepo();
  compile(fatal.paths);
  const fatalSpawned = [];
  const fatalId = '20260909T000000Z-F1-plan-aaaaaa';
  seedHalted(fatal.root, fatalId, { haltTransient: false });
  const fatalRm = readRoadmap(fatal.paths);
  fatalRm.features[0].status = 'planning';
  fatalRm.features[0].specRunId = fatalId;
  writeRoadmap(fatal.paths, fatalRm);
  createSupervisor({
    repoRoot: fatal.root,
    spawn: (_bin, args) => { fatalSpawned.push(args); return { pid: 1, unref() {} }; },
    spawnSync: () => ({ status: 0 }),
  }).tick();
  assert.equal(fatalSpawned.length, 0, 'fatal AGENT_ERROR must not auto-resume');
  fs.rmSync(fatal.root, { recursive: true, force: true });

  const transient = tmpRepo();
  compile(transient.paths);
  const transientSpawned = [];
  const transientId = '20260909T000000Z-F1-plan-aaaaab';
  seedHalted(transient.root, transientId, { haltTransient: true });
  const tRm = readRoadmap(transient.paths);
  tRm.features[0].status = 'planning';
  tRm.features[0].specRunId = transientId;
  writeRoadmap(transient.paths, tRm);
  createSupervisor({
    repoRoot: transient.root,
    spawn: (_bin, args) => { transientSpawned.push(args); return { pid: 1, unref() {} }; },
    spawnSync: () => ({ status: 0 }),
  }).tick();
  assert.ok(transientSpawned.some((args) => args.includes('--resume')), 'transient AGENT_ERROR is retried');
  fs.rmSync(transient.root, { recursive: true, force: true });
});

function seedHalted(root, runId, { haltTransient }) {
  const runPaths = pipelinePaths(root, { runId });
  fs.mkdirSync(runPaths.dir, { recursive: true });
  writeStatus(runPaths, {
    ...newStatus('plan'),
    overall: 'halted', haltReason: 'AGENT_ERROR', haltTransient,
    featureId: 'F1',
  });
  writeRunMeta(runPaths, { runId, featureId: 'F1', kind: 'plan', runner: 'cursor', phase: 'failed', autoResumes: 0, pid: null });
}

test('attention for the same run+kind is not duplicated across supervisor restarts', () => {
  const { root, paths } = tmpRepo();
  compile(paths);
  const runId = '20260909T000000Z-F1-plan-bbbbbb';
  seedHalted(root, runId, { haltTransient: false });
  const rm = readRoadmap(paths);
  rm.features[0].status = 'planning';
  rm.features[0].specRunId = runId;
  writeRoadmap(paths, rm);
  createSupervisor({ repoRoot: root, spawn: () => ({ pid: 1, unref() {} }), spawnSync: () => ({ status: 0 }) }).tick();
  createSupervisor({ repoRoot: root, spawn: () => ({ pid: 1, unref() {} }), spawnSync: () => ({ status: 0 }) }).tick();
  const halted = pendingAttention(paths).filter((a) => a.kind === 'halted' && a.runId === runId);
  assert.equal(halted.length, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a second plan is not spawned while the feature already has a live spec run', () => {
  const { root, paths } = tmpRepo();
  compile(paths);
  const spawned = [];
  const sup = createSupervisor({
    repoRoot: root,
    spawn: () => ({ pid: 99, unref() {} }),
    spawnSync: (_bin, args) => {
      spawned.push(args);
      const runId = args[args.indexOf('--run-id') + 1];
      const runPaths = pipelinePaths(root, { runId });
      fs.mkdirSync(runPaths.dir, { recursive: true });
      const status = newStatus('plan');
      status.overall = 'awaiting_chat';
      status.awaitingStage = 'planner';
      status.runner = 'host';
      writeStatus(runPaths, status);
      writeRunMeta(runPaths, { runId, runner: 'host', phase: 'awaiting_chat', pid: null });
      return { status: 0 };
    },
  });
  sup.tick();
  const first = spawned.length;
  sup.tick();
  assert.equal(spawned.length, first, 'must not start a duplicate plan run');
  fs.rmSync(root, { recursive: true, force: true });
});

test('status-less unknown runs are omitted from in-progress', () => {
  const { root, paths } = tmpRepo();
  compile(paths);
  const runId = '20260909T000000Z-F1-plan-cccccc';
  const runPaths = pipelinePaths(root, { runId });
  fs.mkdirSync(runPaths.dir, { recursive: true });
  writeRunMeta(runPaths, { runId, featureId: 'F1', kind: 'plan', phase: 'unknown', pid: null });
  const runs = listRunStates(paths);
  const row = runs.find((r) => r.runId === runId);
  assert.equal(row.state, 'unknown');
  fs.rmSync(root, { recursive: true, force: true });
});
