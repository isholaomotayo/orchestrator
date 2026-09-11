// The shared command layer other subsystems (the bridge, in particular)
// transact through: an append-only journal, exclusive locks, and idempotency
// keys. These tests exercise the layer in isolation, with no bridge semantics
// involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJournal, commandState, transact } from './commands.mjs';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'commands-'));
}

test('commandState starts from a fresh default when nothing has been recorded', () => {
  const dir = tmpDir();
  const state = commandState(dir);
  assert.equal(state.revision, 0);
  assert.deepEqual(state.sessions, {});
  assert.deepEqual(state.runs, {});
  assert.deepEqual(state.messages, []);
  assert.deepEqual(state.receipts, {});
});

test('readJournal returns an empty array for a file that does not exist yet', () => {
  assert.deepEqual(readJournal(path.join(tmpDir(), 'nope.journal.jsonl')), []);
});

test('a transaction mutates state, bumps the revision, and persists both the journal and the snapshot', () => {
  const dir = tmpDir();
  const result = transact(dir, 'widget.create', { name: 'a' }, (state) => {
    state.runs.a = { name: 'a' };
    return { created: 'a' };
  });
  assert.equal(result.created, 'a');
  assert.equal(result.revision, 1);
  assert.ok(result.commandId);

  const state = commandState(dir);
  assert.equal(state.revision, 1);
  assert.deepEqual(state.runs.a, { name: 'a' });

  const journal = readJournal(path.join(dir, 'bridge.journal.jsonl'));
  assert.equal(journal.length, 1);
  assert.equal(journal[0].command, 'widget.create');

  const snapshot = JSON.parse(fs.readFileSync(path.join(dir, 'bridge.json'), 'utf8'));
  assert.equal(snapshot.revision, 1);
});

test('repeated transactions accumulate against the same running state', () => {
  const dir = tmpDir();
  transact(dir, 'add', {}, (state) => { state.runs.count = 1; });
  transact(dir, 'add', {}, (state) => { state.runs.count = (state.runs.count || 0) + 1; });
  const state = commandState(dir);
  assert.equal(state.runs.count, 2);
  assert.equal(state.revision, 2);
});

test('replaying the same commandId with the same input returns the original result without mutating again', () => {
  const dir = tmpDir();
  let calls = 0;
  const mutate = (state) => { calls++; state.runs.n = (state.runs.n || 0) + 1; return { calls }; };
  const first = transact(dir, 'bump', { x: 1 }, mutate, { commandId: 'fixed-id' });
  const second = transact(dir, 'bump', { x: 1 }, mutate, { commandId: 'fixed-id' });
  assert.equal(calls, 1, 'mutate must not run twice for a replayed commandId');
  assert.deepEqual(second, first);
  assert.equal(commandState(dir).runs.n, 1);
});

test('reusing a commandId with different input is rejected rather than silently returning a stale result', () => {
  const dir = tmpDir();
  transact(dir, 'bump', { x: 1 }, (state) => { state.runs.n = 1; }, { commandId: 'fixed-id' });
  assert.throws(
    () => transact(dir, 'bump', { x: 2 }, () => {}, { commandId: 'fixed-id' }),
    /already used for different input/,
  );
});

test('an expected revision that no longer matches is refused', () => {
  const dir = tmpDir();
  transact(dir, 'first', {}, (state) => { state.runs.a = 1; });
  assert.throws(
    () => transact(dir, 'second', {}, () => {}, { expectedRevision: 0 }),
    /Stale revision; expected 1/,
  );
  // The correct expectation still goes through.
  const result = transact(dir, 'second', {}, (state) => { state.runs.b = 1; }, { expectedRevision: 1 });
  assert.equal(result.revision, 2);
});

test('a command that throws leaves no partial revision behind', () => {
  const dir = tmpDir();
  assert.throws(() => transact(dir, 'boom', {}, () => { throw new Error('nope'); }));
  assert.equal(commandState(dir).revision, 0);
  assert.equal(readJournal(path.join(dir, 'bridge.journal.jsonl')).length, 0);
});

test('a lock already held by a live process blocks a concurrent transaction', () => {
  const dir = tmpDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'bridge.lock'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  assert.throws(() => transact(dir, 'x', {}, () => {}), /Command busy/);
});

test('a lock left by a dead process is reclaimed rather than blocking forever', () => {
  const dir = tmpDir();
  fs.mkdirSync(dir, { recursive: true });
  // A pid this high is vanishingly unlikely to be alive.
  fs.writeFileSync(path.join(dir, 'bridge.lock'), JSON.stringify({ pid: 999999, startedAt: new Date().toISOString() }));
  const result = transact(dir, 'x', {}, (state) => { state.runs.ok = true; });
  assert.equal(result.revision, 1);
  assert.ok(!fs.existsSync(path.join(dir, 'bridge.lock')), 'the lock is released after the transaction');
});

test('a corrupt trailing line in the journal is discarded, not mistaken for a committed row', () => {
  const dir = tmpDir();
  transact(dir, 'first', {}, (state) => { state.runs.a = 1; });
  const journal = path.join(dir, 'bridge.journal.jsonl');
  fs.appendFileSync(journal, '{"incomplete": tr');
  const result = transact(dir, 'second', {}, (state) => { state.runs.b = 1; });
  assert.equal(result.revision, 2);
  const rows = readJournal(journal);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1].state.runs, { a: 1, b: 1 });
});

test('a corrupt row that is not the final line is a hard error, never silently skipped', () => {
  const dir = tmpDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'bridge.journal.jsonl'), 'not json\n{"at":"x","command":"y","state":{"revision":1}}\n');
  assert.throws(() => readJournal(path.join(dir, 'bridge.journal.jsonl')), /Corrupt journal/);
});

test('two independently named command logs in the same directory do not interfere', () => {
  const dir = tmpDir();
  transact(dir, 'a', {}, (state) => { state.runs.x = 1; }, { name: 'one' });
  transact(dir, 'b', {}, (state) => { state.runs.x = 2; }, { name: 'two' });
  assert.equal(commandState(dir, 'one').runs.x, 1);
  assert.equal(commandState(dir, 'two').runs.x, 2);
});

test('valid JSON without a trailing newline is not a committed receipt or state', () => {
  const dir = tmpDir();
  transact(dir, 'first', {}, state => { state.runs.count = 1; });
  const journal = path.join(dir, 'bridge.journal.jsonl');
  const row = readJournal(journal)[0];
  row.state.revision = 99;
  row.state.runs.count = 99;
  row.state.receipts.torn = { fingerprint: 'uncommitted', result: { ok: true } };
  fs.appendFileSync(journal, JSON.stringify(row));
  assert.equal(commandState(dir).revision, 1);
  assert.equal(commandState(dir).receipts.torn, undefined);
  transact(dir, 'second', {}, state => { state.runs.count++; });
  assert.equal(commandState(dir).runs.count, 2);
  assert.equal(readJournal(journal).length, 2);
});
