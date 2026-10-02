import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  bucketOf, driverOf, actionsFor, runSummary, createEventHub, createEventTail, createCommandExecutor, projectIdOf,
} from './api-v1.mjs';

const now = Date.parse('2026-10-02T12:00:00Z');
const ago = (ms) => new Date(now - ms).toISOString();

test('buckets: one vocabulary computed by the server', () => {
  assert.equal(bucketOf({ overall: 'done' }), 'done');
  assert.equal(bucketOf({ overall: 'halted' }), 'blocked');
  assert.equal(bucketOf({ overall: 'halted', dismissed: true }), 'done');
  assert.equal(bucketOf({ overall: 'awaiting_plan_approval' }), 'needs_you');
  assert.equal(bucketOf({ overall: 'running' }, { engineAlive: true }), 'working');
  assert.equal(bucketOf({ overall: 'running' }, { engineAlive: false }), 'blocked', 'a dead engine is not "working"');
  const parked = (startedAt) => ({ overall: 'awaiting_chat', awaitingStage: 'coder', stages: [{ name: 'coder', startedAt }] });
  assert.equal(bucketOf(parked(ago(60_000)), { now }), 'awaiting_agent');
  assert.equal(bucketOf(parked(ago(3_600_000)), { now }), 'unattended', 'an hour with nobody driving');
  assert.equal(bucketOf(parked(ago(3_600_000)), { now, driver: { kind: 'host-session' } }), 'agent_working');
});

test('driver presence distinguishes a working host session from nobody driving', () => {
  const status = { overall: 'awaiting_chat', hostClient: 'antigravity' };
  assert.equal(driverOf(status, { now }).presence, 'absent');
  const owner = { expiresAt: new Date(now + 60_000).toISOString(), lastActivityAt: ago(30_000), host: 'antigravity' };
  const d = driverOf(status, { owner, now });
  assert.equal(d.kind, 'host-session');
  assert.equal(d.presence, 'active');
  assert.equal(driverOf(status, { owner: { ...owner, lastActivityAt: ago(20 * 60_000) }, now }).presence, 'stalled');
  const cli = driverOf({ overall: 'running', executionSurface: 'cli-subprocess', runner: 'claude' }, { engineAlive: true, pid: 7, lastEventAt: ago(5 * 60_000), now });
  assert.deepEqual([cli.kind, cli.presence, cli.pid], ['cli-process', 'quiet', 7]);
});

test('actions carry the reason they are disabled, from the same recovery table as the engine', () => {
  const resumable = actionsFor({ overall: 'halted', haltReason: 'INTERRUPTED' });
  assert.equal(resumable.find((a) => a.id === 'run.resume').enabled, true);
  const blocked = actionsFor({ overall: 'halted', haltReason: 'REGRESSION_BLOCKED' }).find((a) => a.id === 'run.resume');
  assert.equal(blocked.enabled, false);
  assert.match(blocked.disabledReason, /human decision/);
  assert.ok(actionsFor({ overall: 'halted', haltReason: 'MAX_CYCLES', haltedPhase: 'coder' }).some((a) => a.id === 'run.extend'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v1-'));
  const cont = actionsFor({ overall: 'awaiting_chat', awaitingStage: 'planner', handoffId: 'h1' }, { dir }).find((a) => a.id === 'run.continue');
  assert.equal(cont.enabled, false, 'continue is disabled until the stage artifact exists');
  assert.equal(cont.params.handoffId, 'h1');
  assert.ok(actionsFor({ overall: 'running' }, { engineAlive: true }).some((a) => a.id === 'run.cancel' && a.enabled));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a run summary is self-describing', () => {
  const s = runSummary({ runId: 'r1', status: { overall: 'halted', haltReason: 'MISSING_ARTIFACT', task: '- **Goal:** Ship it\nmore', executionSurface: 'host-handoff', stages: [] }, dir: null, now });
  assert.equal(s.title, 'Ship it');
  assert.equal(s.surface, 'host');
  assert.equal(s.haltClass, 'recoverable');
  assert.equal(s.autonomy, 'guided');
});

function sink() {
  const chunks = [];
  return { write: (c) => chunks.push(c), text: () => chunks.join('') };
}

test('the event hub replays exactly what a reconnecting client missed', () => {
  const hub = createEventHub({ instanceId: 'i1' });
  hub.publish('run.upserted', { projectId: 'p', runId: 'a' });
  const first = sink();
  hub.attach(first);
  hub.publish('run.upserted', { projectId: 'p', runId: 'b' });
  const cursor = /id: (i1\.\d+)/.exec(first.text())[1];
  hub.publish('run.upserted', { projectId: 'p', runId: 'c' });
  const again = sink();
  hub.attach(again, { lastEventId: cursor });
  assert.match(again.text(), /"runId":"c"/);
  assert.doesNotMatch(again.text(), /"runId":"b"/);
  const other = sink();
  hub.attach(other, { lastEventId: 'old-instance.3' });
  assert.match(other.text(), /event: reset\ndata: \{"reason":"server_restarted"\}/);
});

test('the hub filters frames by subscribed project', () => {
  const hub = createEventHub({ instanceId: 'i2' });
  const only = sink();
  hub.attach(only, { projects: ['p1'] });
  hub.publish('run.upserted', { projectId: 'p2', runId: 'x' });
  hub.publish('run.upserted', { projectId: 'p1', runId: 'y' });
  assert.match(only.text(), /"runId":"y"/);
  assert.doesNotMatch(only.text(), /"runId":"x"/);
});

test('the event tail returns only new complete lines with stable seq numbers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tail-'));
  const file = path.join(dir, 'events.jsonl');
  const read = createEventTail();
  fs.writeFileSync(file, '{"type":"a"}\n{"type":"b"}\n{"type":"c"');
  assert.deepEqual(read(file).map((e) => [e.seq, e.event.type]), [[1, 'a'], [2, 'b']]);
  fs.appendFileSync(file, '}\n{"type":"d"}\n');
  assert.deepEqual(read(file).map((e) => [e.seq, e.event.type]), [[3, 'c'], [4, 'd']]);
  assert.deepEqual(read(file), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('commands are idempotent per commandId: a double click is a duplicate, not a second action', async () => {
  let calls = 0;
  const execute = createCommandExecutor({ handlers: { 'run.dismiss': async () => { calls++; return { ok: true }; } } });
  const first = await execute({ commandId: 'c1', type: 'run.dismiss', runId: 'r1' });
  const second = await execute({ commandId: 'c1', type: 'run.dismiss', runId: 'r1' });
  assert.equal(first.status, 'applied');
  assert.equal(second.status, 'duplicate');
  assert.equal(calls, 1);
  assert.equal((await execute({ commandId: 'c1', type: 'run.cancel', runId: 'r1' })).status, 'rejected');
  assert.equal((await execute({ commandId: 'c2', type: 'nope' })).error.code, 'unknown_command');
});

test('a project id is stable for the same directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pid-'));
  assert.equal(projectIdOf(dir), projectIdOf(path.join(dir, '.')));
  fs.rmSync(dir, { recursive: true, force: true });
});
