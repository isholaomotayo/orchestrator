import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compileHaltHandoff, collectGitInfo, writeHaltHandoff } from './handoff.mjs';
import { newStatus } from './state.mjs';

function haltedStatus(reason, patch = {}) {
  const s = newStatus('add rate limiting');
  s.overall = 'halted';
  s.haltReason = reason;
  Object.assign(s, patch);
  return s;
}

test('compileHaltHandoff renders MAX_CYCLES with extend resume hint', () => {
  const s = haltedStatus('MAX_CYCLES', { haltedPhase: 'coder' });
  s.stages.find((x) => x.name === 'coder').status = 'failed';
  const doc = compileHaltHandoff({ status: s, history: { coder: [{ passedCount: 3, failedCount: 2, isPassed: false, at: 't' }], postTester: [] } });
  assert.match(doc, /# Pipeline Handoff/);
  assert.match(doc, /halted — MAX_CYCLES/);
  assert.match(doc, /Phase at freeze:\*\* coder/);
  assert.match(doc, /--resume --extend/);
  assert.match(doc, /3 passed \/ 2 failed/);
});

test('compileHaltHandoff renders REGRESSION_BLOCKED as not extendable', () => {
  const doc = compileHaltHandoff({ status: haltedStatus('REGRESSION_BLOCKED') });
  assert.match(doc, /not extendable/i);
});

test('compileHaltHandoff tolerates missing history and git info', () => {
  const doc = compileHaltHandoff({ status: haltedStatus('AGENT_ERROR') });
  assert.match(doc, /No checker runs recorded/);
  assert.match(doc, /Not a git repository/);
});

test('compileHaltHandoff includes the stage table and git state', () => {
  const s = haltedStatus('INTERRUPTED', { baseRef: 'abc123' });
  const doc = compileHaltHandoff({ status: s, git: { branch: 'feat/x', dirty: true } });
  assert.match(doc, /\| planner \| pending \|/);
  assert.match(doc, /Branch: feat\/x/);
  assert.match(doc, /DIRTY/);
  assert.match(doc, /abc123/);
});

test('collectGitInfo returns branch/dirty inside a repo and null outside', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ho-git-'));
  assert.equal(collectGitInfo(dir), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeHaltHandoff writes the doc and never throws', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ho-write-'));
  const paths = { root: dir, handoffDoc: path.join(dir, 'handoff.md') };
  const ok = writeHaltHandoff({ paths, status: haltedStatus('MISSING_ARTIFACT') });
  assert.equal(ok, true);
  assert.match(fs.readFileSync(paths.handoffDoc, 'utf8'), /MISSING_ARTIFACT/);
  // Unwritable target: returns false instead of throwing (never mask the original halt).
  assert.equal(writeHaltHandoff({ paths: { root: dir, handoffDoc: path.join(dir, 'nope', 'x.md') }, status: haltedStatus('AGENT_ERROR') }), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
