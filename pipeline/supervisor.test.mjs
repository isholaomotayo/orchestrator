import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pipelinePaths, writeStatus, newStatus } from './state.mjs';
import { writeRunMeta } from './run-registry.mjs';
import { createSupervisor } from './supervisor.mjs';
import { main as poolCli } from './pool-cli.mjs';
import { compile, writeRoadmap, readRoadmap, listRunStates, pendingAttention } from './pool.mjs';
import { classifyRun, openDecision, readDecisions, appendAttention, readAttention } from './attention.mjs';

function tmpRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sup-'));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  spawnSync('git', ['config', 'user.name', 'test'], { cwd: root });
  spawnSync('git', ['config', 'user.email', 'test@example.test'], { cwd: root });
  fs.writeFileSync(path.join(root, 'README.md'), 'demo\n');
  spawnSync('git', ['add', '-A'], { cwd: root });
  spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: root });
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

test('independent features share one host slot across supervisor restarts', () => {
  const { root, paths } = tmpRepo();
  fs.appendFileSync(paths.roadmapMd, '\n## F2: Second\n\n- depends_on: none\n\n### Description\n\nDo another thing.\n\n### Acceptance\n\n- it works\n');
  compile(paths);
  const spawnHost = (_bin, args) => {
    const runId = args[args.indexOf('--run-id') + 1];
    const runPaths = pipelinePaths(root, { runId });
    const status = newStatus('plan');
    status.overall = 'awaiting_chat';
    status.awaitingStage = 'planner';
    status.runner = 'host';
    status.executionSurface = 'host-handoff';
    status.handoffId = `handoff-${runId}`;
    writeStatus(runPaths, status);
    return { status: 0 };
  };
  createSupervisor({ repoRoot: root, spawnSync: spawnHost }).tick();
  assert.equal(listRunStates(paths).filter((r) => r.status?.overall === 'awaiting_chat').length, 1);
  createSupervisor({ repoRoot: root, spawnSync: spawnHost }).tick();
  assert.equal(listRunStates(paths).filter((r) => r.status?.overall === 'awaiting_chat').length, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a host ticket override waits for the global host slot while an opted-in CLI ticket starts', () => {
  const { root, paths } = tmpRepo();
  fs.appendFileSync(paths.roadmapMd, '\n## F2: Second\n\n- depends_on: none\n\n### Description\n\nDo another thing.\n\n### Acceptance\n\n- it works\n');
  compile(paths);
  const planId = '20260912T000000Z-F1-plan-a111';
  const waitingId = '20260912T000001Z-F2-plan-a222';
  const rm = readRoadmap(paths);
  rm.features[0].status = 'planning'; rm.features[0].specRunId = planId; rm.features[0].runner = 'cursor';
  rm.features[1].status = 'planning'; rm.features[1].specRunId = waitingId; rm.features[1].runner = 'host';
  writeRoadmap(paths, rm);
  const planPaths = pipelinePaths(root, { runId: planId });
  fs.mkdirSync(planPaths.dir, { recursive: true });
  const done = newStatus('plan'); done.overall = 'done'; done.runner = 'cursor';
  writeStatus(planPaths, done);
  writeRunMeta(planPaths, { runId: planId, featureId: 'F1', kind: 'plan', runner: 'cursor' });
  fs.writeFileSync(planPaths.specs, [
    '## 3. Tracer-Bullet Tickets',
    '### Ticket 1: Host work', '- **Files:** host.mjs', '- **Dependencies:** None', '- **Runner:** host',
    '### Ticket 2: CLI work', '- **Files:** cli.mjs', '- **Dependencies:** None', '- **Runner:** cursor',
  ].join('\n'));
  const waitingPaths = pipelinePaths(root, { runId: waitingId });
  fs.mkdirSync(waitingPaths.dir, { recursive: true });
  const waiting = newStatus('plan'); waiting.overall = 'awaiting_chat'; waiting.runner = 'host';
  waiting.executionSurface = 'host-handoff'; waiting.awaitingStage = 'planner';
  writeStatus(waitingPaths, waiting);
  writeRunMeta(waitingPaths, { runId: waitingId, featureId: 'F2', kind: 'plan', runner: 'host' });
  const cliSpawns = [];
  createSupervisor({ repoRoot: root,
    spawn: (_bin, args) => { cliSpawns.push(args); return { pid: 4242, unref() {} }; },
    spawnSync: () => { throw new Error('host ticket must wait'); },
  }).tick();
  const tickets = readRoadmap(paths).features[0].tickets;
  assert.equal(tickets.find((t) => t.id === 'T1').status, 'queued');
  assert.equal(tickets.find((t) => t.id === 'T2').status, 'running');
  assert.equal(cliSpawns.length, 1);
  assert.equal(cliSpawns[0][cliSpawns[0].indexOf('--runner') + 1], 'cursor');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a superseded host handoff updates one quiet agent task', () => {
  const { root, paths } = tmpRepo();
  compile(paths);
  const rm = readRoadmap(paths);
  const runId = '20260912T000000Z-F1-plan-abcd';
  rm.features[0].status = 'planning';
  rm.features[0].specRunId = runId;
  writeRoadmap(paths, rm);
  const runPaths = pipelinePaths(root, { runId });
  fs.mkdirSync(runPaths.dir, { recursive: true });
  const status = newStatus('plan');
  status.overall = 'awaiting_chat'; status.awaitingStage = 'planner'; status.handoffId = 'h1';
  status.runner = 'host'; status.executionSurface = 'host-handoff';
  writeStatus(runPaths, status);
  writeRunMeta(runPaths, { runId, featureId: 'F1', kind: 'plan', runner: 'host' });
  const oldCard = appendAttention(paths, { runId, featureId: 'F1', kind: 'claim-run', handoffId: 'h1', summary: 'Old host handoff' });
  const supervisor = createSupervisor({ repoRoot: root });
  supervisor.tick();
  assert.deepEqual(pendingAttention(paths).filter((a) => a.kind === 'claim-run'), []);
  assert.ok(readAttention(paths).some((a) => a.type === 'ack' && a.ackOf === oldCard.id), 'old card stays historical');
  assert.equal(poolSnapshotClaim(paths), 'h1');
  createSupervisor({ repoRoot: root }).tick();
  assert.deepEqual(pendingAttention(paths).filter((a) => a.kind === 'claim-run'), [], 'restart does not recreate a host card');
  status.awaitingStage = 'coder'; status.handoffId = 'h2';
  writeStatus(runPaths, status);
  supervisor.tick();
  assert.deepEqual(pendingAttention(paths).filter((a) => a.kind === 'claim-run'), []);
  assert.equal(poolSnapshotClaim(paths), 'h2');
  status.overall = 'done';
  writeStatus(runPaths, status);
  supervisor.tick();
  assert.equal(pendingAttention(paths).filter((a) => a.kind === 'claim-run').length, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a retry archives the previous halted attempt alert', () => {
  const { root, paths } = tmpRepo();
  compile(paths);
  const rm = readRoadmap(paths);
  rm.features[0].status = 'planning';
  const runId = '20260912T000000Z-F1-plan-halted';
  rm.features[0].specRunId = runId;
  writeRoadmap(paths, rm);
  const runPaths = pipelinePaths(root, { runId });
  fs.mkdirSync(runPaths.dir, { recursive: true });
  const status = newStatus('old attempt'); status.overall = 'halted'; status.haltReason = 'MISSING_ARTIFACT';
  writeStatus(runPaths, status);
  writeRunMeta(runPaths, { runId, featureId: 'F1', kind: 'plan', runner: 'host' });
  const alert = appendAttention(paths, { kind: 'halted', runId, featureId: 'F1', summary: 'Old failure' });
  createSupervisor({ repoRoot: root }).tick();
  assert.ok(!pendingAttention(paths).some((item) => item.id === alert.id));
  assert.ok(readAttention(paths).some((item) => item.type === 'ack' && item.ackOf === alert.id));
  fs.rmSync(root, { recursive: true, force: true });
});

test('historical report rebuild preserves the old report and indexes every recorded run', async () => {
  const { root, paths } = tmpRepo();
  compile(paths);
  const rm = readRoadmap(paths);
  const feature = rm.features[0];
  feature.status = 'accepted'; feature.specRunId = 'run-plan'; feature.integrationRunId = 'run-integration';
  feature.tickets = [{ id: 'T9', title: 'Old ticket', status: 'completed', runId: 'run-virtual' }];
  feature.reportRel = '.pipeline/control/reports/F1/work-done.html';
  writeRoadmap(paths, rm);
  for (const [runId, kind, stage] of [['run-plan', 'plan', 'planner'], ['run-integration', 'integration', 'reporter']]) {
    const runPaths = pipelinePaths(root, { runId });
    fs.mkdirSync(runPaths.reports, { recursive: true });
    const status = newStatus(runId); status.runId = runId; status.featureId = 'F1'; status.overall = 'done';
    status.stages.find((item) => item.name === stage).status = 'passed';
    writeStatus(runPaths, status);
    writeRunMeta(runPaths, { runId, featureId: 'F1', kind, runner: 'host' });
    if (kind === 'integration') {
      fs.writeFileSync(path.join(runPaths.reports, 'work-done.html'), 'old integration report');
      fs.writeFileSync(runPaths.reporterDoc, '## Summary\n\nThe feature completed.\n');
    }
  }
  const controlReport = path.join(paths.controlReports, 'F1');
  fs.mkdirSync(controlReport, { recursive: true });
  fs.writeFileSync(path.join(controlReport, 'work-done.html'), 'old feature report');
  assert.equal(await poolCli(['reports', 'rebuild'], { cwd: root }), 0);
  assert.equal(fs.readFileSync(path.join(controlReport, 'work-done.legacy.html'), 'utf8'), 'old feature report');
  const index = JSON.parse(fs.readFileSync(path.join(controlReport, 'report.json'), 'utf8'));
  assert.deepEqual(index.relatedRuns.map((item) => item.runId).sort(), ['run-integration', 'run-plan', 'run-virtual']);
  assert.match(fs.readFileSync(path.join(controlReport, 'work-done.html'), 'utf8'), /data-run-id="run-plan" data-stage="planner"/);
  const planReport = path.join(pipelinePaths(root, { runId: 'run-plan' }).reports, 'work-done.html');
  assert.match(fs.readFileSync(planReport, 'utf8'), /data-run-id="run-plan" data-stage="planner"/);
  assert.equal(fs.readFileSync(path.join(pipelinePaths(root, { runId: 'run-integration' }).reports, 'work-done.legacy.html'), 'utf8'), 'old integration report');
  assert.match(fs.readFileSync(path.join(paths.control, 'report-rebuilds.jsonl'), 'utf8'), /"runId":"run-plan"/);
  assert.equal(fs.existsSync(pipelinePaths(root, { runId: 'run-virtual' }).dir), false);
  assert.equal(readRoadmap(paths).features[0].reportRel, '.pipeline/control/reports/F1/work-done.html');
  assert.match(fs.readFileSync(path.join(paths.control, 'report-rebuilds.jsonl'), 'utf8'), /"outcome":"rebuilt"/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('obsolete approval gates are recorded as superseded instead of staying open', () => {
  const { root, paths } = tmpRepo();
  compile(paths);
  const rm = readRoadmap(paths);
  rm.features[0].status = 'held';
  writeRoadmap(paths, rm);
  const runId = '20260912T000000Z-F1-plan-abcd';
  const runPaths = pipelinePaths(root, { runId });
  fs.mkdirSync(runPaths.dir, { recursive: true });
  const status = newStatus('plan'); status.overall = 'done';
  writeStatus(runPaths, status);
  writeRunMeta(runPaths, { runId, featureId: 'F1', kind: 'plan', runner: 'host' });
  const plan = openDecision(paths, { runId, featureId: 'F1', kind: 'plan-approval', question: 'Approve old plan?' });
  const merge = openDecision(paths, { runId, featureId: 'F1', kind: 'merge-approval', question: 'Merge old work?' });
  createSupervisor({ repoRoot: root }).tick();
  const records = readDecisions(paths);
  assert.deepEqual([plan.id, merge.id].map((id) => records.find((row) => row.decisionId === id).decision), ['superseded', 'superseded']);
  fs.rmSync(root, { recursive: true, force: true });
});

function poolSnapshotClaim(paths) {
  const state = JSON.parse(fs.readFileSync(paths.snapshot, 'utf8'));
  return state.agentQueue?.current?.handoffId;
}

test('an external-CLI pool worker is always spawned with --mode cli, never left to env-heuristics', () => {
  const { root, paths } = tmpRepo();
  // Opt this feature into a real, unattended agent CLI (the pattern documented
  // in roadmap.md's own `- runner:` bullet) rather than the default host/auto.
  const roadmapMd = fs.readFileSync(paths.roadmapMd, 'utf8').replace('- depends_on: none', '- depends_on: none\n- runner: cursor');
  fs.writeFileSync(paths.roadmapMd, roadmapMd);
  compile(paths);
  const spawned = [];
  const sup = createSupervisor({
    repoRoot: root,
    spawn: (_bin, args) => { spawned.push(args); return { pid: 4242, unref() {} }; },
    spawnSync: () => { throw new Error('a cursor worker must never take the host spawnSync branch'); },
  });
  sup.tick();
  assert.ok(spawned.length >= 1);
  const args = spawned[0];
  assert.equal(args[args.indexOf('--mode') + 1], 'cli', 'an external-CLI runner is always --mode cli, never left unset for env to guess');
  assert.equal(args[args.indexOf('--runner') + 1], 'cursor');
  const runId = args[args.indexOf('--run-id') + 1];
  const meta = JSON.parse(fs.readFileSync(pipelinePaths(root, { runId }).runMeta, 'utf8'));
  assert.equal(meta.executionSurface, 'cli-subprocess');
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
  assert.ok(fs.existsSync(path.join(pipelinePaths(root, { runId }).reports, 'work-done.html')));
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

test('a moved roadmap target starts combined validation and requires a fresh approval', () => {
  const { root, paths } = tmpRepo();
  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.test', ...args], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  compile(paths);
  const base = git('rev-parse', 'HEAD');
  git('checkout', '-b', 'pipeline/combined');
  fs.writeFileSync(path.join(root, 'feature.txt'), 'accepted work');
  git('add', 'feature.txt'); git('commit', '-qm', 'feature');
  const inputHead = git('rev-parse', 'HEAD');
  git('checkout', 'main');
  fs.writeFileSync(path.join(root, 'target.txt'), 'new target work');
  git('add', 'target.txt'); git('commit', '-qm', 'target moved');
  const target = git('rev-parse', 'HEAD');
  const spec = pipelinePaths(root, { runId: 'spec-fixture' });
  fs.mkdirSync(spec.dir, { recursive: true });
  fs.writeFileSync(spec.specs, '# Specification\nKeep the accepted feature and verify the combined target.');
  let rm = readRoadmap(paths);
  rm = { ...rm, review: 'end', workingBranch: 'pipeline/combined', workingSha: inputHead,
    validatedTarget: base, roadmapStatus: 'merge_approved', mergeApproval: { head: inputHead, target: base },
    features: rm.features.map(f => ({ ...f, status: 'accepted', specRunId: 'spec-fixture' })) };
  writeRoadmap(paths, rm);
  const spawned = [];
  const sup = createSupervisor({ repoRoot: root, spawnSync: (_bin, args) => {
    spawned.push(args);
    const runId = args[args.indexOf('--run-id') + 1];
    const p = pipelinePaths(root, { runId });
    const status = newStatus('Revalidate');
    status.overall = 'awaiting_chat'; status.awaitingStage = 'tester';
    writeStatus(p, status);
    return { status: 0 };
  } });
  sup.tick();
  rm = readRoadmap(paths);
  assert.equal(spawned.length, 1);
  assert.equal(rm.roadmapStatus, 'running');
  assert.equal(rm.mergeApproval, null);
  assert.equal(rm.finalValidation.target, target);
  assert.equal(git('rev-parse', 'main'), target, 'validation must not land without approval');
  const p = pipelinePaths(root, { runId: rm.finalValidation.runId });
  assert.equal(fs.readFileSync(path.join(p.worktree, 'feature.txt'), 'utf8'), 'accepted work');
  assert.equal(fs.readFileSync(path.join(p.worktree, 'target.txt'), 'utf8'), 'new target work');
  const done = newStatus('Revalidated'); done.overall = 'done'; done.verdict = 'APPROVED';
  writeStatus(p, done);
  sup.tick();
  rm = readRoadmap(paths);
  assert.equal(rm.finalValidation.state, 'approved');
  assert.equal(rm.roadmapStatus, 'awaiting_final_review');
  assert.equal(rm.validatedTarget, target);
  assert.equal(rm.mergeApproval, null);
  assert.equal(git('rev-parse', 'main'), target);
  assert.equal(rm.workingSha, git('rev-parse', 'pipeline/combined'));
  fs.rmSync(root, { recursive: true, force: true });
});
