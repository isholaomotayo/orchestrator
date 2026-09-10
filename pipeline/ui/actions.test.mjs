import test from 'node:test';
import assert from 'node:assert/strict';
import { unavailableReason } from './actions.mjs';

// ---- continue -----------------------------------------------------------

test('continue: unavailable while a process is alive, names it as active', () => {
  const reason = unavailableReason('continue', { canCancel: true, status: { overall: 'running' } });
  assert.match(reason, /currently active/);
});

test('continue: unavailable when not awaiting a chat handoff, names the actual state', () => {
  const reason = unavailableReason('continue', { canCancel: false, status: { overall: 'halted' } });
  assert.match(reason, /currently: halted/);
});

test('continue: unavailable when the completed stage artifact is not ready', () => {
  const reason = unavailableReason('continue', {
    canCancel: false, status: { overall: 'awaiting_chat' }, stageReady: { ok: false, reason: 'missing a verdict line' },
  });
  assert.match(reason, /missing a verdict line/);
});

test('continue: no reason (available) when awaiting chat and the artifact is ready', () => {
  const reason = unavailableReason('continue', {
    canCancel: false, status: { overall: 'awaiting_chat' }, stageReady: { ok: true },
  });
  assert.equal(reason, null);
});

// ---- resume ---------------------------------------------------------------

test('resume: unavailable while alive says resume is not needed', () => {
  const reason = unavailableReason('resume', { canCancel: true, status: { overall: 'running' } });
  assert.match(reason, /not needed/);
});

test('resume: unavailable for a finished run says so', () => {
  const reason = unavailableReason('resume', { canCancel: false, status: { overall: 'done' } });
  assert.match(reason, /already finished/);
});

test('resume: unavailable for a halt reason other than INTERRUPTED names it', () => {
  const reason = unavailableReason('resume', { canCancel: false, status: { overall: 'halted', haltReason: 'MAX_CYCLES' } });
  assert.match(reason, /MAX_CYCLES/);
});

test('resume: no reason for an interrupted halt', () => {
  const reason = unavailableReason('resume', { canCancel: false, status: { overall: 'halted', haltReason: 'INTERRUPTED' } });
  assert.equal(reason, null);
});

test('resume: no reason for a stale (stuck) running process', () => {
  const reason = unavailableReason('resume', { canCancel: false, stale: true, status: { overall: 'running' } });
  assert.equal(reason, null);
});

// ---- extend -----------------------------------------------------------------

test('extend: unavailable when not halted at all', () => {
  const reason = unavailableReason('extend', { status: { overall: 'running' } });
  assert.match(reason, /halts at its cycle limit/);
});

test('extend: unavailable for a halt reason other than MAX_CYCLES names it', () => {
  const reason = unavailableReason('extend', { status: { overall: 'halted', haltReason: 'AGENT_ERROR' } });
  assert.match(reason, /AGENT_ERROR/);
});

test('extend: no reason when halted with MAX_CYCLES', () => {
  const reason = unavailableReason('extend', { status: { overall: 'halted', haltReason: 'MAX_CYCLES' } });
  assert.equal(reason, null);
});

// ---- cancel -------------------------------------------------------------

test('cancel: always explains nothing is running, since it is only ever shown when unavailable', () => {
  assert.match(unavailableReason('cancel', {}), /Nothing is currently running/);
});
