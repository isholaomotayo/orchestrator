// executeBridge is the thin CLI/MCP-shared dispatcher around bridge.mjs: it
// adds run.wait's short-poll and stage.complete's subprocess handoff, and
// passes everything else straight through to bridgeCommand.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bridgeCommand } from './bridge.mjs';
import { executeBridge } from './bridge-cli.mjs';

function project() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-cli-')));
}

test('executeBridge passes an ordinary command straight through to bridgeCommand', async () => {
  const root = project();
  const result = await executeBridge('session.register', { project: root, host: 'claude', conversationId: 'c1' });
  assert.ok(result.sessionId);
});

test('run.wait returns immediately once the revision has already moved past afterRevision', async () => {
  const root = project();
  bridgeCommand('session.register', { project: root, host: 'claude', conversationId: 'c1' });
  const before = await executeBridge('run.inspect', { project: root, runId: null });
  const result = await executeBridge('run.wait', { project: root, runId: null, afterRevision: before.revision - 1, timeoutMs: 5000 });
  assert.equal(result.revision, before.revision);
});

test('run.wait gives up and returns the current value once its (clamped) timeout elapses', async () => {
  const root = project();
  const before = await executeBridge('run.inspect', { project: root, runId: null });
  const start = Date.now();
  const result = await executeBridge('run.wait', { project: root, runId: null, afterRevision: before.revision, timeoutMs: 200 });
  const elapsed = Date.now() - start;
  assert.equal(result.revision, before.revision);
  assert.ok(elapsed < 2000, `should not wait anywhere near the 60s ceiling for a 200ms request (took ${elapsed}ms)`);
});
