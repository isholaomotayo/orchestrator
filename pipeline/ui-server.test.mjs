// The dashboard server, tested as the real thing: a live process serving a
// temporary project over HTTP. Nothing is stubbed, so a route that works here
// works in the browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pipelinePaths } from './state.mjs';
import { bridgeCommand } from './bridge.mjs';
import { loadSchema, validate } from './contract-schema.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

function makeProject() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ui-')));
  const paths = pipelinePaths(root);
  fs.mkdirSync(paths.control, { recursive: true });
  fs.mkdirSync(paths.prompts, { recursive: true });
  fs.writeFileSync(paths.config, JSON.stringify({ uiIdleTimeoutMs: 0 }));

  // A finished run with artifacts, a log and a report.
  const run = pipelinePaths(root, { runId: 'r1' });
  fs.mkdirSync(path.join(run.dir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(run.reports, 'diagrams'), { recursive: true });
  fs.writeFileSync(run.status, JSON.stringify({ overall: 'done', verdict: 'APPROVED', featureId: 'F1', stages: [] }));
  fs.writeFileSync(run.specs, '# Spec');
  fs.writeFileSync(run.events, '');
  fs.writeFileSync(path.join(run.dir, 'logs', 'coder.log'), 'line one\nline two\nline three\n');
  fs.writeFileSync(path.join(run.reports, 'work-done.html'), '<!doctype html><title>Report</title><p>done</p>');
  fs.writeFileSync(path.join(run.reports, 'diagrams', 'map.html'), '<!doctype html><title>Map</title>');
  fs.writeFileSync(path.join(root, 'secret.txt'), 'do not serve me');

  // A roadmap with a feature waiting on the operator.
  fs.writeFileSync(paths.roadmapJson, JSON.stringify({
    contract: 'orchestrator-roadmap.v1', title: 'Demo', base: 'main', merge: 'local-only',
    currentFeatureId: 'F1',
    features: [{ id: 'F1', title: 'First', status: 'awaiting_merge_approval', dependsOn: [], branch: 'pipeline/feature/F1', tickets: [], integrationRunId: 'r1' }],
    orphans: [],
  }, null, 2));
  fs.writeFileSync(paths.decisions, `${JSON.stringify({
    decisionId: 'd1', ts: '2026-09-06T10:00:00Z', status: 'open', runId: 'r1', featureId: 'F1',
    kind: 'merge-approval', stage: 'reviewer', question: 'Merge F1?', options: ['approve', 'request-changes'],
  })}\n`);
  return { root, paths };
}

async function startServer(root, port, extraEnv = {}) {
  const child = spawn(process.execPath, [path.join(HERE, 'ui-server.mjs')], {
    cwd: root,
    env: { ...process.env, PIPELINE_UI_PORT: String(port), PIPELINE_UI_IDLE_TIMEOUT_MS: '0', ORCHESTRATOR_HOME: path.join(root, '.orch-home'), ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.ok) return child;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  child.kill();
  throw new Error('the dashboard server did not start');
}

function withServer(fn, { env = {} } = {}) {
  return async (t) => {
    const { root, paths } = makeProject();
    const port = await freePort();
    const child = await startServer(root, port, env);
    const base = `http://127.0.0.1:${port}`;
    const get = (p) => fetch(`${base}${p}${p.includes('?') ? '&' : '?'}project=${encodeURIComponent(root)}`);
    // Legacy POSTs take the server's token, read from its owner-only record.
    const token = () => serverRecord(root).record.token;
    const post = (p, body, headers = {}) => fetch(`${base}${p}?project=${encodeURIComponent(root)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Host: `127.0.0.1:${port}`, Authorization: `Bearer ${token()}`, ...headers }, body: JSON.stringify(body),
    });
    t.after(() => { child.kill(); fs.rmSync(root, { recursive: true, force: true }); });
    await fn({ base, get, post, root, paths, port });
  };
}

test('healthz answers the discovery contract orchestrate.sh depends on', withServer(async ({ base }) => {
  const body = await (await fetch(`${base}/healthz`)).json();
  assert.equal(body.service, 'pipeline-ui');
  assert.match(body.projectId, /^[0-9a-f]{16}$/);
  assert.equal(body.repoRoot, undefined, 'the unauthenticated probe does not reveal paths');
}));

test('legacy POST routes refuse a request without the server token', withServer(async ({ post }) => {
  const res = await post('/api/pool/pause', {}, { Authorization: '' });
  assert.equal(res.status, 401);
  assert.equal((await post('/api/pool/pause', {})).status, 200);
}));

test('the pool endpoint reports the roadmap and what needs a decision', withServer(async ({ get }) => {
  const body = await (await get('/api/pool')).json();
  assert.equal(body.enabled, true);
  assert.equal(body.snapshot.contract, 'orchestrator-pool-snapshot.v1');
  assert.equal(body.snapshot.needsDecision.length, 1);
  assert.equal(body.snapshot.needsDecision[0].question, 'Merge F1?');
  assert.equal(body.roadmap.features[0].id, 'F1');
}));

test('/api/runs lists an archived pool run and a live legacy run together', withServer(async ({ get, root }) => {
  // makeProject() already has runs/r1 (done); a plain single-run project also
  // keeps a live run at the project root, not under paths.runs — without
  // surfacing it there, its state is servable (readState already handles no
  // runId) but nothing in the sidebar ever opens it.
  fs.writeFileSync(path.join(root, '.pipeline', 'status.json'), JSON.stringify({ task: 'Legacy task', overall: 'running', verdict: null }));
  const body = await (await get('/api/runs')).json();
  assert.equal(body.runs.length, 2);
  assert.equal(body.runs[0].id, '', 'the live legacy run is listed first');
  assert.equal(body.runs[0].kind, 'single');
  assert.equal(body.runs[0].task, 'Legacy task');
  assert.equal(body.runs[0].live, true);
  assert.ok(body.runs.some((r) => r.id === 'r1' && r.kind === 'pool' && r.live === false));
}));

test('/api/runs never lists a legacy run once it has finished', withServer(async ({ get, root }) => {
  fs.writeFileSync(path.join(root, '.pipeline', 'status.json'), JSON.stringify({ task: 'Legacy task', overall: 'halted', haltReason: 'MAX_CYCLES' }));
  const body = await (await get('/api/runs')).json();
  const primary = body.runs.find((r) => r.id === '');
  assert.equal(primary.overall, 'halted');
  assert.equal(primary.live, false, 'a halted run is history, not something to steer');
}));

test('a project with no pool reports it plainly rather than erroring', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ui-bare-')));
  fs.mkdirSync(path.join(root, '.pipeline'), { recursive: true });
  const port = await freePort();
  const child = await startServer(root, port);
  t.after(() => { child.kill(); fs.rmSync(root, { recursive: true, force: true }); });
  const body = await (await fetch(`http://127.0.0.1:${port}/api/pool?project=${encodeURIComponent(root)}`)).json();
  assert.equal(body.enabled, false);
});

test('open decisions are listed for the decisions inbox', withServer(async ({ get }) => {
  const body = await (await get('/api/decisions')).json();
  assert.equal(body.decisions.length, 1);
  assert.equal(body.decisions[0].decisionId, 'd1');
}));

test('a stage log is served as a bounded window, not the whole file', withServer(async ({ get }) => {
  const body = await (await get('/api/log?run=r1&stage=coder')).json();
  assert.match(body.text, /line one/);
  assert.equal(body.size, body.next);
  const windowed = await (await get('/api/log?run=r1&stage=coder&offset=0&limit=8')).json();
  assert.equal(windowed.text.length, 8);
  assert.equal(windowed.next, 8);
}));

test('an unknown stage log is refused', withServer(async ({ get }) => {
  assert.equal((await get('/api/log?run=r1&stage=etc%2Fpasswd')).status, 400);
}));

test('a report is served with a policy that denies it any network access', withServer(async ({ get }) => {
  const res = await get('/api/report?run=r1&file=work-done.html');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /sandbox allow-scripts/);
  assert.match(csp, /connect-src 'none'/);
  assert.ok(!csp.includes('allow-same-origin'), 'a report must never gain page access');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(await res.text(), /done/);
}));

test('a diagram beside the report is served too', withServer(async ({ get }) => {
  const res = await get('/api/report?run=r1&file=diagrams/map.html');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Map/);
}));

test('a report can be served by featureId or via cross-lookup when run dir is removed', withServer(async ({ get, root }) => {
  const paths = pipelinePaths(root);
  const controlReportDir = path.join(paths.control, 'reports', 'F1');
  fs.mkdirSync(controlReportDir, { recursive: true });
  fs.writeFileSync(path.join(controlReportDir, 'work-done.html'), '<!doctype html><title>F1 Report</title><p>F1 done</p>');

  // 1. Serving by featureId
  const res1 = await get('/api/report?feature=F1&file=work-done.html');
  assert.equal(res1.status, 200);
  assert.match(await res1.text(), /F1 done/);

  // 2. Serving by full pipeline relative path in file param
  const res2 = await get('/api/report?feature=F1&file=.pipeline/control/reports/F1/work-done.html');
  assert.equal(res2.status, 200);
  assert.match(await res2.text(), /F1 done/);

  // 3. Cross-lookup: run directory is removed, but query for run=r1 finds the feature report in control
  const run = pipelinePaths(root, { runId: 'r1' });
  fs.rmSync(run.reports, { recursive: true, force: true });
  const res3 = await get('/api/report?run=r1&file=work-done.html');
  assert.equal(res3.status, 200);
  assert.match(await res3.text(), /F1 done/);
}));


test('report paths cannot escape the reports directory', withServer(async ({ get }) => {
  for (const attempt of [
    '../../secret.txt',
    '..%2F..%2Fsecret.txt',
    '/etc/passwd',
    'diagrams/../../../secret.txt',
  ]) {
    const res = await get(`/api/report?run=r1&file=${encodeURIComponent(attempt)}`);
    assert.ok(res.status === 400 || res.status === 404, `${attempt} returned ${res.status}`);
    const body = await res.text();
    assert.ok(!body.includes('do not serve me'), `${attempt} leaked a file outside the reports directory`);
  }
}));

test('a symlink out of the reports directory is refused', withServer(async ({ get, root, paths }) => {
  const link = path.join(paths.runs, 'r1', 'reports', 'escape.html');
  fs.symlinkSync(path.join(root, 'secret.txt'), link);
  const res = await get('/api/report?run=r1&file=escape.html');
  assert.ok(res.status === 404 || res.status === 400);
  assert.ok(!(await res.text()).includes('do not serve me'));
}));

test('an unsupported report file type is refused rather than sniffed', withServer(async ({ get, paths }) => {
  fs.writeFileSync(path.join(paths.runs, 'r1', 'reports', 'run.sh'), '#!/bin/sh\necho hi\n');
  assert.equal((await get('/api/report?run=r1&file=run.sh')).status, 415);
}));

test('answering a merge decision from the dashboard records approval and advances the merge gate', withServer(async ({ post, get, paths }) => {
  const res = await post('/api/decisions/answer', { decisionId: 'd1', answer: 'approve' });
  assert.equal(res.status, 200);
  assert.equal((await (await get('/api/decisions')).json()).decisions.length, 0);
  const roadmap = JSON.parse(fs.readFileSync(paths.roadmapJson, 'utf8'));
  assert.equal(roadmap.features[0].status, 'merge_approved');
  assert.equal(roadmap.features[0].mergeApproval.via, 'dashboard');
}));

test('answering an unknown decision is refused', withServer(async ({ post }) => {
  assert.equal((await post('/api/decisions/answer', { decisionId: 'nope', answer: 'x' })).status, 409);
}));

test('merge approval is accepted for a feature that is waiting for it', withServer(async ({ post, paths }) => {
  const res = await post('/api/merge/approve', { featureId: 'F1' });
  assert.equal(res.status, 200);
  const roadmap = JSON.parse(fs.readFileSync(paths.roadmapJson, 'utf8'));
  assert.equal(roadmap.features[0].status, 'merge_approved');
  assert.equal(roadmap.features[0].mergeApproval.via, 'dashboard');
}));

test('merge approval for a feature that is not ready is refused', withServer(async ({ post, paths }) => {
  const roadmap = JSON.parse(fs.readFileSync(paths.roadmapJson, 'utf8'));
  roadmap.features[0].status = 'executing';
  fs.writeFileSync(paths.roadmapJson, JSON.stringify(roadmap));
  assert.equal((await post('/api/merge/approve', { featureId: 'F1' })).status, 409);
}));

test('requesting changes queues a note for the coder and reopens review', withServer(async ({ post, paths }) => {
  const res = await post('/api/merge/request-changes', { featureId: 'F1', text: 'rename the column' });
  assert.equal(res.status, 200);
  assert.match(fs.readFileSync(path.join(paths.runs, 'r1', 'followups', 'coder.txt'), 'utf8'), /rename the column/);
}));

test('pausing and resuming the pool is recorded', withServer(async ({ post, paths }) => {
  await post('/api/pool/pause', { why: 'lunch' });
  assert.ok(fs.existsSync(paths.paused));
  await post('/api/pool/resume', {});
  assert.ok(!fs.existsSync(paths.paused));
}));

test('pool action: retry requeues a failed feature', withServer(async ({ post, paths }) => {
  const roadmap = JSON.parse(fs.readFileSync(paths.roadmapJson, 'utf8'));
  roadmap.features[0].status = 'failed';
  fs.writeFileSync(paths.roadmapJson, JSON.stringify(roadmap));
  const res = await post('/api/pool/action', { action: 'retry', featureId: 'F1' });
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(fs.readFileSync(paths.roadmapJson, 'utf8')).features[0].status, 'queued');
}));

test('pool action: retry on a feature that is not failed is refused', withServer(async ({ post }) => {
  const res = await post('/api/pool/action', { action: 'retry', featureId: 'F1' });
  assert.equal(res.status, 409);
}));

test('pool action: hold parks a feature, release lets it continue', withServer(async ({ post, paths }) => {
  assert.equal((await post('/api/pool/action', { action: 'hold', featureId: 'F1', reason: 'waiting on legal' })).status, 200);
  let roadmap = JSON.parse(fs.readFileSync(paths.roadmapJson, 'utf8'));
  assert.equal(roadmap.features[0].status, 'held');
  assert.equal(roadmap.features[0].heldReason, 'waiting on legal');

  assert.equal((await post('/api/pool/action', { action: 'release', featureId: 'F1' })).status, 200);
  roadmap = JSON.parse(fs.readFileSync(paths.roadmapJson, 'utf8'));
  assert.equal(roadmap.features[0].status, 'queued');
}));

test('pool action: release on a feature that is not held is refused', withServer(async ({ post }) => {
  assert.equal((await post('/api/pool/action', { action: 'release', featureId: 'F1' })).status, 409);
}));

test('pool action: skip marks a feature skipped', withServer(async ({ post, paths }) => {
  const res = await post('/api/pool/action', { action: 'skip', featureId: 'F1', reason: 'superseded' });
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(fs.readFileSync(paths.roadmapJson, 'utf8')).features[0].status, 'skipped');
}));

test('pool action: an unrecognized action is refused rather than silently ignored', withServer(async ({ post }) => {
  const res = await post('/api/pool/action', { action: 'delete-everything', featureId: 'F1' });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /Unknown action/);
}));

test('a state-changing request from another origin is refused', withServer(async ({ base, root, port }) => {
  const res = await fetch(`${base}/api/pool/pause?project=${encodeURIComponent(root)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://evil.test' },
    body: '{}',
  });
  assert.equal(res.status, 403);
}));

test('a pool action waits for a supervisor tick without freezing the server', withServer(async ({ base, get, post, paths }) => {
  // A supervisor (another live process: our parent) is mid-tick, holding the roadmap lock.
  fs.writeFileSync(paths.roadmapLock, JSON.stringify({ pid: process.ppid }));
  let settled = false;
  const hold = post('/api/pool/action', { action: 'hold', featureId: 'F1', reason: 'held during a tick' }).then((r) => { settled = true; return r; });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(settled, false, 'the action waits for the tick');
  const started = Date.now();
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await get('/api/runs')).status, 200);
  assert.ok(Date.now() - started < 1000, `other requests were answered in ${Date.now() - started}ms`);
  fs.unlinkSync(paths.roadmapLock); // the tick ends
  const res = await hold;
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(JSON.parse(fs.readFileSync(paths.roadmapJson, 'utf8')).features[0].status, 'held');
  assert.equal(fs.existsSync(paths.roadmapLock), false, 'the server let go of the lock');
}));

test('every POST under /api is guarded, including ones added later', withServer(async ({ base, root }) => {
  for (const route of ['/api/decisions/answer', '/api/merge/approve', '/api/pool/pause', '/api/followup']) {
    const res = await fetch(`${base}${route}?project=${encodeURIComponent(root)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.test' }, body: '{}',
    });
    assert.equal(res.status, 403, `${route} was not guarded`);
  }
}));

test('a note targets the selected run, not the project root', withServer(async ({ post, paths, root }) => {
  const r2 = pipelinePaths(root, { runId: 'r2' });
  fs.mkdirSync(r2.dir, { recursive: true });
  fs.writeFileSync(r2.status, JSON.stringify({
    overall: 'awaiting_chat', awaitingStage: 'planner',
    stages: [{ name: 'planner', status: 'awaiting_host' }],
  }));
  const res = await post('/api/followup', { stage: 'planner', text: 'keep the API small', run: 'r2' });
  assert.equal(res.status, 200, await res.text());
  assert.match(fs.readFileSync(path.join(r2.dir, 'followups', 'planner.txt'), 'utf8'), /keep the API small/);
  assert.ok(!fs.existsSync(path.join(paths.dir, 'followups', 'planner.txt')), 'must not write the root followups');
  const events = fs.readFileSync(r2.events, 'utf8');
  assert.match(events, /keep the API small/);
  assert.match(events, /"kind":"note"/);
}));

test('/api/run with an explicit external runner always sends an explicit --mode cli', withServer(async ({ post, root, paths }) => {
  // A dashboard-spawned run must never fall back to guessing chat-vs-cli from
  // this long-lived server process's own (possibly stale IDE) environment —
  // the operator's own runner choice is the only signal that matters.
  const res = await post('/api/run', { task: 'do the thing', runner: 'cursor' });
  // No prompts in this fixture: the engine fails at once and the endpoint says so.
  assert.equal(res.status, 409, await res.text());
  const out = fs.readFileSync(path.join(paths.dir, 'orchestrator.out'), 'utf8');
  assert.match(out, /--runner cursor/);
  assert.match(out, /--mode cli/);
}));

test('/api/run with runner "host" sends --mode chat', withServer(async ({ post, paths }) => {
  const res = await post('/api/run', { task: 'do the thing', runner: 'host' });
  assert.equal(res.status, 200, await res.text());
  const out = fs.readFileSync(path.join(paths.dir, 'orchestrator.out'), 'utf8');
  assert.match(out, /--runner host/);
  assert.match(out, /--mode chat/);
}));

test('/api/extend always sends an explicit --mode matching the chosen runner', withServer(async ({ post, root }) => {
  const r2 = pipelinePaths(root, { runId: 'r2' });
  fs.mkdirSync(r2.dir, { recursive: true });
  fs.writeFileSync(r2.status, JSON.stringify({ overall: 'halted', haltReason: 'MAX_CYCLES', haltedPhase: 'coder', stages: [] }));
  const res = await post('/api/extend', { extend: 3, runner: 'claude', run: 'r2' });
  // This fixture has no prompts, so the engine exits at once: the endpoint now
  // reports that failure instead of a success the operator cannot see through.
  const body = await res.json();
  assert.equal(res.status, 409, JSON.stringify(body));
  assert.match(body.outputTail, /prompt/);
  const out = fs.readFileSync(path.join(r2.dir, 'orchestrator.out'), 'utf8');
  assert.match(out, /--runner claude/);
  assert.match(out, /--mode cli/);
}));

test('/api/resume always sends an explicit --mode matching the chosen runner', withServer(async ({ post, root }) => {
  const r2 = pipelinePaths(root, { runId: 'r2' });
  fs.mkdirSync(r2.dir, { recursive: true });
  fs.writeFileSync(r2.status, JSON.stringify({ overall: 'halted', haltReason: 'INTERRUPTED', stages: [] }));
  const res = await post('/api/resume', { runner: 'host', run: 'r2' });
  assert.equal(res.status, 200, await res.text());
  const out = fs.readFileSync(path.join(r2.dir, 'orchestrator.out'), 'utf8');
  assert.match(out, /--runner host/);
  assert.match(out, /--mode chat/);
}));

test('a note cannot target an archived run, a mismatched stage, or a path-traversal id', withServer(async ({ post, root }) => {
  const archived = await post('/api/followup', { stage: 'planner', text: 'nope', run: 'r1' });
  assert.equal(archived.status, 409);
  const r2 = pipelinePaths(root, { runId: 'r2' });
  fs.mkdirSync(r2.dir, { recursive: true });
  fs.writeFileSync(r2.status, JSON.stringify({
    overall: 'awaiting_chat', awaitingStage: 'planner',
    stages: [{ name: 'planner', status: 'awaiting_host' }],
  }));
  const mismatch = await post('/api/followup', { stage: 'coder', text: 'wrong stage', run: 'r2' });
  assert.equal(mismatch.status, 409);
  const traversal = await post('/api/followup', { stage: 'planner', text: 'x', run: '../secret' });
  assert.equal(traversal.status, 404);
}));

test('at the plan approval gate a note for the Planner is accepted, so Request changes works', withServer(async ({ post, root }) => {
  const r9 = pipelinePaths(root, { runId: 'r9' });
  fs.mkdirSync(r9.dir, { recursive: true });
  // What requestPlanApproval records.
  fs.writeFileSync(r9.status, JSON.stringify({
    overall: 'awaiting_plan_approval', awaitingStage: 'plan_reviewer', resumePoint: { step: 'plan_approval', context: {} },
    stages: [{ name: 'planner', status: 'done' }, { name: 'plan_reviewer', status: 'done' }],
  }));
  const res = await post('/api/followup', { stage: 'planner', text: 'Split ticket 2 in two.', run: 'r9' });
  assert.equal(res.status, 200, await res.text());
  assert.match(fs.readFileSync(path.join(r9.dir, 'followups', 'planner.txt'), 'utf8'), /Split ticket 2 in two\./);
  const other = await post('/api/followup', { stage: 'coder', text: 'not yet', run: 'r9' });
  assert.equal(other.status, 409, 'only the Planner takes notes at the gate');
}));

test('continue for a selected pool run writes --run-id into that run directory', withServer(async ({ post, root }) => {
  const r2 = pipelinePaths(root, { runId: 'r2' });
  fs.mkdirSync(r2.dir, { recursive: true });
  fs.writeFileSync(r2.status, JSON.stringify({
    overall: 'awaiting_chat', awaitingStage: 'planner',
    stages: [{ name: 'planner', status: 'awaiting_host' }],
  }));
  fs.writeFileSync(r2.specs, `# TECHNICAL SPECIFICATION: Thing
## 2. Technical Specification (PRD)
- **Objective:** ship the thing
### Edge Cases & Failure Modes
| # | Case | Trigger | Required behavior | Proven by |
| E1 | empty input | \`[]\` | returns 0 | sums_empty |
## 3. Tracer-Bullet Tickets
### Ticket 1: do it
`.padEnd(400, '\n- filler line'));
  const res = await post('/api/continue', { run: 'r2' });
  // The fixture records no chatResume, so the engine refuses; that refusal is
  // what the operator now sees, rather than a 200.
  const body = await res.json();
  assert.equal(res.status, 409, JSON.stringify(body));
  assert.match(body.error, /Nothing to continue/);
  const out = fs.readFileSync(path.join(r2.dir, 'orchestrator.out'), 'utf8');
  assert.match(out, /--run-id r2/);
  assert.match(out, /--continue/);
  assert.ok(!fs.existsSync(path.join(root, '.pipeline', 'orchestrator.out')));
}));

test('/api/run/dismiss marks run dismissed and updates status', withServer(async ({ post, root }) => {
  const r3 = pipelinePaths(root, { runId: 'r3' });
  fs.mkdirSync(r3.dir, { recursive: true });
  fs.writeFileSync(r3.status, JSON.stringify({
    overall: 'running', awaitingStage: 'planner',
    stages: [{ name: 'planner', status: 'running' }],
  }));
  const res = await post('/api/run/dismiss', { run: 'r3', reason: 'User dismissed test' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.runId, 'r3');

  const updatedStatus = JSON.parse(fs.readFileSync(r3.status, 'utf8'));
  assert.equal(updatedStatus.overall, 'halted');
  assert.equal(updatedStatus.dismissed, true);
}));

test('a note on an unclaimed bridge-required host run uses followups and never enrolls it in ownership', withServer(async ({ post, root }) => {
  const r3 = pipelinePaths(root, { runId: 'r3' });
  fs.mkdirSync(r3.dir, { recursive: true });
  fs.writeFileSync(r3.status, JSON.stringify({
    overall: 'awaiting_chat', awaitingStage: 'coder', bridgeRequired: true, handoffId: 'h1',
    stages: [{ name: 'coder', status: 'awaiting_host' }],
  }));
  const res = await post('/api/followup', { stage: 'coder', text: 'use the existing helper', run: 'r3' });
  assert.equal(res.status, 200, await res.text());
  assert.match(fs.readFileSync(path.join(r3.dir, 'followups', 'coder.txt'), 'utf8'), /existing helper/);
  const { inspectBridge } = await import('./bridge.mjs');
  assert.equal(inspectBridge(root, 'r3').ownershipRequired, false, 'a plain --continue must still work');
}));

// ---- /api/v1 -----------------------------------------------------------------

function serverRecord(root) {
  const dir = path.join(root, '.orch-home', 'servers');
  const [file] = fs.readdirSync(dir);
  const stat = fs.statSync(path.join(dir, file));
  return { record: JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')), mode: stat.mode & 0o777 };
}

test('v1: discovery, auth, and an owner-only server registry', withServer(async ({ base, root }) => {
  const health = await (await fetch(`${base}/healthz`)).json();
  assert.deepEqual(health.apiVersions, ['v1']);
  assert.ok(health.instanceId && health.capabilities.includes('events.replay'));
  const { record, mode } = serverRecord(root);
  assert.equal(record.instanceId, health.instanceId);
  assert.equal(mode, 0o600);
  assert.equal((await fetch(`${base}/api/v1/projects`)).status, 401, 'no token, no data');
  const auth = { Authorization: `Bearer ${record.token}` };
  const { projects } = await (await fetch(`${base}/api/v1/projects`, { headers: auth })).json();
  assert.equal(projects[0].repoRoot, root);
  // fetch() drops a custom Host header; a raw request sends what a rebinding page would.
  const http = await import('node:http');
  const rebound = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: new URL(base).port, path: '/api/state', headers: { host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); });
  });
  assert.equal(rebound, 421);
}));

test('v1: snapshot and run detail carry server-computed bucket and actions', withServer(async ({ base, root }) => {
  const { record } = serverRecord(root);
  const auth = { Authorization: `Bearer ${record.token}` };
  const [project] = (await (await fetch(`${base}/api/v1/projects`, { headers: auth })).json()).projects;
  const snap = await (await fetch(`${base}/api/v1/projects/${project.projectId}/snapshot`, { headers: auth })).json();
  const r1 = snap.runs.find((r) => r.runId === 'r1');
  assert.equal(r1.bucket, 'done');
  assert.ok(Array.isArray(r1.actions));
  assert.ok(snap.cursor);
  const detail = await (await fetch(`${base}/api/v1/projects/${project.projectId}/runs/r1`, { headers: auth })).json();
  assert.equal(detail.run.runId, 'r1');
  assert.ok(detail.artifacts.some((a) => a.name === 'specs.md'));
}));

test('v1: what a live server sends matches the published contract schemas', withServer(async ({ base, root }) => {
  const auth = { Authorization: `Bearer ${serverRecord(root).record.token}` };
  const runSchema = loadSchema('run-summary'), commandSchema = loadSchema('command'), eventDefs = loadSchema('events').$defs;
  const [project] = (await (await fetch(`${base}/api/v1/projects`, { headers: auth })).json()).projects;
  const v1 = `${base}/api/v1/projects/${project.projectId}`;

  const snap = await (await fetch(`${v1}/snapshot`, { headers: auth })).json();
  assert.ok(snap.runs.length > 0);
  for (const run of snap.runs) assert.deepEqual(validate(runSchema, run), [], `snapshot run ${run.runId}`);
  const detail = await (await fetch(`${v1}/runs/r1`, { headers: auth })).json();
  assert.deepEqual(validate(runSchema, detail.run), [], 'run detail');

  const send = async (body) => (await fetch(`${v1}/commands`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  const results = [
    await send({ commandId: 'c1', type: 'pool.pause', args: { reason: 'contract' } }),
    await send({ commandId: 'c1', type: 'pool.pause', args: { reason: 'contract' } }),
    await send({ commandId: 'c2', type: 'no.such.command' }),
  ];
  assert.deepEqual(results.map((r) => r.status), ['applied', 'duplicate', 'rejected']);
  for (const r of results) assert.deepEqual(validate(commandSchema, r), [], `command ${r.commandId} ${r.status}`);

  // Every SSE frame whose type the contract defines must match its definition.
  const ctrl = new AbortController();
  const reader = (await fetch(`${base}/api/v1/events?projects=${project.projectId}`, { headers: auth, signal: ctrl.signal })).body.getReader();
  let text = '';
  const frames = () => text.split('\n\n').map((block) => ({
    type: /^event: (.+)$/m.exec(block)?.[1], data: /^data: (.+)$/m.exec(block)?.[1],
  })).filter((f) => f.type && f.data);
  const until = async (pred) => {
    const deadline = Date.now() + 5000;
    while (!pred() && Date.now() < deadline) {
      const { value, done } = await Promise.race([reader.read(), new Promise((r) => setTimeout(() => r({ value: null }), 500))]);
      if (done) break;
      if (value) text += new TextDecoder().decode(value);
    }
  };
  await until(() => frames().some((f) => f.type === 'hello'));
  fs.writeFileSync(pipelinePaths(root, { runId: 'r1' }).status, JSON.stringify({ overall: 'halted', haltReason: 'INTERRUPTED', featureId: 'F1', stages: [] }));
  await until(() => frames().some((f) => f.type === 'run.upserted'));
  ctrl.abort();
  const checked = frames().filter((f) => eventDefs[f.type]);
  assert.ok(['hello', 'run.upserted'].every((t) => checked.some((f) => f.type === t)), `saw ${frames().map((f) => f.type)}`);
  for (const f of checked) {
    const data = JSON.parse(f.data);
    assert.deepEqual(validate(eventDefs[f.type], data), [], f.type);
    if (f.type === 'run.upserted') assert.deepEqual(validate(runSchema, data.run), [], 'run.upserted run');
  }
}));

test('v1: the event stream pushes typed run updates and backfill uses the same seq', withServer(async ({ base, root }) => {
  const { record } = serverRecord(root);
  const auth = { Authorization: `Bearer ${record.token}` };
  const [project] = (await (await fetch(`${base}/api/v1/projects`, { headers: auth })).json()).projects;
  const ctrl = new AbortController();
  const stream = await fetch(`${base}/api/v1/events?projects=${project.projectId}`, { headers: auth, signal: ctrl.signal });
  const reader = stream.body.getReader();
  let text = '';
  const until = async (re) => {
    const deadline = Date.now() + 5000;
    while (!re.test(text) && Date.now() < deadline) {
      const { value, done } = await Promise.race([reader.read(), new Promise((r) => setTimeout(() => r({ value: null }), 500))]);
      if (done) break;
      if (value) text += new TextDecoder().decode(value);
    }
    return re.test(text);
  };
  assert.ok(await until(/event: hello/));
  const run = pipelinePaths(root, { runId: 'r1' });
  fs.appendFileSync(run.events, JSON.stringify({ ts: new Date().toISOString(), stage: 'coder', type: 'agent_output', kind: 'text', text: 'hi' }) + '\n');
  fs.writeFileSync(run.status, JSON.stringify({ overall: 'halted', haltReason: 'INTERRUPTED', featureId: 'F1', stages: [] }));
  assert.ok(await until(/event: run\.upserted[\s\S]*"bucket":"blocked"/), text);
  assert.ok(await until(/event: run\.event[\s\S]*"seq":1/), text);
  ctrl.abort();
  const back = await (await fetch(`${base}/api/v1/projects/${project.projectId}/runs/r1/events?afterSeq=0`, { headers: auth })).json();
  assert.equal(back.events[0].seq, 1);
  assert.equal(back.events[0].text, 'hi');
}));

test('v1: commands are idempotent and a refused one says why', withServer(async ({ base, root }) => {
  const { record } = serverRecord(root);
  const headers = { Authorization: `Bearer ${record.token}`, 'Content-Type': 'application/json', Host: new URL(base).host };
  const [project] = (await (await fetch(`${base}/api/v1/projects`, { headers })).json()).projects;
  const send = (body) => fetch(`${base}/api/v1/projects/${project.projectId}/commands`, { method: 'POST', headers, body: JSON.stringify(body) }).then((r) => r.json());
  const refused = await send({ commandId: 'c-resume', type: 'run.resume', runId: 'r1' });
  assert.equal(refused.status, 'rejected');
  assert.match(refused.error.message, /done/);
  const first = await send({ commandId: 'c-dismiss', type: 'run.dismiss', runId: 'r1', args: { reason: 'cleanup' } });
  assert.equal(first.status, 'applied');
  const again = await send({ commandId: 'c-dismiss', type: 'run.dismiss', runId: 'r1', args: { reason: 'cleanup' } });
  assert.equal(again.status, 'duplicate');
}));

test('v1: a resume from the desktop is recorded as an intervention from that client', withServer(async ({ base, root }) => {
  const { record } = serverRecord(root);
  const headers = { Authorization: `Bearer ${record.token}`, 'Content-Type': 'application/json', Host: new URL(base).host };
  const [project] = (await (await fetch(`${base}/api/v1/projects`, { headers })).json()).projects;
  const run = pipelinePaths(root, { runId: 'r2' });
  fs.mkdirSync(run.dir, { recursive: true });
  fs.writeFileSync(run.status, JSON.stringify({ overall: 'halted', haltReason: 'INTERRUPTED', stages: [] }));
  fs.writeFileSync(run.events, '');
  await fetch(`${base}/api/v1/projects/${project.projectId}/commands`, {
    method: 'POST', headers,
    body: JSON.stringify({ commandId: 'c-r2', type: 'run.resume', runId: 'r2', client: { kind: 'desktop' } }),
  }).then((r) => r.json());
  const events = fs.readFileSync(run.events, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const logged = events.find((e) => e.type === 'intervention' && e.action === 'resume');
  assert.ok(logged, 'a person-triggered resume must be on the record');
  assert.equal(logged.via, 'desktop');
}));

test('v1: an extend is refused with the recoverability table\'s own reason', withServer(async ({ base, root }) => {
  const { record } = serverRecord(root);
  const headers = { Authorization: `Bearer ${record.token}`, 'Content-Type': 'application/json', Host: new URL(base).host };
  const [project] = (await (await fetch(`${base}/api/v1/projects`, { headers })).json()).projects;
  const run = pipelinePaths(root, { runId: 'r3' });
  fs.mkdirSync(run.dir, { recursive: true });
  // No haltedPhase: the table says there is nothing to extend, and says why.
  fs.writeFileSync(run.status, JSON.stringify({ overall: 'halted', haltReason: 'MAX_CYCLES', stages: [] }));
  fs.writeFileSync(run.events, '');
  const res = await fetch(`${base}/api/v1/projects/${project.projectId}/commands`, {
    method: 'POST', headers, body: JSON.stringify({ commandId: 'c-r3', type: 'run.extend', runId: 'r3', args: { extend: 2 } }),
  }).then((r) => r.json());
  assert.equal(res.status, 'rejected');
  assert.match(res.error.message, /no recorded phase/);
  const events = fs.readFileSync(run.events, 'utf8');
  assert.doesNotMatch(events, /"action":"extend"/, 'a refused extend must not be logged as done');
}));

test('v1: a pool run with no supervisor running is diagnosed as supervisor-dead', withServer(async ({ base, root }) => {
  const { record } = serverRecord(root);
  const headers = { Authorization: `Bearer ${record.token}`, Host: new URL(base).host };
  const [project] = (await (await fetch(`${base}/api/v1/projects`, { headers })).json()).projects;
  const run = pipelinePaths(root, { runId: 'r4' });
  fs.mkdirSync(run.dir, { recursive: true });
  fs.writeFileSync(run.status, JSON.stringify({ overall: 'halted', haltReason: 'INTERRUPTED', featureId: 'F1', stages: [] }));
  fs.writeFileSync(run.events, '');
  const snap = await (await fetch(`${base}/api/v1/projects/${project.projectId}/snapshot`, { headers })).json();
  const r4 = snap.runs.find((r) => r.runId === 'r4');
  assert.equal(r4.diagnosis.state, 'supervisor-dead');
  assert.equal(r4.diagnosis.underlying.state, 'halted-recoverable');
  // A run that is not in a pool is never blamed on the supervisor.
  const r1 = snap.runs.find((r) => r.runId === 'r1');
  assert.equal(r1.diagnosis.state, 'finished');
}));

test('v1: starting the supervisor republishes the diagnosis of pool runs that were waiting on it', withServer(async ({ base, root }) => {
  const { record } = serverRecord(root);
  const headers = { Authorization: `Bearer ${record.token}`, Host: new URL(base).host };
  const [project] = (await (await fetch(`${base}/api/v1/projects`, { headers })).json()).projects;
  const run = pipelinePaths(root, { runId: 'r5' });
  fs.mkdirSync(run.dir, { recursive: true });
  fs.writeFileSync(run.status, JSON.stringify({ overall: 'halted', haltReason: 'INTERRUPTED', featureId: 'F1', stages: [] }));
  fs.writeFileSync(run.events, '');
  const before = await (await fetch(`${base}/api/v1/projects/${project.projectId}/snapshot`, { headers })).json();
  assert.equal(before.runs.find((r) => r.runId === 'r5').diagnosis.state, 'supervisor-dead');

  const ctrl = new AbortController();
  const stream = await fetch(`${base}/api/v1/events?projects=${project.projectId}`, { headers, signal: ctrl.signal });
  const reader = stream.body.getReader();
  let text = '';
  // One pending read, kept across polls: racing a fresh read() against a timer would
  // abandon the old read, and the chunk it later receives would be lost.
  let pending = null;
  const pump = async (ms) => {
    pending ??= reader.read();
    const r = await Promise.race([pending, new Promise((res) => setTimeout(() => res(null), ms))]);
    if (r?.value) { text += new TextDecoder().decode(r.value); pending = null; }
  };
  const until = async (re, ms = 6000) => {
    const deadline = Date.now() + ms;
    while (!re.test(text) && Date.now() < deadline) await pump(200);
    return re.test(text);
  };
  assert.ok(await until(/event: hello/));
  const states = () => [...text.matchAll(/event: run\.upserted\ndata: (.*)\n/g)]
    .map((m) => JSON.parse(m[1])).filter((f) => f.run.runId === 'r5').map((f) => f.run.diagnosis.state);
  // Provoke one publish of r5 while no supervisor exists, so the only thing that can
  // change its diagnosis afterwards is the supervisor coming up.
  fs.appendFileSync(run.events, JSON.stringify({ ts: new Date().toISOString(), stage: 'orchestrator', type: 'note' }) + '\n');
  for (let i = 0; i < 20 && !states().includes('supervisor-dead'); i++) await pump(300);
  assert.ok(states().includes('supervisor-dead'), `first publish: ${states()}`);
  // This test process stands in for a live supervisor.
  const paths = pipelinePaths(root);
  fs.mkdirSync(path.dirname(paths.supervisorPid), { recursive: true });
  fs.writeFileSync(paths.supervisorPid, String(process.pid));
  for (let i = 0; i < 20 && !states().includes('halted-recoverable'); i++) await pump(300);
  assert.ok(states().includes('halted-recoverable'), `top-level diagnosis states seen: ${states()}\n${text.slice(-1500)}`);
  ctrl.abort();
}));

// A v1 event stream reader for one run's run.upserted frames.
async function streamRun(base, root, runId) {
  const { record } = serverRecord(root);
  const headers = { Authorization: `Bearer ${record.token}`, Host: new URL(base).host };
  const [project] = (await (await fetch(`${base}/api/v1/projects`, { headers })).json()).projects;
  const ctrl = new AbortController();
  const stream = await fetch(`${base}/api/v1/events?projects=${project.projectId}`, { headers, signal: ctrl.signal });
  const reader = stream.body.getReader();
  let text = '';
  let pending = null;
  const pump = async (ms) => {
    pending ??= reader.read();
    const r = await Promise.race([pending, new Promise((res) => setTimeout(() => res(null), ms))]);
    if (r?.value) { text += new TextDecoder().decode(r.value); pending = null; }
  };
  const runs = () => [...text.matchAll(/event: run\.upserted\ndata: (.*)\n/g)].map((m) => JSON.parse(m[1]).run).filter((r) => r.runId === runId);
  const waitFor = async (pred, ms = 8000) => {
    const deadline = Date.now() + ms;
    while (!runs().some(pred) && Date.now() < deadline) await pump(200);
    return runs().some(pred);
  };
  while (!/event: hello/.test(text)) await pump(200);
  return { runs, waitFor, close: () => ctrl.abort() };
}

test('v1: a bridge claim changes the driver clients see, though no run file changed', withServer(async ({ base, root }) => {
  const run = pipelinePaths(root, { runId: 'r7' });
  fs.mkdirSync(run.dir, { recursive: true });
  fs.writeFileSync(run.status, JSON.stringify({ overall: 'awaiting_chat', handoffId: 'h7', awaitingStage: 'coder', executionSurface: 'host-handoff', stages: [] }));
  fs.writeFileSync(run.stageHandoff, JSON.stringify({ stage: 'coder', runId: 'r7' }));
  fs.writeFileSync(run.events, '');
  const s = await streamRun(base, root, 'r7');
  try {
    fs.appendFileSync(run.events, JSON.stringify({ ts: new Date().toISOString(), stage: 'orchestrator', type: 'note' }) + '\n');
    assert.ok(await s.waitFor((r) => r.driver.kind === 'none'), 'first: nobody drives it');
    const { sessionId } = bridgeCommand('session.register', { project: root, host: 'claude', conversationId: 'conv-7', capabilities: { hooks: true } });
    bridgeCommand('run.claim', { project: root, runId: 'r7', sessionId });
    assert.ok(await s.waitFor((r) => r.driver.kind === 'host-session'), `driver kinds seen: ${s.runs().map((r) => r.driver.kind)}`);
  } finally { s.close(); }
}));

test('v1: a driver going quiet with no file change still reaches clients', withServer(async ({ base, root }) => {
  // A CLI engine (this test process) whose last output is just under the quiet
  // threshold: within seconds it turns quiet, and only the clock says so.
  const run = pipelinePaths(root, { runId: 'r8' });
  fs.mkdirSync(run.dir, { recursive: true });
  fs.writeFileSync(run.status, JSON.stringify({ overall: 'running', executionSurface: 'cli', runner: 'claude', stages: [{ name: 'coder', status: 'running' }] }));
  fs.writeFileSync(run.lock, JSON.stringify({ pid: process.pid }));
  fs.writeFileSync(run.events, '');
  const almostQuiet = new Date(Date.now() - 2 * 60_000 + 2500);
  fs.utimesSync(run.events, almostQuiet, almostQuiet);
  const s = await streamRun(base, root, 'r8');
  try {
    assert.ok(await s.waitFor((r) => r.driver.presence === 'quiet', 10000), `presences seen: ${s.runs().map((r) => r.driver.presence)}`);
  } finally { s.close(); }
}, { env: { PIPELINE_CLOCK_REFRESH_MS: '300' } }));

test('a supervisor that crashed is reported once, and the alert clears when it is back', withServer(async ({ base, root }) => {
  const { record } = serverRecord(root);
  const headers = { Authorization: `Bearer ${record.token}`, Host: new URL(base).host };
  const [project] = (await (await fetch(`${base}/api/v1/projects`, { headers })).json()).projects;
  const attention = async () => (await (await fetch(`${base}/api/v1/projects/${project.projectId}/snapshot`, { headers })).json())
    .attention.filter((a) => a.kind === 'supervisor-dead');
  const until = async (pred) => { for (let i = 0; i < 40; i++) { const v = await attention(); if (pred(v)) return v; await new Promise((r) => setTimeout(r, 150)); } return attention(); };
  const paths = pipelinePaths(root);
  fs.mkdirSync(path.dirname(paths.supervisorPid), { recursive: true });

  fs.writeFileSync(paths.supervisorPid, '2147483646'); // a pid with no process: it crashed and left the file
  const raised = await until((v) => v.length > 0);
  assert.equal(raised.length, 1);
  assert.match(raised[0].summary, /pool start/);
  await new Promise((r) => setTimeout(r, 700)); // several more checks: still exactly one
  assert.equal((await attention()).length, 1, 'not re-raised on every check');

  fs.writeFileSync(paths.supervisorPid, String(process.pid)); // back
  assert.equal((await until((v) => v.length === 0)).length, 0, 'the alert clears itself');
}, { env: { PIPELINE_SUPERVISOR_WATCH_MS: '200' } }));

test('an unregistered ?project= path is refused instead of being watched', withServer(async ({ base }) => {
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'not-registered-'));
  const res = await fetch(`${base}/api/state?project=${encodeURIComponent(elsewhere)}`);
  assert.equal(res.status, 400);
  assert.equal(fs.existsSync(path.join(elsewhere, '.pipeline')), false);
  fs.rmSync(elsewhere, { recursive: true, force: true });
}));

test('a server that loses the race for its port leaves the live server\'s ui.url alone', withServer(async ({ root, paths, port }) => {
  fs.writeFileSync(path.join(paths.dir, 'ui.url'), `http://127.0.0.1:${port}/?project=x\n`);
  const loser = spawn(process.execPath, [path.join(HERE, 'ui-server.mjs')], {
    cwd: root, env: { ...process.env, PIPELINE_UI_PORT: String(port), PIPELINE_UI_IDLE_TIMEOUT_MS: '0', ORCHESTRATOR_HOME: path.join(root, '.orch-home') },
    stdio: 'ignore',
  });
  const code = await new Promise((resolve) => loser.on('exit', resolve));
  assert.equal(code, 1);
  assert.ok(fs.existsSync(path.join(paths.dir, 'ui.url')), 'the winner\'s url survives');
}));

test('SIGTERM runs the same cleanup as a normal exit', async () => {
  const { root, paths } = makeProject();
  const port = await freePort();
  const child = await startServer(root, port);
  fs.writeFileSync(path.join(paths.dir, 'ui.url'), `http://127.0.0.1:${port}/\n`);
  const servers = path.join(root, '.orch-home', 'servers');
  assert.equal(fs.readdirSync(servers).length, 1);
  child.kill('SIGTERM');
  await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(fs.readdirSync(servers).length, 0, 'server record removed');
  assert.equal(fs.existsSync(path.join(paths.dir, 'ui.url')), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('/api/state survives a corrupt bridge journal and an oversized body gets 413', withServer(async ({ get, post, paths }) => {
  fs.writeFileSync(path.join(paths.control, 'bridge.journal.jsonl'), 'not json\n{}\n');
  const res = await get('/api/state?run=r1');
  assert.equal(res.status, 200);
  assert.match((await res.json()).bridge.error, /Corrupt journal/);
  const big = await post('/api/followup', { stage: 'coder', text: 'x'.repeat(70 * 1024) });
  assert.equal(big.status, 413);
  assert.equal((await get('/healthz')).status, 200, 'still serving');
}));

test('/api/register only accepts installed pipeline projects', withServer(async ({ post, root }) => {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'bare-'));
  const res = await post('/api/register', { repoRoot: bare });
  assert.equal(res.status, 400);
  assert.equal(fs.existsSync(path.join(bare, '.pipeline')), false, 'no .pipeline created for an arbitrary path');
  assert.equal((await post('/api/register', { repoRoot: root })).status, 200);
  fs.rmSync(bare, { recursive: true, force: true });
}));

test('/api/state sends only the requested or active stage\'s events', withServer(async ({ get, paths }) => {
  const run = pipelinePaths(paths.root, { runId: 'r1' });
  fs.writeFileSync(run.status, JSON.stringify({ overall: 'running', stages: [{ name: 'planner', status: 'passed' }, { name: 'coder', status: 'running' }] }));
  fs.appendFileSync(run.events, [
    { stage: 'planner', type: 'agent_output', kind: 'text', text: 'planned' },
    { stage: 'coder', type: 'agent_output', kind: 'text', text: 'coding' },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const active = await (await get('/api/state?run=r1')).json();
  assert.deepEqual(Object.keys(active.events), ['coder']);
  const picked = await (await get('/api/state?run=r1&stage=planner')).json();
  assert.deepEqual(Object.keys(picked.events), ['planner']);
  assert.equal(picked.events.planner.at(-1).text, 'planned');
}));
