// Host-neutral checkpoint envelope shared by the Codex/Claude/Cursor/Antigravity
// hook adapters. hookIdentity/hookEnvelope are pure formatting; handleHostHook
// wires that formatting to the real bridge state (session, ownership, messages).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipelinePaths } from './state.mjs';
import { bridgeCommand } from './bridge.mjs';
import { hookIdentity, hookEnvelope, handleHostHook } from './host-hooks.mjs';

function project() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-hooks-')));
}

function awaitingRun(root, runId, { stage = 'coder', handoffId = 'h1' } = {}) {
  const p = pipelinePaths(root, { runId });
  fs.mkdirSync(p.dir, { recursive: true });
  fs.writeFileSync(p.status, JSON.stringify({ overall: 'awaiting_chat', handoffId, awaitingStage: stage, stages: [] }));
  fs.writeFileSync(p.stageHandoff, JSON.stringify({ stage, runId }));
  return p;
}

// ---- hookIdentity -----------------------------------------------------------

test('hookIdentity reads every field-name variant a host might send', () => {
  assert.deepEqual(hookIdentity('claude', { session_id: 's1', model_id: 'm1', hook_event_name: 'PreToolUse', tool_name: 'Read' }),
    { conversationId: 's1', actualModel: 'm1', event: 'PreToolUse', tool: 'Read' });
  assert.deepEqual(hookIdentity('cursor', { conversation_id: 's2', model: 'm2', hookEventName: 'beforeShellExecution', toolCall: { name: 'shell' } }),
    { conversationId: 's2', actualModel: 'm2', event: 'beforeShellExecution', tool: 'shell' });
  assert.equal(hookIdentity('codex', {}).conversationId, undefined);
});

// ---- hookEnvelope -------------------------------------------------------------

test('hookEnvelope has no opinion when there is nothing to say', () => {
  assert.deepEqual(hookEnvelope('claude', 'PreToolUse', ''), {});
  assert.deepEqual(hookEnvelope('claude', 'Stop', null), {});
});

test('hookEnvelope shapes context per host and per stop-vs-checkpoint', () => {
  assert.deepEqual(hookEnvelope('antigravity', 'Stop', 'wrap up'), { decision: 'continue', reason: 'wrap up' });
  assert.deepEqual(hookEnvelope('antigravity', 'PreInvocation', 'read this'), { injectSteps: [{ userMessage: 'read this' }] });
  assert.deepEqual(hookEnvelope('antigravity', 'Stop', null), { decision: 'allow' });
  assert.deepEqual(hookEnvelope('cursor', 'beforeSubmitPrompt', 'note'), { additional_context: 'note' });
  assert.deepEqual(hookEnvelope('cursor', 'stop', 'note', true), { followup_message: 'note' });
  assert.deepEqual(hookEnvelope('claude', 'PostToolUse', 'note'), { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'note' } });
  assert.deepEqual(hookEnvelope('claude', 'Stop', 'note', true), { decision: 'block', reason: 'note' });
  assert.deepEqual(hookEnvelope('codex', 'PostToolUse', 'note'), { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'note' } });
});

// ---- handleHostHook -----------------------------------------------------------

test('handleHostHook rejects a host outside the supported set', () => {
  assert.throws(() => handleHostHook('notepad', project(), {}), /Unsupported host/);
});

test('handleHostHook is a no-op with no conversation id, or for the bridge’s own tool calls', () => {
  const root = project();
  assert.deepEqual(handleHostHook('claude', root, { hook_event_name: 'PreToolUse' }), {});
  assert.deepEqual(handleHostHook('claude', root, { session_id: 's1', hook_event_name: 'PreToolUse', tool_name: 'mcp__orchestrator__run_checkpoint' }), {});
});

test('handleHostHook is silent until this conversation actually owns a claimed run', () => {
  const root = project();
  awaitingRun(root, 'r1');
  // The session has never claimed anything (no run.claim happened out of band).
  assert.deepEqual(handleHostHook('claude', root, { session_id: 'conv-1', hook_event_name: 'PreToolUse', tool_name: 'Read' }), {});
});

test('handleHostHook is silent once the run is no longer awaiting this handoff', () => {
  const root = project();
  const runId = 'r1';
  awaitingRun(root, runId);
  const registration = bridgeCommand('session.register', { project: root, host: 'claude', conversationId: 'conv-1', capabilities: { hooks: true } });
  bridgeCommand('run.claim', { project: root, runId, sessionId: registration.sessionId });
  // The run has since finished from underneath this hook call.
  fs.writeFileSync(pipelinePaths(root, { runId }).status, JSON.stringify({ overall: 'done' }));
  assert.deepEqual(handleHostHook('claude', root, { session_id: 'conv-1', hook_event_name: 'PreToolUse', tool_name: 'Read' }), {});
});

test('handleHostHook delivers a pending priority message as checkpoint context, formatted for the host', () => {
  const root = project();
  const runId = 'r1';
  awaitingRun(root, runId, { handoffId: 'h1' });
  const registration = bridgeCommand('session.register', { project: root, host: 'claude', conversationId: 'conv-1', capabilities: { hooks: true } });
  bridgeCommand('run.claim', { project: root, runId, sessionId: registration.sessionId });
  bridgeCommand('message.queue', { project: root, runId, text: 'stop and re-check the auth path', handoffId: 'h1' });

  const result = handleHostHook('claude', root, { session_id: 'conv-1', hook_event_name: 'PostToolUse', tool_name: 'Edit' });
  assert.ok(result.hookSpecificOutput, 'claude gets its hookSpecificOutput envelope shape');
  const ctx = result.hookSpecificOutput.additionalContext;
  assert.match(ctx, /user instructions/i);
  assert.match(ctx, /stop and re-check the auth path/);
  assert.match(ctx, /message_ack/);
});

test('handleHostHook says nothing once every message is already settled', () => {
  const root = project();
  const runId = 'r1';
  awaitingRun(root, runId, { handoffId: 'h1' });
  const registration = bridgeCommand('session.register', { project: root, host: 'claude', conversationId: 'conv-1', capabilities: { hooks: true } });
  const claimed = bridgeCommand('run.claim', { project: root, runId, sessionId: registration.sessionId });
  assert.deepEqual(handleHostHook('claude', root, { session_id: 'conv-1', hook_event_name: 'PreToolUse', tool_name: 'Read' }), {});
});

test('handleHostHook renews an expired lease for the same conversation rather than failing silently', () => {
  const root = project();
  const runId = 'r1';
  awaitingRun(root, runId, { handoffId: 'h1' });
  const registration = bridgeCommand('session.register', { project: root, host: 'claude', conversationId: 'conv-1', capabilities: { hooks: true } });
  bridgeCommand('run.claim', { project: root, runId, sessionId: registration.sessionId }, { now: Date.now() - 999_999_999 });
  bridgeCommand('message.queue', { project: root, runId, text: 'ping' });
  // The lease from that claim has long since expired; the hook should renew it
  // for the same conversation rather than giving up.
  const result = handleHostHook('claude', root, { session_id: 'conv-1', hook_event_name: 'PostToolUse', tool_name: 'Edit' });
  assert.match(result.hookSpecificOutput.additionalContext, /ping/);
});

test('Antigravity telemetry leaves messages queued until an injection-capable hook runs', () => {
  const root = project(), runId = 'r1';
  awaitingRun(root, runId);
  const session = bridgeCommand('session.register', { project: root, host: 'antigravity', conversationId: 'conv-1' });
  bridgeCommand('run.claim', { project: root, runId, sessionId: session.sessionId });
  bridgeCommand('message.queue', { project: root, runId, text: 'Please verify the fix.' });
  const input = { conversationId: 'conv-1', toolCall: { name: 'Edit' } };
  assert.deepEqual(handleHostHook('antigravity', root, input, 'PostToolUse'), {});
  const before = bridgeCommand('run.inspect', { project: root, runId });
  assert.equal(before.messages[0].status, 'queued');
  assert.equal(before.messages[0].deliveries.length, 0);
  assert.ok(before.owner.lastActivityAt);
  const result = handleHostHook('antigravity', root, input, 'PreInvocation');
  assert.match(result.injectSteps[0].userMessage, /Please verify the fix/);
  const after = bridgeCommand('run.inspect', { project: root, runId });
  assert.equal(after.messages[0].status, 'delivered');
  assert.equal(after.messages[0].deliveries.length, 1);
});
