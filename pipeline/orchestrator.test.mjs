// The orchestrator engine's own CLI flag wiring, exercised against the real
// binary rather than stubbed — specifically the chat-mode runner coercion
// (adapters.mjs's detectRunner/reconcileChatRunner) actually reaches
// status.json the way a real invocation would. A host-runner stage returns
// immediately (writes a chat handoff, no subprocess, no model API call), so
// these runs complete in well under a second with nothing external needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pipelinePaths } from './state.mjs';

const ENGINE = new URL('./orchestrator.mjs', import.meta.url).pathname;

function tmpRepo({ config = null } = {}) {
  // realpathSync matters here: os.tmpdir() resolves through a symlink on
  // macOS, and the spawned child's own process.cwd() (which pipelinePaths()
  // inside orchestrator.mjs is built from) reports the resolved path — so an
  // unresolved root here would make the parent and child compute two
  // different (but equivalent) .pipeline/ locations.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-')));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  spawnSync('git', ['config', 'user.name', 'test'], { cwd: root });
  spawnSync('git', ['config', 'user.email', 'test@example.test'], { cwd: root });
  fs.writeFileSync(path.join(root, 'README.md'), 'demo\n');
  spawnSync('git', ['add', '-A'], { cwd: root });
  spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: root });
  const paths = pipelinePaths(root);
  fs.mkdirSync(paths.prompts, { recursive: true });
  for (const stage of ['planner', 'plan_reviewer', 'designer', 'coder', 'tester', 'reviewer', 'handoff', 'reporter']) {
    fs.writeFileSync(path.join(paths.prompts, `${stage}_prompt.txt`), `prompt for ${stage}`);
  }
  if (config) fs.writeFileSync(paths.config, JSON.stringify(config));
  return { root, paths };
}

function readStatus(paths) {
  return JSON.parse(fs.readFileSync(paths.status, 'utf8'));
}

function run(root, args) {
  return spawnSync(process.execPath, [ENGINE, ...args], { cwd: root, encoding: 'utf8', timeout: 15000 });
}

function validSpec() {
  return [
    '# Specification', '', '## Objective', 'Deliver the requested module with a test.', '',
    '## Tracer-Bullet Tickets', 'Ticket 1 adds the module and verifies its public behavior.', '',
    '## Failure Modes', 'Missing input is rejected without changing repository state.', '',
    '## Acceptance', 'The baseline and new behavior must pass the repository test suite.', '',
  ].join('\n');
}

function planVerdict(verdict) {
  return [
    '# PLAN APPROVAL REVIEW', '', `## Verdict: ${verdict}`, '',
    '## Spec Coverage', 'The objective, ticket, acceptance check, and missing-input failure are addressed.', '',
    '## Risks and Evidence', 'The existing README and baseline test show this is an additive change.', '',
    '## Required Revisions', verdict === 'APPROVED' ? 'None.' : 'Name the exact public export and a boundary test.', '',
  ].join('\n');
}

test('a plan-only host run requires the Plan Approver verdict before it completes', () => {
  const { root, paths } = tmpRepo({ config: { bridge: { required: false } } });
  try {
    const started = run(root, ['--task', 'add a module', '--runner', 'host', '--mode', 'chat', '--plan-only', '--no-ui']);
    assert.equal(started.status, 0, started.stdout + started.stderr);
    assert.equal(readStatus(paths).awaitingStage, 'planner');
    fs.writeFileSync(paths.specs, validSpec());
    const planned = run(root, ['--continue', '--no-ui']);
    assert.equal(planned.status, 0, planned.stdout + planned.stderr);
    assert.equal(readStatus(paths).awaitingStage, 'plan_reviewer');
    assert.equal(readStatus(paths).planApproved, false);
    fs.writeFileSync(paths.planReview, planVerdict('APPROVED'));
    const reviewed = run(root, ['--continue', '--no-ui']);
    assert.equal(reviewed.status, 0, reviewed.stdout + reviewed.stderr);
    assert.equal(readStatus(paths).overall, 'done');
    assert.equal(readStatus(paths).planReviewVerdict, 'APPROVED');
    assert.equal(readStatus(paths).planApproved, true);
    assert.equal(fs.existsSync(path.join(paths.planReviews, 'pass-1.md')), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a blocked plan asks for a human decision with the review visible', () => {
  const { root, paths } = tmpRepo({ config: { bridge: { required: false } } });
  try {
    assert.equal(run(root, ['--task', 'add a module', '--runner', 'host', '--mode', 'chat', '--plan-only', '--no-ui']).status, 0);
    fs.writeFileSync(paths.specs, validSpec());
    assert.equal(run(root, ['--continue', '--no-ui']).status, 0);
    fs.writeFileSync(paths.planReview, planVerdict('BLOCK'));
    const blocked = run(root, ['--continue', '--no-ui']);
    assert.equal(blocked.status, 0, blocked.stdout + blocked.stderr);
    assert.equal(readStatus(paths).overall, 'awaiting_plan_approval');
    assert.equal(readStatus(paths).planReviewVerdict, 'BLOCK');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('--approve-plan adds a human gate after agent approval', () => {
  const { root, paths } = tmpRepo({ config: { bridge: { required: false } } });
  try {
    assert.equal(run(root, ['--task', 'add a module', '--runner', 'host', '--mode', 'chat', '--plan-only', '--approve-plan', '--no-ui']).status, 0);
    fs.writeFileSync(paths.specs, validSpec());
    assert.equal(run(root, ['--continue', '--no-ui']).status, 0);
    fs.writeFileSync(paths.planReview, planVerdict('APPROVED'));
    assert.equal(run(root, ['--continue', '--no-ui']).status, 0);
    assert.equal(readStatus(paths).overall, 'awaiting_plan_approval');
    assert.equal(readStatus(paths).planAgentApproved, true);
    assert.equal(run(root, ['--continue', '--no-ui']).status, 0);
    assert.equal(readStatus(paths).overall, 'done');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('requested plan changes return to Planner and require a fresh approval', () => {
  const { root, paths } = tmpRepo({ config: { bridge: { required: false } } });
  try {
    assert.equal(run(root, ['--task', 'add a module', '--runner', 'host', '--mode', 'chat', '--plan-only', '--no-ui']).status, 0);
    fs.writeFileSync(paths.specs, validSpec());
    assert.equal(run(root, ['--continue', '--no-ui']).status, 0);
    fs.writeFileSync(paths.planReview, planVerdict('REQUEST_CHANGES'));
    const revision = run(root, ['--continue', '--no-ui']);
    assert.equal(revision.status, 0, revision.stdout + revision.stderr);
    assert.equal(readStatus(paths).awaitingStage, 'planner');
    assert.match(JSON.parse(fs.readFileSync(paths.stageHandoff, 'utf8')).task, /Name the exact public export/);
    fs.writeFileSync(paths.specs, `${validSpec()}\nThe public export is moduleValue; a boundary test checks empty input.\n`);
    assert.equal(run(root, ['--continue', '--no-ui']).status, 0);
    assert.equal(readStatus(paths).awaitingStage, 'plan_reviewer');
    fs.writeFileSync(paths.planReview, planVerdict('APPROVED'));
    assert.equal(run(root, ['--continue', '--no-ui']).status, 0);
    assert.equal(readStatus(paths).overall, 'done');
    assert.equal(readStatus(paths).planReviewPass, 2);
    assert.match(fs.readFileSync(path.join(paths.planReviews, 'pass-1.md'), 'utf8'), /REQUEST_CHANGES/);
    assert.match(fs.readFileSync(path.join(paths.planReviews, 'pass-2.md'), 'utf8'), /APPROVED/);
    assert.doesNotMatch(fs.readFileSync(path.join(paths.planReviews, 'pass-1-specs.md'), 'utf8'), /moduleValue/);
    assert.match(fs.readFileSync(path.join(paths.planReviews, 'pass-2-specs.md'), 'utf8'), /moduleValue/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a fresh chat-mode run with a forced external runner coerces to host and records runnerRequested', () => {
  const { root, paths } = tmpRepo();
  const res = run(root, ['--task', 'do a thing', '--runner', 'cursor', '--mode', 'chat', '--host-client', 'antigravity']);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  const status = readStatus(paths);
  assert.equal(status.runner, 'host');
  assert.equal(status.runnerRequested, 'cursor');
  assert.equal(status.executionSurface, 'host-handoff');
  assert.equal(status.invocationMode, 'chat');
  assert.equal(status.hostClient, 'antigravity');
  assert.equal(status.overall, 'awaiting_chat');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a fresh chat-mode run with runner:"host" needs no coercion', () => {
  const { root, paths } = tmpRepo();
  const res = run(root, ['--task', 'do a thing', '--runner', 'host', '--mode', 'chat', '--host-client', 'antigravity']);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  const status = readStatus(paths);
  assert.equal(status.runner, 'host');
  assert.equal(status.runnerRequested, null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a fresh cli-mode run with an explicit --runner is untouched', () => {
  const { root, paths } = tmpRepo({ config: { customRunners: { fake: { command: process.execPath, args: ['-e', ''] } } } });
  // The no-op "fake" runner never produces specs.md, so the run legitimately
  // halts (MISSING_ARTIFACT, exit 1) — irrelevant to what this test checks,
  // which is only that `runner` was never coerced away from what was asked.
  const res = run(root, ['--task', 'do a thing', '--runner', 'fake', '--mode', 'cli']);
  assert.notEqual(res.status, null, res.stdout + res.stderr);
  const status = readStatus(paths);
  assert.equal(status.runner, 'fake');
  assert.equal(status.runnerRequested, null);
  assert.equal(status.executionSurface, 'cli-subprocess');
  assert.equal(status.invocationMode, 'cli');
  fs.rmSync(root, { recursive: true, force: true });
});

test('--continue self-heals a status.json baked with a mismatched runner+chat surface from before this fix', () => {
  const { root, paths } = tmpRepo();
  // The exact incident shape: a chat-mode run whose status.json recorded
  // runner:"cursor" alongside chat-mode metadata, from before this coercion
  // existed.
  fs.writeFileSync(paths.status, JSON.stringify({
    task: 'do a thing', overall: 'awaiting_chat', awaitingStage: 'planner',
    chatResume: { step: 'planner', context: {} },
    runner: 'cursor', invocationMode: 'chat', executionSurface: 'host-handoff',
    hostClient: 'cursor', bridgeRequired: false, verdict: null, haltReason: null, stages: [],
  }));
  const res = run(root, ['--continue']);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  const status = readStatus(paths);
  assert.equal(status.runner, 'host');
  assert.equal(status.runnerRequested, 'cursor');
  assert.equal(status.executionSurface, 'host-handoff');
  assert.equal(status.invocationMode, 'chat');
  fs.rmSync(root, { recursive: true, force: true });
});

test('--resume --runner <external> with --mode chat converges onto host even though the halted run was plain cli', () => {
  const { root, paths } = tmpRepo();
  fs.writeFileSync(paths.status, JSON.stringify({
    task: 'do a thing', overall: 'halted', haltReason: 'INTERRUPTED',
    runner: 'claude', invocationMode: 'cli', executionSurface: 'cli-subprocess',
    hostClient: null, verdict: null, stages: [],
  }));
  const res = run(root, ['--resume', '--runner', 'cursor', '--mode', 'chat']);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  const status = readStatus(paths);
  assert.equal(status.runner, 'host');
  assert.equal(status.runnerRequested, 'cursor');
  assert.equal(status.executionSurface, 'host-handoff');
  assert.equal(status.invocationMode, 'chat');
  fs.rmSync(root, { recursive: true, force: true });
});
