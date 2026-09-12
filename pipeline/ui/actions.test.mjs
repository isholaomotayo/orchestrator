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

test('continue: still returns a real string, not null, once every modeled blocking condition is absent', () => {
  // This is the drift-safety case: if the server ever disables the action
  // for a reason this file doesn't model, the input looks exactly like
  // this — every known blocking condition absent, yet canContinue is still
  // false. A caller only displays this string when canContinue is already
  // false, so returning null here would silently recreate the "disabled
  // button, no explanation" bug this module exists to prevent.
  const reason = unavailableReason('continue', {
    canCancel: false, status: { overall: 'awaiting_chat' }, stageReady: { ok: true },
  });
  assert.equal(typeof reason, 'string');
  assert.ok(reason.length > 0);
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

test('resume: still a real string, not null, for an interrupted halt (no blocking condition matched)', () => {
  const reason = unavailableReason('resume', { canCancel: false, status: { overall: 'halted', haltReason: 'INTERRUPTED' } });
  assert.equal(typeof reason, 'string');
  assert.ok(reason.length > 0);
});

test('resume: still a real string, not null, for a stale (stuck) running process', () => {
  const reason = unavailableReason('resume', { canCancel: false, stale: true, status: { overall: 'running' } });
  assert.equal(typeof reason, 'string');
  assert.ok(reason.length > 0);
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

test('extend: still a real string, not null, when halted with MAX_CYCLES', () => {
  const reason = unavailableReason('extend', { status: { overall: 'halted', haltReason: 'MAX_CYCLES' } });
  assert.equal(typeof reason, 'string');
  assert.ok(reason.length > 0);
});

// ---- cancel -------------------------------------------------------------

test('cancel: always explains nothing is running, since it is only ever shown when unavailable', () => {
  assert.match(unavailableReason('cancel', {}), /Nothing is currently running/);
});

// ---- never returns null, for any action --------------------------------

test('unavailableReason never returns null for any of the four actions, even with an empty data object', () => {
  for (const action of ['continue', 'resume', 'extend', 'cancel']) {
    const reason = unavailableReason(action, {});
    assert.equal(typeof reason, 'string', `${action} must always return a string`);
    assert.ok(reason.length > 0, `${action}'s reason must not be empty`);
  }
});
