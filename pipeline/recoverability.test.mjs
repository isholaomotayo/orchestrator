import test from 'node:test';
import assert from 'node:assert/strict';
import { recoveryFor } from './recoverability.mjs';

const halted = (haltReason, extra = {}) => ({ overall: 'halted', haltReason, ...extra });

test('a running run is resumable only when its engine is gone (stale)', () => {
  assert.equal(recoveryFor({ overall: 'running' }, { engineAlive: true }).resume, false);
  const stale = recoveryFor({ overall: 'running' }, { engineAlive: false });
  assert.equal(stale.resume, true);
  assert.equal(stale.stale, true);
});

test('transient agent errors auto-resume; non-transient ones resume only by hand', () => {
  assert.deepEqual(
    [recoveryFor(halted('AGENT_ERROR', { haltTransient: true })).autoResume, recoveryFor(halted('AGENT_ERROR', { haltTransient: true })).resume],
    [true, true]);
  const fatal = recoveryFor(halted('AGENT_ERROR', { haltTransient: false }));
  assert.equal(fatal.resume, true);
  assert.equal(fatal.autoResume, false);
});

test('interrupted and engine-error halts resume', () => {
  assert.equal(recoveryFor(halted('INTERRUPTED')).resume, true);
  assert.equal(recoveryFor(halted('ENGINE_ERROR')).resume, true);
});

test('a missing artifact or unparseable verdict resumes only once the artifact validates', () => {
  for (const reason of ['MISSING_ARTIFACT', 'INVALID_VERDICT']) {
    const r = recoveryFor(halted(reason));
    assert.equal(r.resume, true, reason);
    assert.equal(r.needsValidArtifact, true, reason);
  }
});

test('MAX_CYCLES extends but does not plain-resume', () => {
  const r = recoveryFor(halted('MAX_CYCLES', { haltedPhase: 'coder' }));
  assert.equal(r.extend, true);
  assert.equal(r.resume, false);
});

test('regressions, integrity violations, dismissals and finished runs are never resumed', () => {
  for (const reason of ['REGRESSION_BLOCKED', 'INTEGRITY_VIOLATION', 'DISMISSED', 'Dismissed from dashboard']) {
    const r = recoveryFor(halted(reason));
    assert.equal(r.resume || r.extend || r.autoResume, false, reason);
    assert.ok(r.reason, reason);
  }
  assert.equal(recoveryFor({ overall: 'done' }).resume, false);
});
