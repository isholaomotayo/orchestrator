// The v1 payloads the server builds must match pipeline/contract/v1/*.schema.json,
// which the desktop client is built against. ui-server.test.mjs checks the same
// schemas against what a live server sends.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runSummary, createCommandExecutor } from './api-v1.mjs';
import { loadSchema as load, validate } from './contract-schema.mjs';

test('RunSummary payloads match the published schema for every run shape', () => {
  const schema = load('run-summary');
  const shapes = [
    { overall: 'running', executionSurface: 'cli-subprocess', runner: 'claude', stages: [{ name: 'coder', status: 'running', cycle: 2, maxCycles: 5 }] },
    { overall: 'awaiting_chat', awaitingStage: 'planner', handoffId: 'h1', executionSurface: 'host-handoff', stages: [{ name: 'planner', status: 'awaiting_host', startedAt: new Date().toISOString() }] },
    { overall: 'awaiting_plan_approval', stages: [] },
    { overall: 'halted', haltReason: 'MAX_CYCLES', haltedPhase: 'coder', stages: [] },
    { overall: 'done', verdict: 'APPROVED', dismissed: true, stages: [] },
  ];
  for (const status of shapes) {
    const summary = runSummary({ runId: 'r', status, dir: null, engineAlive: status.overall === 'running' });
    assert.deepEqual(validate(schema, summary), [], status.overall);
  }
});

test('command results match the published schema', async () => {
  const schema = load('command');
  const execute = createCommandExecutor({ handlers: { 'run.dismiss': () => ({ ok: true }), 'run.resume': () => ({ error: 'nope', code: 409 }) } });
  for (const body of [
    { commandId: 'a', type: 'run.dismiss' }, { commandId: 'a', type: 'run.dismiss' },
    { commandId: 'b', type: 'run.resume' }, { commandId: 'c', type: 'bogus' },
  ]) assert.deepEqual(validate(schema, await execute(body)), [], JSON.stringify(body));
});
