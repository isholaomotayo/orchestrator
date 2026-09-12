import test from 'node:test';
import assert from 'node:assert/strict';
import { runBucket, BUCKET_LABEL, ageMs, formatAge, allRuns, filterRuns, hostLabel } from './runs.mjs';

// ---- runBucket --------------------------------------------------------------

test('runBucket maps the run-state axes onto the six overview buckets', () => {
  assert.equal(runBucket({ state: 'busy' }), 'executing');
  assert.equal(runBucket({ state: 'stale' }), 'executing');
  assert.equal(runBucket({ state: 'awaiting', owner: null }), 'awaiting-agent');
  assert.equal(runBucket({ state: 'awaiting', owner: { capability: 'disconnected' } }), 'disconnected');
  assert.equal(runBucket({ state: 'dead' }), 'blocked');
  assert.equal(runBucket({ state: 'unknown' }), 'blocked');
  assert.equal(runBucket({ overall: 'halted', state: 'idle' }), 'blocked');
  assert.equal(runBucket({ overall: 'done', state: 'idle' }), 'done');
  assert.equal(runBucket({ state: 'queued' }), 'unknown');
});

test('runBucket prefers busy over a stale disconnected owner — a run cannot be two things at once', () => {
  // Defensive: a real run never has state:'busy' and a disconnected owner
  // together, but the precedence should still be deterministic if it did.
  assert.equal(runBucket({ state: 'busy', owner: { capability: 'disconnected' } }), 'executing');
});

test('runBucket recognizes a finished run before consulting a stale owner flag', () => {
  // A run that finished can still carry a leftover owner from before it did
  // (the bridge owner record doesn't get cleared just because the run is
  // over) — that owner must not override the finished classification.
  assert.equal(runBucket({ overall: 'done', state: 'idle', owner: { capability: 'disconnected' } }), 'done');
  assert.equal(runBucket({ overall: 'halted', state: 'idle', owner: { capability: 'disconnected' } }), 'blocked');
});

test('runBucket only ever returns one of the six labeled buckets', () => {
  const samples = [
    {}, { state: 'busy' }, { state: 'stale' }, { state: 'awaiting' },
    { state: 'awaiting', owner: { capability: 'disconnected' } },
    { state: 'dead' }, { state: 'unknown' }, { state: 'idle' }, { state: 'queued' },
    { overall: 'done' }, { overall: 'halted' },
  ];
  for (const run of samples) {
    assert.ok(Object.hasOwn(BUCKET_LABEL, runBucket(run)), `runBucket(${JSON.stringify(run)}) must be a known bucket`);
  }
});

// ---- age formatting ----------------------------------------------------------

test('ageMs is null for a missing or unparseable timestamp', () => {
  assert.equal(ageMs(null), null);
  assert.equal(ageMs('not a date'), null);
});

test('ageMs measures against the given now, not wall-clock time', () => {
  assert.equal(ageMs('2026-01-01T00:00:00Z', Date.parse('2026-01-01T00:00:10Z')), 10000);
});

test('formatAge buckets into just-now / minutes / hours / days', () => {
  assert.equal(formatAge(null), '—');
  assert.equal(formatAge(30_000), 'just now');
  assert.equal(formatAge(5 * 60_000), '5m');
  assert.equal(formatAge(3 * 3600_000), '3h');
  assert.equal(formatAge(2 * 86400_000), '2d');
});

// ---- allRuns ------------------------------------------------------------------

test('allRuns merges a pool snapshot’s in-progress and historical runs', () => {
  const pool = { inProgress: [{ runId: 'r1' }], history: [{ runId: 'r2' }] };
  assert.deepEqual(allRuns(pool, []).map((r) => r.runId), ['r1', 'r2']);
});

test('allRuns falls back to the single-run list, normalized to the pool shape', () => {
  const singleRunList = [{
    id: 'abc', featureId: null, ticketId: null, runner: 'claude', hostClient: null, invocationMode: 'cli', runnerRequested: null,
    overall: 'done', live: false, startedAt: '2026-01-01T00:00:00Z', reportRel: 'x', task: 'Fix the thing',
  }];
  const runs = allRuns(null, singleRunList);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].runId, 'abc');
  assert.equal(runs[0].runner, 'claude');
  assert.equal(runs[0].hostClient, null);
  assert.equal(runs[0].invocationMode, 'cli');
  assert.equal(runs[0].state, 'idle');
  assert.equal(runs[0].title, 'Fix the thing');
});

// ---- hostLabel ------------------------------------------------------------

test('hostLabel shows the IDE host for a chat-driven run, in either mode', () => {
  assert.equal(hostLabel({ invocationMode: 'chat', hostClient: 'antigravity', runner: 'host' }), 'chat: antigravity');
  assert.equal(hostLabel({ invocationMode: 'chat', hostClient: null, runner: 'host' }), 'chat', 'no host name recorded yet is still "chat", not blank');
});

test('hostLabel shows the runner for a cli-subprocess run, in either mode', () => {
  assert.equal(hostLabel({ invocationMode: 'cli', runner: 'codex', hostClient: null }), 'cli: codex');
});

test('hostLabel falls back to the raw runner/hostClient for a run recorded before mode-tracking existed', () => {
  assert.equal(hostLabel({ runner: 'claude' }), 'claude');
  assert.equal(hostLabel({ hostClient: 'cursor' }), 'cursor');
  assert.equal(hostLabel({}), '—');
});

test('allRuns treats a live single run as busy', () => {
  const runs = allRuns(null, [{ id: 'abc', live: true }]);
  assert.equal(runs[0].state, 'busy');
});

// ---- filterRuns ---------------------------------------------------------------

const RUNS = [
  { runId: 'r1', featureId: 'F1', runner: 'claude', state: 'busy', ticketId: 'T1', spawnedAt: '2020-01-01T00:00:00Z' },
  { runId: 'r2', featureId: 'F2', runner: 'codex', state: 'awaiting', owner: null, ticketId: 'T2', spawnedAt: new Date().toISOString() },
];

test('filterRuns with no filter returns everything', () => {
  assert.equal(filterRuns(RUNS, {}).length, 2);
});

test('filterRuns narrows by feature, host, and bucket independently', () => {
  assert.deepEqual(filterRuns(RUNS, { feature: 'F1' }).map((r) => r.runId), ['r1']);
  assert.deepEqual(filterRuns(RUNS, { host: 'codex' }).map((r) => r.runId), ['r2']);
  assert.deepEqual(filterRuns(RUNS, { bucket: 'awaiting-agent' }).map((r) => r.runId), ['r2']);
});

test('filterRuns treats olderThanH as a minimum age, not a maximum', () => {
  assert.deepEqual(filterRuns(RUNS, { olderThanH: '1' }).map((r) => r.runId), ['r1']);
});

test('filterRuns does not exclude a run with an unknown spawn time from an age filter', () => {
  const runs = [...RUNS, { runId: 'r3', featureId: 'F3', runner: 'claude', state: 'busy', ticketId: 'T3', spawnedAt: null }];
  assert.deepEqual(filterRuns(runs, { olderThanH: '1' }).map((r) => r.runId), ['r1', 'r3']);
});

test('filterRuns searches both run id and ticket id, case-insensitively', () => {
  assert.deepEqual(filterRuns(RUNS, { q: 't2' }).map((r) => r.runId), ['r2']);
  assert.deepEqual(filterRuns(RUNS, { q: 'R1' }).map((r) => r.runId), ['r1']);
});

test('filterRuns composes multiple criteria as AND, not OR', () => {
  assert.deepEqual(filterRuns(RUNS, { feature: 'F1', host: 'codex' }), []);
});
