import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipelinePaths } from './state.mjs';
import { openDecision } from './attention.mjs';
import {
  compile, readRoadmap, writeRoadmap, snapshot, writePrimaryMirror,
  decide, approvePlan, approveMerge, requestChanges,
  holdFeature, releaseFeature, skipFeature, addNote, pause, resume,
  listRunStates, supervisorState, queueFollowup, requestExtend,
} from './pool.mjs';
import { setFeatureStatus } from './roadmap.mjs';

const ROADMAP = `---
version: 1
title: Billing v2
base: main
merge: pr
---

## F1: Invoice model
- depends_on: none
### Description
Add invoices.
### Acceptance
- [ ] tests pass

## F2: PDF export
- depends_on: F1
### Description
Render PDFs.
`;

function tmpPool() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-'));
  const paths = pipelinePaths(root);
  fs.mkdirSync(paths.control, { recursive: true });
  fs.writeFileSync(paths.roadmapMd, ROADMAP);
  return paths;
}

function fakeRun(paths, runId, { overall = 'running', verb = 'working', featureId = 'F1', pid = process.pid, stage = 'coder' } = {}) {
  const rp = pipelinePaths(paths.root, { runId });
  fs.mkdirSync(rp.dir, { recursive: true });
  fs.writeFileSync(rp.status, JSON.stringify({
    overall, featureId, stages: [{ name: stage, status: overall === 'running' ? 'running' : 'passed', cycle: 1, maxCycles: 5 }],
  }));
  fs.writeFileSync(rp.runMeta, JSON.stringify({ runId, featureId, ticketId: 'T1', kind: 'ticket', pid, branch: `pipeline/${featureId}/${runId}` }));
  fs.writeFileSync(rp.lock, JSON.stringify({ pid }));
  fs.writeFileSync(rp.runStatusLog, `${new Date().toISOString()} ${verb}: ${stage}\n`);
  fs.writeFileSync(rp.events, '{}\n');
  return rp;
}

// ---- compile ---------------------------------------------------------------

test('compile turns the markdown roadmap into control state', () => {
  const paths = tmpPool();
  const res = compile(paths);
  assert.equal(res.ok, true);
  const roadmap = readRoadmap(paths);
  assert.equal(roadmap.features.length, 2);
  assert.equal(roadmap.currentFeatureId, 'F1');
  assert.ok(roadmap.sourceSha256);
  fs.rmSync(paths.root, { recursive: true, force: true });
});

test('compile reports parse errors with line numbers rather than writing state', () => {
  const paths = tmpPool();
  fs.writeFileSync(paths.roadmapMd, ROADMAP.replace('- depends_on: F1', '- depends_on: F9'));
  const res = compile(paths);
  assert.equal(res.ok, false);
  assert.ok(res.errors[0].line > 0);
  assert.equal(readRoadmap(paths), null, 'invalid input must not overwrite good state');
  fs.rmSync(paths.root, { recursive: true, force: true });
});

test('compile with no roadmap file explains what to do instead of throwing', () => {
  const paths = tmpPool();
  fs.unlinkSync(paths.roadmapMd);
  const res = compile(paths);
  assert.equal(res.ok, false);
  assert.match(res.errors[0].message, /roadmap/i);
  fs.rmSync(paths.root, { recursive: true, force: true });
});

// ---- run inventory ---------------------------------------------------------

test('listRunStates reads every run and classifies it', () => {
  const paths = tmpPool();
  fakeRun(paths, 'r1');
  fakeRun(paths, 'r2', { overall: 'done', verb: 'done', pid: 0 });
  const runs = listRunStates(paths);
  assert.equal(runs.length, 2);
  assert.equal(runs.find((r) => r.runId === 'r1').state, 'busy');
  assert.equal(runs.find((r) => r.runId === 'r2').state, 'idle');
  fs.rmSync(paths.root, { recursive: true, force: true });
});

test('a run whose process is gone while marked running is reported dead, not busy', () => {
  const paths = tmpPool();
  fakeRun(paths, 'r1', { pid: 0 });
  assert.equal(listRunStates(paths)[0].state, 'dead');
  fs.rmSync(paths.root, { recursive: true, force: true });
});

// ---- snapshot and mirror ---------------------------------------------------

test('the snapshot reflects the roadmap and the live runs', () => {
  const paths = tmpPool();
  compile(paths);
  fs.writeFileSync(paths.supervisorPid, String(process.pid));
  fakeRun(paths, 'r1');
  const snap = snapshot(paths);
  assert.equal(snap.roadmap.title, 'Billing v2');
  assert.equal(snap.counts.inProgress, 1);
  assert.equal(snap.upNext.length, 2);
  fs.rmSync(paths.root, { recursive: true, force: true });
});

test('the primary mirror keeps v1 guards truthful while a pool runs', () => {
  const paths = tmpPool();
  compile(paths);
  fs.writeFileSync(paths.supervisorPid, String(process.pid));
  fakeRun(paths, 'r1');
  const snap = snapshot(paths);
  const mirror = writePrimaryMirror(paths, { snap, runs: listRunStates(paths), config: {} });
  assert.equal(mirror.overall, 'running');
  assert.equal(mirror.pool.featureId, 'F1');
  assert.deepEqual(mirror.pool.runIds, ['r1']);
  // A v1 reader parses this file and sees an active run.
  const onDisk = JSON.parse(fs.readFileSync(paths.status, 'utf8'));
  assert.equal(onDisk.overall, 'running');
  assert.equal(onDisk.stages.length, 6);
  fs.rmSync(paths.root, { recursive: true, force: true });
});

test('the mirror reports done only when every feature has landed or been skipped', () => {
  const paths = tmpPool();
  compile(paths);
  let roadmap = readRoadmap(paths);
  roadmap = setFeatureStatus(roadmap, 'F1', 'landed', {});
  roadmap = setFeatureStatus(roadmap, 'F2', 'skipped', {});
  writeRoadmap(paths, roadmap);
  fs.writeFileSync(paths.supervisorPid, String(process.pid));
  const snap = snapshot(paths);
  const mirror = writePrimaryMirror(paths, { snap, runs: [], config: {} });
  assert.equal(mirror.overall, 'done');
  fs.rmSync(paths.root, { recursive: true, force: true });
});

test('a paused pool is reported as halted, not quietly running', () => {
  const paths = tmpPool();
  compile(paths);
  fs.writeFileSync(paths.supervisorPid, String(process.pid));
  pause(paths, 'operator paused');
  const mirror = writePrimaryMirror(paths, { snap: snapshot(paths), runs: [], config: {} });
  assert.equal(mirror.overall, 'halted');
  assert.equal(mirror.haltReason, 'POOL_PAUSED');
  resume(paths);
  assert.equal(supervisorState(paths).paused, false);
  fs.rmSync(paths.root, { recursive: true, force: true });
});

// ---- operator verbs --------------------------------------------------------

test('answering a decision records it AND queues the answer for the worker', () => {
  const paths = tmpPool();
  const rp = fakeRun(paths, 'r1');
  const d = openDecision(paths, { runId: 'r1', featureId: 'F1', kind: 'plan-approval', stage: 'planner', question: 'ok?', options: ['approve', 'revise'] });
  decide(paths, d.id, 'revise: use a different table name');
  // The ledger knows.
  assert.equal(readRoadmapDecisionsOpen(paths), 0);
  // The worker will actually see it.
  const note = fs.readFileSync(path.join(rp.dir, 'followups', 'planner.txt'), 'utf8');
  assert.match(note, /different table name/);
  // And the run is asked to resume.
  assert.match(JSON.parse(fs.readFileSync(rp.runMeta, 'utf8')).requests.resume.why, /decision/i);
  fs.rmSync(paths.root, { recursive: true, force: true });
});

function readRoadmapDecisionsOpen(paths) {
  return snapshot(paths).needsDecision.length;
}

test('approving a plan resolves the open gate for that run', () => {
  const paths = tmpPool();
  fakeRun(paths, 'r1');
  openDecision(paths, { runId: 'r1', featureId: 'F1', kind: 'plan-approval', stage: 'planner', question: 'ok?', options: [] });
  approvePlan(paths, 'r1');
  assert.equal(snapshot(paths).needsDecision.length, 0);
  fs.rmSync(paths.root, { recursive: true, force: true });
});

test('merge approval is refused unless the feature is actually waiting for it', () => {
  const paths = tmpPool();
  compile(paths);
  assert.throws(() => approveMerge(paths, 'F1'), /not awaiting merge approval/i);
  assert.throws(() => approveMerge(paths, 'F9'), /unknown feature/i);
  fs.rmSync(paths.root, { recursive: true, force: true });
});

test('a mirror with no live supervisor is reported halted, never quietly running', () => {
  const paths = tmpPool();
  compile(paths);
  fakeRun(paths, 'r1');
  const mirror = writePrimaryMirror(paths, { snap: snapshot(paths), runs: listRunStates(paths), config: {} });
  assert.equal(mirror.overall, 'halted');
  assert.equal(mirror.haltReason, 'POOL_STOPPED');
  fs.rmSync(paths.root, { recursive: true, force: true });
});

test('merge approval records consent but does not itself merge', () => {
  const paths = tmpPool();
  compile(paths);
  writeRoadmap(paths, setFeatureStatus(readRoadmap(paths), 'F1', 'awaiting_merge_approval', {}));
  const res = approveMerge(paths, 'F1', { by: 'operator', via: 'dashboard' });
  assert.equal(res.approved, true);
  const feature = readRoadmap(paths).features.find((f) => f.id === 'F1');
  assert.equal(feature.status, 'merge_approved', 'approval moves to a state the supervisor still has to verify');
  assert.equal(feature.mergeApproval.via, 'dashboard');
  fs.rmSync(paths.root, { recursive: true, force: true });
});

test('requesting changes sends the note to the coder and reopens review', () => {
  const paths = tmpPool();
  compile(paths);
  const rp = fakeRun(paths, 'r1');
  writeRoadmap(paths, setFeatureStatus(readRoadmap(paths), 'F1', 'awaiting_merge_approval', { integrationRunId: 'r1' }));
  requestChanges(paths, 'F1', 'rename the column');
  assert.match(fs.readFileSync(path.join(rp.dir, 'followups', 'coder.txt'), 'utf8'), /rename the column/);
  assert.equal(readRoadmap(paths).features.find((f) => f.id === 'F1').status, 'reviewing');
  fs.rmSync(paths.root, { recursive: true, force: true });
});

test('hold, release and skip move a feature without touching its work', () => {
  const paths = tmpPool();
  compile(paths);
  holdFeature(paths, 'F1', 'waiting on design');
  assert.equal(readRoadmap(paths).features[0].status, 'held');
  releaseFeature(paths, 'F1');
  assert.equal(readRoadmap(paths).features[0].status, 'queued');
  skipFeature(paths, 'F1', 'not needed');
  assert.equal(readRoadmap(paths).features[0].status, 'skipped');
  assert.throws(() => releaseFeature(paths, 'F1'), /not held/i);
  fs.rmSync(paths.root, { recursive: true, force: true });
});

test('extend is recorded as a request for the supervisor, not run directly', () => {
  const paths = tmpPool();
  const rp = fakeRun(paths, 'r1');
  requestExtend(paths, 'r1', 3);
  assert.equal(JSON.parse(fs.readFileSync(rp.runMeta, 'utf8')).requests.extend.cycles, 3);
  fs.rmSync(paths.root, { recursive: true, force: true });
});

test('notes are written as committable markdown with provenance', () => {
  const paths = tmpPool();
  const res = addNote(paths, { kind: 'gotcha', text: 'The migration must run before the backfill', runId: 'r1' });
  const body = fs.readFileSync(path.join(paths.root, res.file), 'utf8');
  assert.match(body, /kind: gotcha/);
  assert.match(body, /runId: r1/);
  assert.match(body, /migration must run/);
  fs.rmSync(paths.root, { recursive: true, force: true });
});

test('a queued follow-up lands where the worker reads it', () => {
  const paths = tmpPool();
  const rp = fakeRun(paths, 'r1');
  queueFollowup(paths, 'r1', 'tester', 'also cover the empty case');
  assert.match(fs.readFileSync(path.join(rp.dir, 'followups', 'tester.txt'), 'utf8'), /empty case/);
  fs.rmSync(paths.root, { recursive: true, force: true });
});
