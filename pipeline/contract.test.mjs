// The v1 payloads the server emits must match pipeline/contract/v1/*.schema.json,
// which the desktop client is built against. A tiny validator covering the
// subset the schemas use (type, enum, required, properties, items) keeps the
// engine dependency-free.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runSummary, createCommandExecutor } from './api-v1.mjs';

const load = (name) => JSON.parse(fs.readFileSync(new URL(`./contract/v1/${name}.schema.json`, import.meta.url), 'utf8'));

function typeOf(v) { return v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v; }

export function validate(schema, value, at = '$') {
  const errors = [];
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${at}: ${JSON.stringify(value)} not in ${JSON.stringify(schema.enum)}`);
  if (schema.type) {
    const types = [].concat(schema.type);
    if (!types.includes(typeOf(value))) errors.push(`${at}: expected ${types.join('|')}, got ${typeOf(value)}`);
  }
  if (typeOf(value) === 'object') {
    for (const key of schema.required || []) if (!(key in value)) errors.push(`${at}: missing ${key}`);
    for (const [key, sub] of Object.entries(schema.properties || {})) if (key in value) errors.push(...validate(sub, value[key], `${at}.${key}`));
  }
  if (typeOf(value) === 'array' && schema.items) value.forEach((item, i) => errors.push(...validate(schema.items, item, `${at}[${i}]`)));
  return errors;
}

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
