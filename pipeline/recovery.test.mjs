import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { bridgeCommand, commitCompletion, readBridge, recoverVerification } from './bridge.mjs';
import { commandState, readJournal, recoverCommands, transact } from './commands.mjs';
import { pipelinePaths } from './state.mjs';

const bridgeUrl = new URL('./bridge.mjs', import.meta.url).href;
const commandsUrl = new URL('./commands.mjs', import.meta.url).href;
const stateUrl = new URL('./state.mjs', import.meta.url).href;
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const p = pipelinePaths(root, { runId: 'r1' });
  fs.mkdirSync(p.dir, { recursive: true });
  const status = { overall: 'awaiting_chat', handoffId: 'h1', awaitingStage: 'coder', stages: [] };
  fs.writeFileSync(p.status, JSON.stringify(status));
  fs.writeFileSync(p.stageHandoff, JSON.stringify({ stage: 'coder' }));
  const { sessionId } = bridgeCommand('session.register', { project: root, host: 'codex', conversationId: 'crash-test' });
  const claim = bridgeCommand('run.claim', { project: root, runId: 'r1', sessionId });
  const credentials = { sessionId, leaseToken: claim.leaseToken, handoffId: 'h1' };
  return { root, p, status, credentials, next: { ...status, overall: 'done' } };
}

for (const point of ['before-journal', 'torn-journal', 'after-journal', 'after-status', 'after-marker']) {
  test(`SIGKILL at ${point} leaves completion recoverable and replayable`, t => {
    const f = fixture(t);
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      import { commitCompletion } from ${JSON.stringify(bridgeUrl)};
      const f = ${JSON.stringify(f)}, point = ${JSON.stringify(point)};
      const kill = () => process.kill(process.pid, 'SIGKILL');
      const open = fs.openSync, write = fs.writeFileSync, rename = fs.renameSync;
      let journalFd;
      fs.openSync = function(file, ...args) {
        if (String(file).endsWith('bridge.journal.jsonl') && args[0] === 'a') {
          if (point === 'before-journal') kill();
          journalFd = open.call(this, file, ...args); return journalFd;
        }
        return open.call(this, file, ...args);
      };
      fs.writeFileSync = function(file, contents, ...args) {
        if (file === journalFd && point === 'torn-journal') {
          write.call(this, file, String(contents).slice(0, 100)); kill();
        }
        return write.call(this, file, contents, ...args);
      };
      fs.renameSync = function(from, to) {
        if (to === f.p.status && point === 'after-journal') kill();
        if (String(to).endsWith('/bridge.json') && point === 'after-marker') kill();
        const result = rename.call(this, from, to);
        if (to === f.p.status && point === 'after-status') kill();
        return result;
      };
      commitCompletion(f.root, 'r1', f.status, f.credentials, f.next);
    `], { encoding: 'utf8', timeout: 10000 });
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    const committed = !['before-journal', 'torn-journal'].includes(point);
    const bridge = readBridge(f.root);
    assert.equal(!!bridge.receipts['commit-h1'], committed);
    const recovered = JSON.parse(fs.readFileSync(f.p.status));
    assert.equal(recovered.overall, committed ? 'done' : 'awaiting_chat');
    const result = commitCompletion(f.root, 'r1', f.status, f.credentials, f.next);
    assert.equal(result.ok, true);
    assert.deepEqual(commitCompletion(f.root, 'r1', f.status, f.credentials, f.next), result);
    const rows = readJournal(path.join(f.p.control, 'bridge.journal.jsonl'));
    assert.equal(rows.filter(row => row.command === 'stage.commit').length, 1);
    assert.equal(rows.filter(row => row.command === 'projection.applied').length, 1);
    // Losing the cache must not replay an old status over a newer handoff.
    fs.rmSync(path.join(f.p.control, 'bridge.json'), { force: true });
    fs.writeFileSync(f.p.status, JSON.stringify({ overall: 'awaiting_chat', handoffId: 'h2' }));
    readBridge(f.root);
    assert.equal(JSON.parse(fs.readFileSync(f.p.status)).handoffId, 'h2');
  });
}

test('failed projection is committed, blocks new commands, and preserves conflicting status', t => {
  const f = fixture(t), original = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === f.p.status) throw new Error('disk unavailable');
    return original(from, to);
  };
  try {
    assert.throws(() => commitCompletion(f.root, 'r1', f.status, f.credentials, f.next), error => error.committed && /disk unavailable/.test(error.message));
  } finally { fs.renameSync = original; }
  const conflict = JSON.stringify({ overall: 'halted', handoffId: 'operator-repair' });
  fs.writeFileSync(f.p.status, conflict);
  assert.throws(() => bridgeCommand('message.queue', { project: f.root, runId: 'r1', text: 'do not lose this' }), /projection conflicts/);
  assert.equal(fs.readFileSync(f.p.status, 'utf8'), conflict);
  assert.equal(commandState(f.p.control).messages.length, 0);
  fs.writeFileSync(f.p.status, JSON.stringify(f.status));
  recoverCommands(f.p.control);
  assert.equal(JSON.parse(fs.readFileSync(f.p.status)).overall, 'done');
});

test('multiple processes preserve every command and idempotency receipt while reclaiming a stale lock', async t => {
  const f = fixture(t), dir = path.join(f.root, 'contention');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'bridge.lock'), JSON.stringify({ pid: 99999999 }));
  fs.writeFileSync(path.join(dir, 'bridge.lock.reclaim'), JSON.stringify({ pid: 99999999 }));
  const workers = Array.from({ length: 8 }, (_, worker) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { transact } from ${JSON.stringify(commandsUrl)};
      const wait = new Int32Array(new SharedArrayBuffer(4));
      for (let n = 0; n < 8; n++) {
        const commandId = ${JSON.stringify(String(worker))} + '-' + n;
        const deadline = Date.now() + 20000;
        for (;;) {
          try {
            transact(${JSON.stringify(dir)}, 'increment', {}, s => { s.runs.count = (s.runs.count || 0) + 1; }, { commandId });
            transact(${JSON.stringify(dir)}, 'increment', {}, () => { throw new Error('replayed mutation'); }, { commandId });
            break;
          } catch (error) {
            if (!/Command busy/.test(error.message) || Date.now() > deadline) throw error;
            Atomics.wait(wait, 0, 0, 5);
          }
        }
      }
    `], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(stderr)));
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  }));
  await Promise.all(workers);
  const state = commandState(dir);
  assert.equal(state.revision, 64);
  assert.equal(state.runs.count, 64);
  assert.equal(Object.keys(state.receipts).length, 64);
  assert.equal(fs.existsSync(path.join(dir, 'bridge.lock')), false);
});

test('aborted mutation never publishes staged files', t => {
  const f = fixture(t), before = fs.readFileSync(f.p.status, 'utf8');
  assert.throws(() => transact(f.p.control, 'abort', {}, (_state, write) => {
    write(f.p.status, 'invalid');
    throw new Error('validation failed');
  }), /validation failed/);
  assert.equal(fs.readFileSync(f.p.status, 'utf8'), before);
});

test('an engine killed during verification restores its original status and handoff before retry', t => {
  const f = fixture(t);
  const handoff = fs.readFileSync(f.p.stageHandoff, 'utf8');
  fs.writeFileSync(f.p.changes, `${'Implemented the requested change. '.repeat(10)}\n## Self-Review\nE1 handled at src/x.js:12\n`);
  const prepared = bridgeCommand('stage.prepare', { project: f.root, runId: 'r1', ...f.credentials, commandId: 'prepare-h1' });
  const killed = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import { acquireLockFile } from ${JSON.stringify(stateUrl)};
    const f = ${JSON.stringify(f)};
    if (!acquireLockFile(f.p.lock, { pid: process.pid })) process.exit(2);
    fs.writeFileSync(f.p.status, JSON.stringify({ ...f.status, overall: 'running', awaitingStage: null }));
    fs.writeFileSync(f.p.stageHandoff, JSON.stringify({ stage: 'tester' }));
    process.kill(process.pid, 'SIGKILL');
  `], { encoding: 'utf8', timeout: 10000 });
  assert.equal(killed.signal, 'SIGKILL', killed.stderr);
  // A live engine must never be rolled back by another caller.
  fs.writeFileSync(f.p.lock, JSON.stringify({ pid: process.pid }));
  assert.throws(() => recoverVerification(f.root, 'r1'), /engine is still active/);
  fs.writeFileSync(f.p.lock, JSON.stringify({ pid: 99999999 }));
  // Kill recovery between its two projected files, then recover that too.
  const recovery = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import { recoverVerification } from ${JSON.stringify(bridgeUrl)};
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      const result = rename(from, to);
      if (to === ${JSON.stringify(f.p.status)}) process.kill(process.pid, 'SIGKILL');
      return result;
    };
    recoverVerification(${JSON.stringify(f.root)}, 'r1');
  `], { encoding: 'utf8', timeout: 10000 });
  assert.equal(recovery.signal, 'SIGKILL', recovery.stderr);
  recoverCommands(f.p.control);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.p.status)), f.status);
  assert.equal(fs.readFileSync(f.p.stageHandoff, 'utf8'), handoff);
  assert.equal(readBridge(f.root).runs.r1.completion.id, prepared.completion.id);
  assert.equal(recoverVerification(f.root, 'r1'), undefined);
});
