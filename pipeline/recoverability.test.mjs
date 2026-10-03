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

// ---- one registry of halt reasons -------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HALT_REASONS, hintFor } from './recoverability.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

function haltReasonsWrittenBySources() {
  const found = new Map();
  const patterns = [
    /\bhalt\([^,\n]+,\s*'([A-Z][A-Z_]+)'/g,
    /haltReason\s*[:=]\s*'([A-Z][A-Z_]+)'/g,
  ];
  for (const file of fs.readdirSync(here).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'))) {
    const text = fs.readFileSync(path.join(here, file), 'utf8');
    for (const re of patterns) for (const m of text.matchAll(re)) found.set(m[1], file);
  }
  return found;
}

test('every halt reason the engine, supervisor, bridge or pool can write is registered', () => {
  const written = haltReasonsWrittenBySources();
  assert.ok(written.size >= 10, `the scan should find the known reasons (found ${[...written.keys()]})`);
  const missing = [...written].filter(([reason]) => !HALT_REASONS[reason]).map(([r, f]) => `${r} (${f})`);
  assert.deepEqual(missing, [], 'add these to HALT_REASONS in recoverability.mjs, with a hint');
});

test('every registered reason has its own hint, never the generic fallback', () => {
  const generic = hintFor('NOT_A_REAL_REASON');
  for (const reason of Object.keys(HALT_REASONS)) {
    assert.ok(hintFor(reason) && hintFor(reason) !== generic, `${reason} needs a specific hint`);
  }
});

test('a hint never tells a person to resume or extend what the table says cannot be', () => {
  for (const reason of Object.keys(HALT_REASONS)) {
    const r = recoveryFor(halted(reason, { haltedPhase: 'coder' }));
    if (r.resume || r.extend) continue;
    assert.doesNotMatch(hintFor(reason), /--resume|--extend/, `${reason} is not resumable, so its hint must not say to resume`);
  }
});

test('an unknown reason still gets a safe fallback that does not promise a resume', () => {
  assert.doesNotMatch(hintFor('SOMETHING_NEW'), /--resume/);
  assert.match(hintFor('SOMETHING_NEW'), /status\.json/);
});
