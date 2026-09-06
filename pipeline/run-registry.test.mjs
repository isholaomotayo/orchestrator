import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipelinePaths } from './state.mjs';
import {
  newRunId, isValidRunId, RUN_VERBS,
  writeRunMeta, readRunMeta, appendRunVerb, parseStatusLog, latestVerb,
  renderBrief, parseBrief,
} from './run-registry.mjs';

function tmpRun(runId = 'r1') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-'));
  const paths = pipelinePaths(root, { runId });
  fs.mkdirSync(paths.dir, { recursive: true });
  return paths;
}

// ---- run ids ---------------------------------------------------------------

test('newRunId encodes timestamp, feature and ticket and stays filesystem-safe', () => {
  const id = newRunId({ featureId: 'F1', ticketId: 'T02', now: new Date('2026-09-06T07:05:12Z') });
  assert.match(id, /^20260906T070512Z-F1-T02-[0-9a-f]{8}$/);
  // The dashboard only serves run dirs matching this shape.
  assert.match(id, /^[\w.-]+$/);
  assert.equal(isValidRunId(id), true);
});

test('newRunId falls back to the run kind when there is no ticket', () => {
  assert.match(newRunId({ featureId: 'F1', kind: 'plan' }), /-F1-plan-[0-9a-f]{8}$/);
  assert.match(newRunId({ kind: 'adhoc' }), /^\d{8}T\d{6}Z-adhoc-[0-9a-f]{8}$/);
});

test('newRunId sorts chronologically as a plain string', () => {
  const early = newRunId({ kind: 'adhoc', now: new Date('2026-09-06T07:00:00Z') });
  const late = newRunId({ kind: 'adhoc', now: new Date('2026-09-06T08:00:00Z') });
  assert.ok(early < late);
});

test('newRunId is unique across many draws in the same millisecond', () => {
  // Same timestamp and same kind, so only the random suffix separates them.
  // With 4 random bytes the birthday bound over 1000 draws puts the expected
  // number of collisions at ~0.0001, so tolerating one and no more keeps this
  // assertion both meaningful and stable.
  const now = new Date('2026-09-06T07:05:12Z');
  const ids = new Set(Array.from({ length: 1000 }, () => newRunId({ kind: 'adhoc', now })));
  assert.ok(ids.size >= 999, `expected near-unique ids, got ${ids.size}/1000`);
});

test('newRunId sanitizes feature and ticket ids that would break a path', () => {
  const id = newRunId({ featureId: '../etc', ticketId: 'a b/c', kind: 'ticket' });
  assert.match(id, /^[\w.-]+$/);
  assert.ok(!id.includes('..'));
  assert.ok(!id.includes('/'));
});

test('isValidRunId rejects traversal, separators and empty input', () => {
  for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'a b', '../../etc/passwd']) {
    assert.equal(isValidRunId(bad), false, `should reject ${JSON.stringify(bad)}`);
  }
});

// ---- run meta --------------------------------------------------------------

test('run meta round-trips and carries the contract marker', () => {
  const paths = tmpRun();
  writeRunMeta(paths, { runId: 'r1', featureId: 'F1', ticketId: 'T02', kind: 'ticket', mode: 'build', branch: 'pipeline/F1/r1', pid: 42 });
  const meta = readRunMeta(paths);
  assert.equal(meta.contract, 'orchestrator-run-meta.v1');
  assert.equal(meta.featureId, 'F1');
  assert.equal(meta.phase, 'spawned');
  assert.equal(meta.attempts, 1);
  assert.equal(meta.pr, null);
});

test('writeRunMeta merges over the existing record instead of replacing it', () => {
  const paths = tmpRun();
  writeRunMeta(paths, { runId: 'r1', featureId: 'F1', pid: 42 });
  writeRunMeta(paths, { phase: 'committed', committedSha: 'abc123' });
  const meta = readRunMeta(paths);
  assert.equal(meta.featureId, 'F1');
  assert.equal(meta.pid, 42);
  assert.equal(meta.phase, 'committed');
  assert.equal(meta.committedSha, 'abc123');
});

test('readRunMeta returns null when there is no run meta', () => {
  assert.equal(readRunMeta(tmpRun()), null);
  assert.equal(readRunMeta(pipelinePaths('/repo')), null);
});

// ---- verb log --------------------------------------------------------------

test('appendRunVerb writes a timestamped line per event and parses back', () => {
  const paths = tmpRun();
  appendRunVerb(paths, 'working', 'coder cycle 1');
  appendRunVerb(paths, 'needs-decision', 'plan-approval');
  const entries = parseStatusLog(fs.readFileSync(paths.runStatusLog, 'utf8'));
  assert.equal(entries.length, 2);
  assert.equal(entries[0].verb, 'working');
  assert.equal(entries[0].detail, 'coder cycle 1');
  assert.equal(entries[1].verb, 'needs-decision');
  assert.ok(!Number.isNaN(Date.parse(entries[0].ts)));
});

test('appendRunVerb rejects a verb outside the fixed set', () => {
  const paths = tmpRun();
  assert.throws(() => appendRunVerb(paths, 'vibing', 'nope'), /unknown run verb/i);
  assert.ok(RUN_VERBS.includes('done') && RUN_VERBS.includes('failed') && RUN_VERBS.includes('landed'));
});

test('appendRunVerb collapses newlines so one event is always one line', () => {
  const paths = tmpRun();
  appendRunVerb(paths, 'note', 'line one\nline two');
  const raw = fs.readFileSync(paths.runStatusLog, 'utf8');
  assert.equal(raw.trimEnd().split('\n').length, 1);
  assert.match(parseStatusLog(raw)[0].detail, /line one . line two/);
});

test('appendRunVerb is a no-op for a run-less (v1) path set', () => {
  const paths = pipelinePaths(fs.mkdtempSync(path.join(os.tmpdir(), 'registry-v1-')));
  assert.doesNotThrow(() => appendRunVerb(paths, 'working', 'x'));
});

test('parseStatusLog skips malformed lines rather than throwing', () => {
  const entries = parseStatusLog('garbage\n2026-09-06T07:00:00.000Z working: fine\n\n');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].verb, 'working');
});

test('latestVerb returns the last entry and null on an empty log', () => {
  const entries = parseStatusLog([
    '2026-09-06T07:00:00.000Z working: a',
    '2026-09-06T07:01:00.000Z blocked: b',
  ].join('\n'));
  assert.equal(latestVerb(entries).verb, 'blocked');
  assert.equal(latestVerb([]), null);
});

// ---- briefs ----------------------------------------------------------------

const brief = { run: 'r1', feature: 'F1', ticket: 'T02', mode: 'build', base: 'abc123', branch: 'pipeline/F1/r1' };

test('a brief round-trips header and body across the separator', () => {
  const text = renderBrief({ title: 'Invoice model', header: brief, body: 'Do the thing.\n\nCarefully.' });
  const parsed = parseBrief(text);
  assert.deepEqual(parsed.header, brief);
  assert.equal(parsed.body, 'Do the thing.\n\nCarefully.');
  assert.match(text, /^# Brief: Invoice model\n/);
});

test('the brief body never contains the machine header', () => {
  const parsed = parseBrief(renderBrief({ title: 't', header: brief, body: 'body only' }));
  assert.ok(!parsed.body.includes('run: r1'));
  assert.ok(!parsed.body.includes('# Brief:'));
});

test('parseBrief rejects a brief whose run id does not match the expected run', () => {
  const text = renderBrief({ title: 't', header: brief, body: 'b' });
  assert.doesNotThrow(() => parseBrief(text, { expectRunId: 'r1' }));
  assert.throws(() => parseBrief(text, { expectRunId: 'r2' }), /run id mismatch/i);
});

test('parseBrief rejects a brief with no header separator', () => {
  assert.throws(() => parseBrief('# Brief: t\njust prose, no header'), /missing header separator/i);
});
