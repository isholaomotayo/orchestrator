import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { transact, commandState, readJournal } from './commands.mjs';

test('the journal is compacted once it grows large, keeping state and recent receipts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-'));
  const blob = 'x'.repeat(8_000);
  let lastId = null;
  for (let i = 0; i < 200; i++) {
    lastId = `cmd-${i}`;
    transact(dir, 'note.add', { i }, (state) => {
      (state.notes ||= []).push({ i, blob });
      if (state.notes.length > 5) state.notes.shift();
      return { ok: true, i };
    }, { commandId: lastId });
  }
  const journal = path.join(dir, 'bridge.journal.jsonl');
  assert.ok(fs.statSync(journal).size < 2 * 1024 * 1024, `journal stayed bounded (${fs.statSync(journal).size} bytes)`);
  assert.ok(readJournal(journal).length < 200, 'older records were folded away');
  const state = commandState(dir);
  assert.equal(state.revision, 200);
  assert.equal(state.notes.at(-1).i, 199);
  // A retried recent command still returns its original result.
  const again = transact(dir, 'note.add', { i: 199 }, () => { throw new Error('must not re-run'); }, { commandId: lastId });
  assert.equal(again.i, 199);
  fs.rmSync(dir, { recursive: true, force: true });
});
