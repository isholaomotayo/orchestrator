// The UI-to-chat bridge: session registration, run ownership leases, durable
// acked/resolved messages, and gated stage completion. These tests exercise
// bridge.mjs directly against a throwaway project directory — no real engine,
// no real agent, just the ownership/message state machine itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pipelinePaths } from './state.mjs';
import {
  bridgeCommand, inspectBridge, readBridge, assertMessagesSettled,
  validateCompletion, commitCompletion, bindHandoff, bridgePaths,
} from './bridge.mjs';

function project() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-')));
}

// A run parked at a chat handoff, awaiting a session to claim it.
function awaitingRun(root, runId, { stage = 'coder', handoffId = 'h1', overall = 'awaiting_chat' } = {}) {
  const p = pipelinePaths(root, { runId });
  fs.mkdirSync(p.dir, { recursive: true });
  const status = { overall, handoffId, awaitingStage: stage, stages: [] };
  fs.writeFileSync(p.status, JSON.stringify(status, null, 2));
  fs.writeFileSync(p.stageHandoff, JSON.stringify({ stage, runId }));
  return { p, status };
}

const VALID_CODER_ARTIFACT = `${'Implemented the change as described.'.padEnd(200, ' filler')}\n## Self-Review\nE1 handled at src/x.js:12\n`;

function writeArtifact(root, runId, file, content = VALID_CODER_ARTIFACT) {
  fs.writeFileSync(pipelinePaths(root, { runId })[file], content);
}

function register(root, conversationId = 'conv-1', host = 'claude') {
  return bridgeCommand('session.register', { project: root, host, conversationId, capabilities: { hooks: true } });
}

function claim(root, runId, sessionId, opts = {}) {
  return bridgeCommand('run.claim', { project: root, runId, sessionId, ...opts });
}

// ---- session.register ------------------------------------------------------

test('session.register is stable for the same host+conversation and refreshes capabilities', () => {
  const root = project();
  const first = register(root, 'conv-1', 'claude');
  const second = bridgeCommand('session.register', { project: root, host: 'claude', conversationId: 'conv-1', capabilities: { hooks: false } });
  assert.equal(second.sessionId, first.sessionId);
  assert.deepEqual(second.capabilities, { hooks: false });
});

test('session.register rejects an unsupported host or a missing conversation id', () => {
  const root = project();
  assert.throws(() => bridgeCommand('session.register', { project: root, host: 'notepad', conversationId: 'c' }), /host and conversationId/);
  assert.throws(() => bridgeCommand('session.register', { project: root, host: 'claude', conversationId: '  ' }), /host and conversationId/);
});

test('bridgePaths refuses a relative project path and an invalid run id', () => {
  const root = project();
  assert.throws(() => bridgeCommand('session.register', { project: 'relative/path', host: 'claude', conversationId: 'c' }), /absolute project path/);
  assert.throws(() => bridgeCommand('run.inspect', { project: root, runId: '../escape' }), /Invalid runId/);
});

// ---- run.claim: ownership -------------------------------------------------

test('run.claim requires the run to be awaiting a managed handoff', () => {
  const root = project();
  const runId = 'r1';
  const p = pipelinePaths(root, { runId });
  fs.mkdirSync(p.dir, { recursive: true });
  fs.writeFileSync(p.status, JSON.stringify({ overall: 'running' }));
  const session = register(root);
  assert.throws(() => claim(root, runId, session.sessionId), /not awaiting a managed handoff/);
});

test('run.claim requires the session to be registered first', () => {
  const root = project();
  const runId = 'r1';
  awaitingRun(root, runId);
  assert.throws(() => claim(root, runId, 'ghost-session'), /Register the session first/);
});

test('a claimed run returns a lease token, handoffId, and the parked stage handoff', () => {
  const root = project();
  const runId = 'r1';
  awaitingRun(root, runId, { stage: 'coder', handoffId: 'h1' });
  const session = register(root);
  const claimed = claim(root, runId, session.sessionId);
  assert.equal(claimed.handoffId, 'h1');
  assert.ok(claimed.leaseToken);
  assert.equal(claimed.handoff.stage, 'coder');
});

test('re-claiming with the same session and handoff is idempotent: same lease token, not regenerated', () => {
  const root = project();
  const runId = 'r1';
  awaitingRun(root, runId);
  const session = register(root);
  const a = claim(root, runId, session.sessionId);
  const b = claim(root, runId, session.sessionId);
  assert.equal(b.leaseToken, a.leaseToken);
});

test('a second session cannot claim a run a live lease already owns', () => {
  const root = project();
  const runId = 'r1';
  awaitingRun(root, runId);
  const owner = register(root, 'conv-owner');
  const rival = register(root, 'conv-rival');
  claim(root, runId, owner.sessionId);
  assert.throws(() => claim(root, runId, rival.sessionId), /already owned/);
});

test('a second session cannot claim a run whose engine lock is still alive, even past lease expiry', () => {
  const root = project();
  const runId = 'r1';
  const { p } = awaitingRun(root, runId);
  const owner = register(root, 'conv-owner');
  // Claim it as already expired, so the lease itself is no longer a blocker...
  bridgeCommand('run.claim', { project: root, runId, sessionId: owner.sessionId }, { now: Date.now() - 999_999_999 });
  // ...but the engine that was handed this run is still alive and working.
  fs.writeFileSync(p.lock, JSON.stringify({ pid: process.pid }));
  const rival = register(root, 'conv-rival');
  assert.throws(() => claim(root, runId, rival.sessionId, { reassign: true }), /engine is still active/);
});

test('a session already owning a different run must release it before claiming another', () => {
  const root = project();
  awaitingRun(root, 'r1');
  awaitingRun(root, 'r2');
  const session = register(root);
  claim(root, 'r1', session.sessionId);
  assert.throws(
    () => bridgeCommand('run.claim', { project: root, runId: 'r2', sessionId: session.sessionId }),
    /Release the other run/,
  );
});

test('run.release frees the run for another session to claim', () => {
  const root = project();
  const runId = 'r1';
  awaitingRun(root, runId);
  const a = register(root, 'conv-a');
  const b = register(root, 'conv-b');
  const claimed = claim(root, runId, a.sessionId);
  bridgeCommand('run.release', { project: root, runId, sessionId: a.sessionId, leaseToken: claimed.leaseToken, handoffId: claimed.handoffId });
  assert.doesNotThrow(() => claim(root, runId, b.sessionId));
});

test('a stale (unowned) session cannot report or complete a run it does not own', () => {
  const root = project();
  const runId = 'r1';
  awaitingRun(root, runId);
  const owner = register(root, 'conv-owner');
  claim(root, runId, owner.sessionId);
  const rival = register(root, 'conv-rival');
  assert.throws(
    () => bridgeCommand('run.checkpoint', { project: root, runId, sessionId: rival.sessionId, leaseToken: 'not-a-real-token', handoffId: 'h1' }),
    /does not own the run/,
  );
});

test('a handoff that has since moved on invalidates the old owner’s credentials', () => {
  const root = project();
  const runId = 'r1';
  const { p } = awaitingRun(root, runId, { handoffId: 'h1' });
  const session = register(root);
  const claimed = claim(root, runId, session.sessionId);
  // The engine advanced to a new handoff without this session's participation.
  fs.writeFileSync(p.status, JSON.stringify({ overall: 'awaiting_chat', handoffId: 'h2', awaitingStage: 'tester', stages: [] }));
  assert.throws(
    () => bridgeCommand('run.checkpoint', { project: root, runId, sessionId: session.sessionId, leaseToken: claimed.leaseToken, handoffId: claimed.handoffId }),
    /Stale handoff/,
  );
});

// ---- messages ---------------------------------------------------------------

test('message.queue validates text length, priority, stage, and run state', () => {
  const root = project();
  const runId = 'r1';
  awaitingRun(root, runId, { stage: 'coder' });
  assert.throws(() => bridgeCommand('message.queue', { project: root, runId, text: '' }), /1–32000 characters/);
  assert.throws(() => bridgeCommand('message.queue', { project: root, runId, text: 'x'.repeat(32001) }), /1–32000 characters/);
  assert.throws(() => bridgeCommand('message.queue', { project: root, runId, text: 'hi', stage: 'tester' }), /is not active/);
  assert.throws(() => bridgeCommand('message.queue', { project: root, runId, text: 'hi', priority: 'urgent' }), /Invalid message priority/);
  const queued = bridgeCommand('message.queue', { project: root, runId, text: 'please check X' });
  assert.equal(queued.message.priority, 'priority');
  assert.equal(queued.message.status, 'queued');
});

test('message.queue refuses a terminal run', () => {
  const root = project();
  const runId = 'r1';
  const p = pipelinePaths(root, { runId });
  fs.mkdirSync(p.dir, { recursive: true });
  fs.writeFileSync(p.status, JSON.stringify({ overall: 'done' }));
  assert.throws(() => bridgeCommand('message.queue', { project: root, runId, text: 'too late' }), /Run is terminal/);
});

test('run.checkpoint delivers queued messages, priority first, then FIFO, and marks them delivered', () => {
  const root = project();
  const runId = 'r1';
  awaitingRun(root, runId);
  const session = register(root);
  const claimed = claim(root, runId, session.sessionId);
  bridgeCommand('message.queue', { project: root, runId, text: 'normal one', priority: 'normal' });
  bridgeCommand('message.queue', { project: root, runId, text: 'priority one', priority: 'priority' });
  const creds = { project: root, runId, sessionId: session.sessionId, leaseToken: claimed.leaseToken, handoffId: claimed.handoffId };
  const checkpoint = bridgeCommand('run.checkpoint', creds);
  assert.equal(checkpoint.messages.length, 2);
  assert.equal(checkpoint.messages[0].text, 'priority one');
  assert.equal(checkpoint.messages[1].text, 'normal one');
  assert.ok(checkpoint.messages.every((m) => m.status === 'delivered'));
});

test('message.ack requires delivery first, and re-acking a closed message is a harmless no-op', () => {
  const root = project();
  const runId = 'r1';
  awaitingRun(root, runId);
  const session = register(root);
  const claimed = claim(root, runId, session.sessionId);
  const { message } = bridgeCommand('message.queue', { project: root, runId, text: 'hi' });
  const creds = { project: root, runId, sessionId: session.sessionId, leaseToken: claimed.leaseToken, handoffId: claimed.handoffId };
  assert.throws(() => bridgeCommand('message.ack', { ...creds, messageId: message.id }), /has not been delivered/);
  bridgeCommand('run.checkpoint', creds);
  const acked = bridgeCommand('message.ack', { ...creds, messageId: message.id });
  assert.equal(acked.message.status, 'acknowledged');
  const resolved = bridgeCommand('message.resolve', { ...creds, messageId: message.id, disposition: 'addressed', reason: 'done' });
  assert.equal(resolved.message.status, 'addressed');
  // Acking an already-resolved (closed) message again does not throw or revert it.
  const again = bridgeCommand('message.ack', { ...creds, messageId: message.id });
  assert.equal(again.message.status, 'addressed');
});

test('message.resolve requires acknowledgment first, and a valid disposition with a reason', () => {
  const root = project();
  const runId = 'r1';
  awaitingRun(root, runId);
  const session = register(root);
  const claimed = claim(root, runId, session.sessionId);
  const { message } = bridgeCommand('message.queue', { project: root, runId, text: 'hi' });
  const creds = { project: root, runId, sessionId: session.sessionId, leaseToken: claimed.leaseToken, handoffId: claimed.handoffId };
  bridgeCommand('run.checkpoint', creds);
  assert.throws(() => bridgeCommand('message.resolve', { ...creds, messageId: message.id, disposition: 'addressed', reason: 'x' }), /Acknowledge the message before resolving/);
  bridgeCommand('message.ack', { ...creds, messageId: message.id });
  assert.throws(() => bridgeCommand('message.resolve', { ...creds, messageId: message.id, disposition: 'whatever', reason: 'x' }), /disposition and reason/);
  assert.throws(() => bridgeCommand('message.resolve', { ...creds, messageId: message.id, disposition: 'addressed' }), /disposition and reason/);
});

test('assertMessagesSettled blocks on an outstanding priority message but not on a normal one', () => {
  const root = project();
  const runId = 'r1';
  awaitingRun(root, runId, { handoffId: 'h1' });
  bridgeCommand('message.queue', { project: root, runId, text: 'normal', priority: 'normal' });
  const state = readBridge(root);
  assert.doesNotThrow(() => assertMessagesSettled(state, runId, 'h1'));
  bridgeCommand('message.queue', { project: root, runId, text: 'priority', priority: 'priority' });
  assert.throws(() => assertMessagesSettled(readBridge(root), runId, 'h1'), /require acknowledgment and disposition/);
});

// ---- stage completion --------------------------------------------------------

test('stage.prepare refuses when a priority message is still open, and refuses a missing/invalid artifact', () => {
  const root = project();
  const runId = 'r1';
  awaitingRun(root, runId, { stage: 'coder' });
  const session = register(root);
  const claimed = claim(root, runId, session.sessionId);
  const creds = { project: root, runId, sessionId: session.sessionId, leaseToken: claimed.leaseToken, handoffId: claimed.handoffId };

  // No artifact yet.
  assert.throws(() => bridgeCommand('stage.prepare', creds), /not ready/);

  writeArtifact(root, runId, 'changes');
  bridgeCommand('message.queue', { project: root, runId, text: 'read this first' });
  assert.throws(() => bridgeCommand('stage.prepare', creds), /require acknowledgment and disposition/);
});

test('stage.prepare succeeds once the artifact is valid and every priority message is settled', () => {
  const root = project();
  const runId = 'r1';
  awaitingRun(root, runId, { stage: 'coder' });
  const session = register(root);
  const claimed = claim(root, runId, session.sessionId);
  const creds = { project: root, runId, sessionId: session.sessionId, leaseToken: claimed.leaseToken, handoffId: claimed.handoffId };
  writeArtifact(root, runId, 'changes');
  const prepared = bridgeCommand('stage.prepare', creds);
  assert.ok(prepared.completion.artifactHash);
  assert.equal(prepared.completion.handoffId, claimed.handoffId);
});

test('validateCompletion checks ownership, message settlement, and that the prepared artifact hash still matches', () => {
  const root = project();
  const runId = 'r1';
  awaitingRun(root, runId, { stage: 'coder', handoffId: 'h1' });
  const session = register(root);
  const claimed = claim(root, runId, session.sessionId);
  writeArtifact(root, runId, 'changes');
  const prepared = bridgeCommand('stage.prepare', { project: root, runId, sessionId: session.sessionId, leaseToken: claimed.leaseToken, handoffId: claimed.handoffId });
  const status = JSON.parse(fs.readFileSync(pipelinePaths(root, { runId }).status, 'utf8'));
  const goodCreds = { sessionId: session.sessionId, leaseToken: claimed.leaseToken, handoffId: claimed.handoffId, completionId: prepared.completion.id };

  // Never prepared for this session.
  assert.throws(() => validateCompletion(root, runId, status, { ...goodCreds, sessionId: 'someone-else' }), /does not own/);

  // The artifact changed after prepare was recorded — stale completion.
  writeArtifact(root, runId, 'changes', VALID_CODER_ARTIFACT + '\nmore.\n');
  assert.throws(() => validateCompletion(root, runId, status, goodCreds), /not prepared for this artifact/);

  // Put it back and it validates cleanly.
  writeArtifact(root, runId, 'changes');
  assert.doesNotThrow(() => validateCompletion(root, runId, status, goodCreds));
});

test('commitCompletion records the handoff as complete and clears status.handoffId', () => {
  const root = project();
  const runId = 'r1';
  const { p, status } = awaitingRun(root, runId, { stage: 'coder', handoffId: 'h1' });
  const session = register(root);
  const claimed = claim(root, runId, session.sessionId);
  const credentials = { sessionId: session.sessionId, leaseToken: claimed.leaseToken, handoffId: claimed.handoffId };
  const next = { ...status, overall: 'done' };
  const result = commitCompletion(root, runId, status, credentials, next);
  assert.equal(result.ok, true);
  assert.equal(next.handoffId, null);
  assert.ok(next.completedHandoffs['h1']);
});

test('commitCompletion is replayable: a retried request for an already-committed handoff returns the original result', () => {
  const root = project();
  const runId = 'r1';
  const { status } = awaitingRun(root, runId, { stage: 'coder', handoffId: 'h1' });
  const session = register(root);
  const claimed = claim(root, runId, session.sessionId);
  const credentials = { sessionId: session.sessionId, leaseToken: claimed.leaseToken, handoffId: claimed.handoffId };
  const first = commitCompletion(root, runId, status, credentials, { ...status });
  // Retry after a crash: ownership may since have been released, credentials
  // may be whatever the caller still has lying around — the point of the
  // replay is that none of that matters once the handoff already committed.
  const second = commitCompletion(root, runId, status, { sessionId: 'irrelevant', leaseToken: 'irrelevant', handoffId: 'h1' }, { ...status });
  assert.deepEqual(second, first);
});

test('commitCompletion rejects a caller whose ownership does not match, on the first (non-replayed) attempt', () => {
  const root = project();
  const runId = 'r1';
  const { status } = awaitingRun(root, runId, { stage: 'coder', handoffId: 'h1' });
  const session = register(root);
  claim(root, runId, session.sessionId);
  assert.throws(
    () => commitCompletion(root, runId, status, { sessionId: session.sessionId, leaseToken: 'wrong-token', handoffId: 'h1' }, { ...status }),
    /ownership changed/,
  );
});

// ---- handoff binding & inspection --------------------------------------------

test('bindHandoff attaches a pending handoff-less message to the new handoff, once', () => {
  const root = project();
  const runId = 'r1';
  awaitingRun(root, runId, { handoffId: null });
  // A message queued before the engine assigned a handoffId for this stage.
  bridgeCommand('message.queue', { project: root, runId, text: 'early note' });
  bindHandoff(root, runId, 'h9', 'coder');
  const state = readBridge(root);
  assert.equal(state.messages[0].handoffId, 'h9');
  assert.equal(state.messages[0].stage, 'coder');
});

test('inspectBridge reports disconnected with no owner, and connected once a session with hooks has claimed it', () => {
  const root = project();
  const runId = 'r1';
  awaitingRun(root, runId);
  assert.equal(inspectBridge(root, runId).capability, 'disconnected');
  const session = register(root, 'conv-1', 'claude');
  claim(root, runId, session.sessionId);
  assert.equal(inspectBridge(root, runId).capability, 'connected');
});

test('inspectBridge reports checkpoint-only for a session with no hooks capability', () => {
  const root = project();
  const runId = 'r1';
  awaitingRun(root, runId);
  const session = bridgeCommand('session.register', { project: root, host: 'codex', conversationId: 'c', capabilities: {} });
  claim(root, runId, session.sessionId);
  assert.equal(inspectBridge(root, runId).capability, 'checkpoint-only');
});

test('release cannot downgrade an enrolled run to ungated legacy continuation', () => {
  const root = project(), runId = 'r1';
  awaitingRun(root, runId);
  assert.equal(inspectBridge(root, runId).ownershipRequired, false);
  const session = register(root);
  const claimed = claim(root, runId, session.sessionId);
  bridgeCommand('run.release', { project: root, runId, sessionId: session.sessionId, leaseToken: claimed.leaseToken, handoffId: claimed.handoffId });
  assert.equal(inspectBridge(root, runId).owner, null);
  assert.equal(inspectBridge(root, runId).ownershipRequired, true);
});

test('priority instructions require ownership even before the first claim', () => {
  const root = project(), runId = 'r1';
  awaitingRun(root, runId);
  bridgeCommand('message.queue', { project: root, runId, text: 'Wait for the operator.' });
  assert.equal(inspectBridge(root, runId).ownershipRequired, true);
});

test('completion refuses a lease that expired during verification without changing status', () => {
  const root = project(), runId = 'r1';
  const { p, status } = awaitingRun(root, runId);
  const session = register(root);
  const claimed = bridgeCommand('run.claim', { project: root, runId, sessionId: session.sessionId }, { now: Date.now() - 300000 });
  assert.throws(() => commitCompletion(root, runId, status, {
    sessionId: session.sessionId, leaseToken: claimed.leaseToken, handoffId: claimed.handoffId,
  }, { ...status, overall: 'done' }), /lease expired/);
  assert.deepEqual(JSON.parse(fs.readFileSync(p.status)), status);
});


test('the engine refuses bare continuation after a claimed run is released', () => {
  const root = project(), runId = 'r1';
  const { p, status } = awaitingRun(root, runId);
  status.bridgeRequired = true;
  status.chatResume = { step: 'after_coder' };
  fs.writeFileSync(p.status, JSON.stringify(status));
  const session = register(root);
  const claimed = claim(root, runId, session.sessionId);
  bridgeCommand('message.queue', { project: root, runId, text: 'Do not advance before addressing this.' });
  bridgeCommand('run.release', { project: root, runId, sessionId: session.sessionId, leaseToken: claimed.leaseToken, handoffId: claimed.handoffId });
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./orchestrator.mjs', import.meta.url)), '--continue', '--run-id', runId], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not own the run/);
  assert.deepEqual(JSON.parse(fs.readFileSync(p.status)), status);
  assert.equal(inspectBridge(root, runId).messages[0].status, 'queued');
});

test('run.dismiss halts and dismisses an active or waiting run and clears owner', () => {
  const root = project(), runId = 'r1';
  const { p, status } = awaitingRun(root, runId);
  const session = register(root);
  claim(root, runId, session.sessionId);
  assert.ok(inspectBridge(root, runId).owner);

  const res = bridgeCommand('run.dismiss', { project: root, runId, reason: 'Operator dismissed test run' });
  assert.equal(res.ok, true);
  assert.equal(res.dismissed, true);

  const updatedStatus = JSON.parse(fs.readFileSync(p.status, 'utf8'));
  assert.equal(updatedStatus.overall, 'halted');
  assert.equal(updatedStatus.haltReason, 'Operator dismissed test run');
  assert.equal(updatedStatus.dismissed, true);
  assert.ok(updatedStatus.dismissedAt);

  assert.equal(inspectBridge(root, runId).owner, null);
  const bridge = readBridge(root);
  assert.ok(bridge.dismissedRuns[runId]);
});

test('run.dismiss safely handles a run without status.json or with an empty dir', () => {
  const root = project(), runId = 'r_empty';
  const p = bridgePaths(root, runId);
  fs.mkdirSync(p.dir, { recursive: true });

  const res = bridgeCommand('run.dismiss', { project: root, runId, reason: 'Clean empty run' });
  assert.equal(res.ok, true);
  assert.equal(res.dismissed, true);
  assert.equal(fs.existsSync(p.dir), false); // empty dir was cleaned up
});
