// File-backed transactions. The fsynced journal is authoritative; the snapshot
// is a replaceable cache. A command id always returns the same recorded result.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { acquireLockFile } from './state.mjs';

function syncDirectory(dir) {
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function durableWrite(file, contents, mode = 0o600) {
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w', mode);
  try { fs.writeFileSync(fd, contents); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  syncDirectory(path.dirname(file));
}
function appendRecord(dir, name, row) {
  const journal = path.join(dir, `${name}.journal.jsonl`);
  if (fs.existsSync(journal)) {
    const raw = fs.readFileSync(journal);
    if (raw.length && raw.at(-1) !== 10) fs.truncateSync(journal, raw.lastIndexOf(10) + 1);
  }
  const fd = fs.openSync(journal, 'a', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(row) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  syncDirectory(dir);
}
function projectRecord(dir, name, row) {
  if (!row?.writes?.length) return;
  for (const write of row.writes) {
    let current = null;
    try { current = fs.readFileSync(write.file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (current === write.contents) continue;
    if (current !== write.before) throw new Error(`Committed projection conflicts with ${write.file}; preserve the journal and reconcile before continuing.`);
    durableWrite(write.file, write.contents, write.mode);
  }
  // The applied marker is itself journaled. A missing/stale snapshot never
  // causes an old projection to overwrite a status that has since advanced.
  appendRecord(dir, name, { at: new Date().toISOString(), command: 'projection.applied', commandId: row.commandId, state: row.state });
}
export function recoverCommands(dir, name = 'bridge') {
  if (!readJournal(path.join(dir, `${name}.journal.jsonl`)).at(-1)?.writes?.length) return;
  const lock = path.join(dir, `${name}.lock`);
  if (!acquireLockFile(lock, { pid: process.pid })) throw new Error('Command busy; retry with the same commandId.');
  try { projectRecord(dir, name, readJournal(path.join(dir, `${name}.journal.jsonl`)).at(-1)); }
  finally { fs.unlinkSync(lock); }
}

export function readJournal(file) {
  let text; try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  // Only newline-terminated records are committed. Even valid JSON without
  // its delimiter may be a torn write and will be truncated before appending.
  const lines = text.slice(0, text.lastIndexOf('\n') + 1).split('\n'), out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    try { out.push(JSON.parse(lines[i])); }
    catch { throw new Error(`Corrupt journal ${path.basename(file)} at line ${i + 1}`); }
  }
  return out;
}
export function commandState(dir, name = 'bridge') {
  const rows = readJournal(path.join(dir, `${name}.journal.jsonl`));
  return rows.at(-1)?.state ?? { version: 2, revision: 0, sessions: {}, runs: {}, messages: [], receipts: {} };
}
export function transact(dir, command, input, mutate, { name = 'bridge', expectedRevision, commandId = crypto.randomUUID() } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, `${name}.lock`);
  if (!acquireLockFile(lock, { pid: process.pid, startedAt: new Date().toISOString() })) throw new Error('Command busy; retry with the same commandId.');
  try {
    projectRecord(dir, name, readJournal(path.join(dir, `${name}.journal.jsonl`)).at(-1));
    const state = commandState(dir, name);
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ command, input })).digest('hex');
    if (state.receipts[commandId]) {
      const receipt = state.receipts[commandId];
      if (receipt.fingerprint !== fingerprint) throw new Error('commandId was already used for different input.');
      return receipt.result;
    }
    if (expectedRevision != null && expectedRevision !== state.revision) throw new Error(`Stale revision; expected ${state.revision}.`);
    const writes = [];
    // Mutations stage file replacements; they must never publish status before
    // the journal commits. Recovery replays these writes under this same lock.
    const result = mutate(state, (file, contents) => {
      let before = null, mode = 0o600;
      try { before = fs.readFileSync(file, 'utf8'); mode = fs.statSync(file).mode & 0o777; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      writes.push({ file, before, contents, mode });
    }) ?? { ok: true };
    state.revision++;
    const response = { ...result, revision: state.revision, commandId };
    state.receipts[commandId] = { fingerprint, result: response };
    const row = { at: new Date().toISOString(), command, commandId, state, ...(writes.length ? { writes } : {}) };
    appendRecord(dir, name, row);
    try {
      projectRecord(dir, name, row);
      durableWrite(path.join(dir, `${name}.json`), JSON.stringify(state));
    } catch (error) {
      error.committed = true;
      throw error;
    }
    return response;
  } finally { fs.unlinkSync(lock); }
}
