import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFrontmatter, parseRoadmapMd, compileRoadmap,
  orderFeatures, nextFeature, setFeatureStatus, FEATURE_STATUSES, POOL_RUNNERS,
} from './roadmap.mjs';

const ROADMAP = `---
version: 1
title: Billing v2
base: main
merge: pr
---

## F1: Invoice data model
- depends_on: none
- mode: build
- max_parallel: 3
### Description
Add the Invoice and LineItem tables plus repository functions.
### Acceptance
- [ ] npm test passes with new repository tests
- [ ] The migration is reversible

## F2: Invoice PDF export
- depends_on: F1
- mode: build
### Description
Render an invoice as a PDF.
### Acceptance
- [ ] A golden-file test covers the layout
`;

// ---- frontmatter -----------------------------------------------------------

test('parseFrontmatter reads flat scalars and returns the remaining body', () => {
  const { data, body, errors } = parseFrontmatter(ROADMAP);
  assert.deepEqual(errors, []);
  assert.equal(data.title, 'Billing v2');
  assert.equal(data.base, 'main');
  assert.match(body, /^\s*## F1:/);
});

test('parseFrontmatter rejects nested keys with a line number instead of guessing', () => {
  const { errors } = parseFrontmatter('---\ntitle: x\nnested:\n  a: 1\n---\nbody\n');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].line, 3);
  assert.match(errors[0].message, /flat|nested/i);
});

test('a document with no frontmatter is an error, not a silent default', () => {
  const { errors } = parseFrontmatter('## F1: no frontmatter here\n');
  assert.ok(errors.length >= 1);
  assert.match(errors[0].message, /frontmatter/i);
});

// ---- features --------------------------------------------------------------

test('parseRoadmapMd reads features, descriptions, acceptance and dependencies', () => {
  const { roadmap, errors } = parseRoadmapMd(ROADMAP);
  assert.deepEqual(errors, []);
  assert.equal(roadmap.title, 'Billing v2');
  assert.equal(roadmap.base, 'main');
  assert.equal(roadmap.merge, 'pr');
  assert.equal(roadmap.features.length, 2);
  const [f1, f2] = roadmap.features;
  assert.equal(f1.id, 'F1');
  assert.equal(f1.title, 'Invoice data model');
  assert.equal(f1.mode, 'build');
  assert.equal(f1.maxParallel, 3);
  assert.deepEqual(f1.dependsOn, []);
  assert.match(f1.description, /Invoice and LineItem tables/);
  assert.equal(f1.acceptance.length, 2);
  assert.deepEqual(f2.dependsOn, ['F1']);
});

test('a feature with no runner bullet defaults to auto', () => {
  const { roadmap } = parseRoadmapMd(ROADMAP);
  assert.equal(roadmap.features[0].runner, 'auto');
});

test('a feature can declare a runner, including host', () => {
  const withRunner = ROADMAP.replace('- mode: build\n- max_parallel: 3', '- mode: build\n- max_parallel: 3\n- runner: host');
  const { roadmap, errors } = parseRoadmapMd(withRunner);
  assert.deepEqual(errors, []);
  assert.equal(roadmap.features[0].runner, 'host');
});

test('an unknown runner is rejected with a line number', () => {
  const bad = ROADMAP.replace('- mode: build\n- max_parallel: 3', '- mode: build\n- max_parallel: 3\n- runner: teleport');
  const { errors } = parseRoadmapMd(bad);
  assert.ok(errors.some((e) => /runner/i.test(e.message) && /teleport/.test(e.message)));
  assert.ok(errors.every((e) => typeof e.line === 'number'));
});

test('a feature with no description is rejected with its line number', () => {
  const bad = ROADMAP.replace('### Description\nAdd the Invoice and LineItem tables plus repository functions.\n', '');
  const { errors } = parseRoadmapMd(bad);
  assert.ok(errors.some((e) => /description/i.test(e.message)));
  assert.ok(errors.every((e) => typeof e.line === 'number'));
});

test('duplicate feature ids are rejected', () => {
  const { errors } = parseRoadmapMd(ROADMAP.replace('## F2:', '## F1:'));
  assert.ok(errors.some((e) => /duplicate/i.test(e.message)));
});

test('a dependency on an unknown feature is rejected', () => {
  const { errors } = parseRoadmapMd(ROADMAP.replace('- depends_on: F1', '- depends_on: F9'));
  assert.ok(errors.some((e) => /unknown|F9/i.test(e.message)));
});

test('an unknown mode is rejected', () => {
  const { errors } = parseRoadmapMd(ROADMAP.replace('- mode: build', '- mode: teleport'));
  assert.ok(errors.some((e) => /mode/i.test(e.message)));
});

test('an invalid feature id is rejected', () => {
  const { errors } = parseRoadmapMd(ROADMAP.replace('## F1:', '## 1 bad id:'));
  assert.ok(errors.length >= 1);
});

// ---- ordering --------------------------------------------------------------

test('orderFeatures returns a dependency-respecting order', () => {
  const { roadmap } = parseRoadmapMd(ROADMAP);
  assert.deepEqual(orderFeatures(roadmap.features), ['F1', 'F2']);
});

test('orderFeatures sorts a dependency declared out of order', () => {
  const features = [
    { id: 'B', dependsOn: ['A'] },
    { id: 'A', dependsOn: [] },
  ];
  assert.deepEqual(orderFeatures(features), ['A', 'B']);
});

test('a dependency cycle throws rather than deadlocking the pool', () => {
  const features = [{ id: 'A', dependsOn: ['B'] }, { id: 'B', dependsOn: ['A'] }];
  assert.throws(() => orderFeatures(features), /cycle/i);
});

// ---- compile ---------------------------------------------------------------

test('compileRoadmap produces a versioned document with queued features', () => {
  const { roadmap } = parseRoadmapMd(ROADMAP);
  const json = compileRoadmap(roadmap, null, { sourceSha256: 'abc' });
  assert.equal(json.contract, 'orchestrator-roadmap.v1');
  assert.equal(json.sourceSha256, 'abc');
  assert.equal(json.currentFeatureId, 'F1');
  assert.ok(json.features.every((f) => f.status === 'queued'));
  assert.equal(json.features[0].branch, 'pipeline/feature/F1');
  assert.equal(json.features[0].pr, null);
});

test('recompiling preserves progress instead of resetting it', () => {
  const { roadmap } = parseRoadmapMd(ROADMAP);
  let json = compileRoadmap(roadmap, null);
  json = setFeatureStatus(json, 'F1', 'landed', { landedSha: 'deadbeef', pr: { url: 'u' } });
  // The operator edits prose in roadmap.md and recompiles.
  const edited = parseRoadmapMd(ROADMAP.replace('Render an invoice as a PDF.', 'Render an invoice as a tasteful PDF.')).roadmap;
  const recompiled = compileRoadmap(edited, json);
  const f1 = recompiled.features.find((f) => f.id === 'F1');
  assert.equal(f1.status, 'landed');
  assert.equal(f1.landedSha, 'deadbeef');
  assert.equal(recompiled.features.find((f) => f.id === 'F2').description, 'Render an invoice as a tasteful PDF.');
  assert.equal(recompiled.currentFeatureId, 'F2');
});

test('a feature runner is live from source, not carried across recompiles', () => {
  const withRunner = ROADMAP.replace('- mode: build\n- max_parallel: 3', '- mode: build\n- max_parallel: 3\n- runner: host');
  let json = compileRoadmap(parseRoadmapMd(withRunner).roadmap, null);
  assert.equal(json.features[0].runner, 'host');
  // The operator adds CLI auth and edits the bullet to auto; recompiling picks it up.
  const backToAuto = withRunner.replace('- runner: host', '- runner: auto');
  json = compileRoadmap(parseRoadmapMd(backToAuto).roadmap, json);
  assert.equal(json.features[0].runner, 'auto');
});

test('a feature removed from the source is retained as an orphan, never silently dropped', () => {
  const { roadmap } = parseRoadmapMd(ROADMAP);
  let json = compileRoadmap(roadmap, null);
  json = setFeatureStatus(json, 'F2', 'executing', {});
  const trimmed = parseRoadmapMd(ROADMAP.split('## F2:')[0]).roadmap;
  const recompiled = compileRoadmap(trimmed, json);
  assert.equal(recompiled.features.length, 1);
  assert.equal(recompiled.orphans.length, 1);
  assert.equal(recompiled.orphans[0].id, 'F2');
});

// ---- scheduling ------------------------------------------------------------

test('nextFeature is the first queued feature whose dependencies have landed', () => {
  const { roadmap } = parseRoadmapMd(ROADMAP);
  let json = compileRoadmap(roadmap, null);
  assert.equal(nextFeature(json).id, 'F1');
  // F2 waits for F1 no matter what else is true.
  json = setFeatureStatus(json, 'F1', 'executing', {});
  assert.equal(nextFeature(json), null);
  json = setFeatureStatus(json, 'F1', 'landed', {});
  assert.equal(nextFeature(json).id, 'F2');
});

test('a skipped dependency does not block its dependents', () => {
  const { roadmap } = parseRoadmapMd(ROADMAP);
  let json = compileRoadmap(roadmap, null);
  json = setFeatureStatus(json, 'F1', 'skipped', {});
  assert.equal(nextFeature(json).id, 'F2');
});

test('a held or failed feature blocks its dependents rather than skipping ahead', () => {
  const { roadmap } = parseRoadmapMd(ROADMAP);
  for (const blocking of ['held', 'failed']) {
    let json = compileRoadmap(roadmap, null);
    json = setFeatureStatus(json, 'F1', blocking, {});
    assert.equal(nextFeature(json), null, `${blocking} should block F2`);
  }
});

test('setFeatureStatus is pure and rejects an unknown status', () => {
  const { roadmap } = parseRoadmapMd(ROADMAP);
  const json = compileRoadmap(roadmap, null);
  const updated = setFeatureStatus(json, 'F1', 'executing', {});
  assert.equal(json.features[0].status, 'queued', 'original must not be mutated');
  assert.equal(updated.features[0].status, 'executing');
  assert.throws(() => setFeatureStatus(json, 'F1', 'vibing', {}), /status/i);
  assert.ok(FEATURE_STATUSES.includes('awaiting_merge_approval'));
});

test('an ad-hoc single task compiles to a one-feature roadmap', () => {
  const { roadmap, errors } = parseRoadmapMd(`---
version: 1
title: Ad hoc
base: main
merge: local-only
---

## adhoc: Fix the login bug
- depends_on: none
### Description
Fix it.
`);
  assert.deepEqual(errors, []);
  const json = compileRoadmap(roadmap, null);
  assert.equal(json.features.length, 1);
  assert.equal(json.merge, 'local-only');
});
