// File-backed transactions. The fsynced journal is authoritative; the snapshot
// is a replaceable cache. A command id always returns the same recorded result.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicWrite, acquireLockFile } from './state.mjs';

export function readJournal(file) {
  let text; try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const lines = text.split('\n'), out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    try { out.push(JSON.parse(lines[i])); }
    catch { if (i !== lines.length - 1) throw new Error(`Corrupt journal ${path.basename(file)} at line ${i + 1}`); }
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
    const state = commandState(dir, name);
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ command, input })).digest('hex');
    if (state.receipts[commandId]) {
      const receipt = state.receipts[commandId];
      if (receipt.fingerprint !== fingerprint) throw new Error('commandId was already used for different input.');
      return receipt.result;
    }
    if (expectedRevision != null && expectedRevision !== state.revision) throw new Error(`Stale revision; expected ${state.revision}.`);
    const result = mutate(state) ?? { ok: true };
    state.revision++;
    const response = { ...result, revision: state.revision, commandId };
    state.receipts[commandId] = { fingerprint, result: response };
    const journal = path.join(dir, `${name}.journal.jsonl`);
    // Discard only an incomplete final write, never a malformed committed row.
    if (fs.existsSync(journal)) {
      const raw = fs.readFileSync(journal);
      if (raw.length && raw.at(-1) !== 10) fs.truncateSync(journal, raw.lastIndexOf(10) + 1);
    }
    const fd = fs.openSync(journal, 'a', 0o600);
    try { fs.writeSync(fd, JSON.stringify({ at: new Date().toISOString(), command, commandId, state }) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    atomicWrite(path.join(dir, `${name}.json`), JSON.stringify(state));
    fs.chmodSync(path.join(dir, `${name}.json`), 0o600);
    return response;
  } finally { fs.unlinkSync(lock); }
}
