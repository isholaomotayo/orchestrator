import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipelinePaths } from './state.mjs';
import {
  classifyRun, classifyEvent, DEFAULT_THRESHOLDS,
  appendAttention, readAttention, pendingAttention, ackAttention,
  openDecision, resolveDecision, readDecisions, openDecisions,
} from './attention.mjs';

const T = DEFAULT_THRESHOLDS;
const now = Date.parse('2026-09-06T12:00:00Z');
const ago = (ms) => new Date(now - ms).toISOString();

function tmpControl() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attn-'));
  return pipelinePaths(root);
}

// ---- classifyRun: the busy-state contract ----------------------------------

test('a live pid with a running status and fresh output is busy', () => {
  const state = classifyRun({
    status: { overall: 'running' }, pidAlive: true,
    lastOutputAt: ago(1000), lastVerb: { verb: 'working' }, now,
  }, T);
  assert.equal(state, 'busy');
});

test('a finished run is idle, not busy', () => {
  for (const overall of ['done', 'halted']) {
    assert.equal(classifyRun({ status: { overall }, pidAlive: false, lastOutputAt: ago(1000), now }, T), 'idle');
  }
});

test('a run whose process is gone while still marked running is dead', () => {
  assert.equal(classifyRun({ status: { overall: 'running' }, pidAlive: false, lastOutputAt: ago(1000), now }, T), 'dead');
});

test('missing or unreadable state is unknown and is never promoted to busy', () => {
  assert.equal(classifyRun({ status: null, pidAlive: false, lastOutputAt: null, now }, T), 'unknown');
  // A live pid alone does not prove work is happening.
  assert.equal(classifyRun({ status: null, pidAlive: true, lastOutputAt: null, now }, T), 'unknown');
});

test('a run parked at a gate is awaiting, not busy and not dead', () => {
  const state = classifyRun({
    status: { overall: 'awaiting_plan_approval' }, pidAlive: false,
    lastOutputAt: ago(60_000), lastVerb: { verb: 'needs-decision' }, now,
  }, T);
  assert.equal(state, 'awaiting');
});

test('a busy run that has produced nothing for a long time is stale', () => {
  const state = classifyRun({
    status: { overall: 'running' }, pidAlive: true,
    lastOutputAt: ago(T.staleAfterMs + 1000), lastVerb: { verb: 'working' }, now,
  }, T);
  assert.equal(state, 'stale');
});

// ---- classifyEvent: what reaches a human -----------------------------------

const base = { runId: 'r1', featureId: 'F1' };

test('a run reaching a decision gate escalates', () => {
  const ev = classifyEvent({
    ...base,
    previous: { state: 'busy', verb: 'working' },
    current: { state: 'awaiting', verb: 'needs-decision', detail: 'plan-approval', status: { overall: 'awaiting_plan_approval' } },
    now,
  }, T);
  assert.equal(ev.escalate, true);
  assert.equal(ev.kind, 'plan-approval');
});

test('a blocked run escalates and names why', () => {
  const ev = classifyEvent({
    ...base,
    previous: { state: 'busy', verb: 'working' },
    current: { state: 'awaiting', verb: 'blocked', detail: 'merge-conflict T2', status: { overall: 'running' } },
    now,
  }, T);
  assert.equal(ev.escalate, true);
  assert.equal(ev.kind, 'blocked');
  assert.match(ev.summary, /merge-conflict/);
});

test('a halted run escalates as a failure', () => {
  const ev = classifyEvent({
    ...base,
    previous: { state: 'busy', verb: 'working' },
    current: { state: 'idle', verb: 'failed', detail: 'MAX_CYCLES', status: { overall: 'halted', haltReason: 'MAX_CYCLES' } },
    now,
  }, T);
  assert.equal(ev.escalate, true);
  assert.equal(ev.kind, 'halted');
  assert.match(ev.summary, /MAX_CYCLES/);
});

test('ordinary progress is self-handled and never wakes anyone', () => {
  const ev = classifyEvent({
    ...base,
    previous: { state: 'busy', verb: 'working' },
    current: { state: 'busy', verb: 'working', detail: 'coder cycle 2', status: { overall: 'running' } },
    now,
  }, T);
  assert.equal(ev, null);
});

test('a successful finish is recorded but does not demand attention', () => {
  const ev = classifyEvent({
    ...base,
    previous: { state: 'busy', verb: 'working' },
    current: { state: 'idle', verb: 'done', detail: 'APPROVED', status: { overall: 'done', verdict: 'APPROVED' } },
    now,
  }, T);
  assert.equal(ev.kind, 'done');
  assert.equal(ev.escalate, false);
});

test('a dead process is escalated so a lost worker cannot go unnoticed', () => {
  const ev = classifyEvent({
    ...base,
    previous: { state: 'busy', verb: 'working' },
    current: { state: 'dead', verb: 'working', status: { overall: 'running' } },
    now,
  }, T);
  assert.equal(ev.kind, 'dead');
  assert.equal(ev.escalate, true);
});

test('staleness escalates only after the escalation threshold, not on first sight', () => {
  const stale = { state: 'stale', verb: 'working', status: { overall: 'running' } };
  const first = classifyEvent({ ...base, previous: { state: 'busy', verb: 'working' }, current: stale, staleSince: ago(1000), now }, T);
  assert.equal(first, null, 'a brief quiet spell is not news');
  const later = classifyEvent({ ...base, previous: { state: 'stale', verb: 'working' }, current: stale, staleSince: ago(T.staleEscalateMs + 1000), now }, T);
  assert.equal(later.kind, 'stale');
  assert.equal(later.escalate, true);
});

test('an unchanged escalated state does not re-escalate on every tick', () => {
  const awaiting = { state: 'awaiting', verb: 'needs-decision', detail: 'plan-approval', status: { overall: 'awaiting_plan_approval' } };
  const ev = classifyEvent({ ...base, previous: { state: 'awaiting', verb: 'needs-decision' }, current: awaiting, now }, T);
  assert.equal(ev, null);
});

test('a declared pause resurfaces only after the recheck window', () => {
  const paused = { state: 'awaiting', verb: 'paused', detail: 'waiting for CI', status: { overall: 'running' } };
  const soon = classifyEvent({ ...base, previous: { state: 'awaiting', verb: 'paused' }, current: paused, verbSince: ago(1000), now }, T);
  assert.equal(soon, null);
  const later = classifyEvent({ ...base, previous: { state: 'awaiting', verb: 'paused' }, current: paused, verbSince: ago(T.pauseResurfaceMs + 1000), now }, T);
  assert.equal(later.kind, 'paused');
  assert.equal(later.escalate, true);
});

test('an unrecognised state fails safe by escalating', () => {
  const ev = classifyEvent({
    ...base,
    previous: { state: 'busy', verb: 'working' },
    current: { state: 'unknown', verb: null, status: null },
    now,
  }, T);
  assert.equal(ev.escalate, true);
});

// ---- attention queue -------------------------------------------------------

test('attention items round-trip, and acknowledging one clears it from pending', () => {
  const paths = tmpControl();
  const a = appendAttention(paths, { runId: 'r1', kind: 'blocked', summary: 'needs a decision' });
  appendAttention(paths, { runId: 'r2', kind: 'done', summary: 'finished' });
  assert.equal(pendingAttention(paths).length, 2);
  ackAttention(paths, a.id);
  const pending = pendingAttention(paths);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].runId, 'r2');
  // The record itself survives: the queue is an append-only history.
  assert.equal(readAttention(paths).length, 3);
  fs.rmSync(paths.root, { recursive: true, force: true });
});

test('acknowledging an unknown item is a no-op rather than an error', () => {
  const paths = tmpControl();
  assert.doesNotThrow(() => ackAttention(paths, 'nope'));
  fs.rmSync(paths.root, { recursive: true, force: true });
});

test('a corrupt line in the queue is skipped rather than poisoning the read', () => {
  const paths = tmpControl();
  appendAttention(paths, { runId: 'r1', kind: 'blocked', summary: 's' });
  fs.appendFileSync(paths.attention, 'not json\n');
  assert.equal(pendingAttention(paths).length, 1);
  fs.rmSync(paths.root, { recursive: true, force: true });
});

// ---- decision ledger -------------------------------------------------------

test('a decision stays open until it is explicitly resolved', () => {
  const paths = tmpControl();
  const d = openDecision(paths, {
    runId: 'r1', featureId: 'F1', kind: 'plan-approval', stage: 'planner',
    question: 'Approve the plan?', options: ['approve', 'revise'], recommended: 'approve',
  });
  assert.equal(openDecisions(paths).length, 1);
  // Re-reading does not clear it: only an answer does.
  assert.equal(openDecisions(paths).length, 1);
  resolveDecision(paths, d.id, { decision: 'approve', by: 'operator', via: 'chat' });
  assert.equal(openDecisions(paths).length, 0);
  const all = readDecisions(paths);
  assert.equal(all.length, 1);
  assert.equal(all[0].status, 'resolved');
  assert.equal(all[0].decision, 'approve');
  fs.rmSync(paths.root, { recursive: true, force: true });
});

test('the ledger is append-only: state is the last record per decision', () => {
  const paths = tmpControl();
  const d = openDecision(paths, { runId: 'r1', kind: 'blocked', question: 'q', options: [] });
  resolveDecision(paths, d.id, { decision: 'retry', by: 'operator', via: 'dashboard' });
  const raw = fs.readFileSync(paths.decisions, 'utf8').trim().split('\n');
  assert.equal(raw.length, 2, 'the opening record must not be rewritten');
  fs.rmSync(paths.root, { recursive: true, force: true });
});

test('resolving an already-resolved decision is refused', () => {
  const paths = tmpControl();
  const d = openDecision(paths, { runId: 'r1', kind: 'blocked', question: 'q', options: [] });
  resolveDecision(paths, d.id, { decision: 'a', by: 'operator', via: 'chat' });
  assert.throws(() => resolveDecision(paths, d.id, { decision: 'b', by: 'operator', via: 'chat' }), /already resolved/i);
  fs.rmSync(paths.root, { recursive: true, force: true });
});

test('resolving an unknown decision is refused', () => {
  const paths = tmpControl();
  assert.throws(() => resolveDecision(paths, 'nope', { decision: 'a', by: 'operator', via: 'chat' }), /unknown decision/i);
  fs.rmSync(paths.root, { recursive: true, force: true });
});
