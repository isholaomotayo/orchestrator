import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipelinePaths } from './state.mjs';
import { recordIntervention, recordRecovery } from './interventions.mjs';

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'interventions-'));
  fs.mkdirSync(pipelinePaths(root, { runId: 'r1' }).dir, { recursive: true });
  return root;
}
const eventsOf = (root) => fs.readFileSync(pipelinePaths(root, { runId: 'r1' }).events, 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('an automatic recovery is a recovered event from self-heal, not a human intervention', () => {
  const root = tmpRoot();
  recordRecovery(root, 'r1', { action: 'auto-resume', cause: 'AGENT_ERROR', detail: 'transient timeout' });
  const [ev] = eventsOf(root);
  assert.equal(ev.type, 'recovered');
  assert.equal(ev.via, 'self-heal');
  assert.equal(ev.action, 'auto-resume');
  assert.equal(ev.cause, 'AGENT_ERROR');
  assert.equal(ev.detail, 'transient timeout');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a human action stays an intervention and keeps who/where it came from', () => {
  const root = tmpRoot();
  recordIntervention(root, 'r1', { action: 'resume', via: 'desktop' });
  const [ev] = eventsOf(root);
  assert.equal(ev.type, 'intervention');
  assert.equal(ev.via, 'desktop');
  fs.rmSync(root, { recursive: true, force: true });
});

test('recording never throws, even for an invalid run id', () => {
  const root = tmpRoot();
  assert.equal(recordRecovery(root, '../escape', { action: 'auto-resume' }), null);
  fs.rmSync(root, { recursive: true, force: true });
});
