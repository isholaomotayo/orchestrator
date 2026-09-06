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

async function startServer(root, port) {
  const child = spawn(process.execPath, [path.join(HERE, 'ui-server.mjs')], {
    cwd: root,
    env: { ...process.env, PIPELINE_UI_PORT: String(port), PIPELINE_UI_IDLE_TIMEOUT_MS: '0' },
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

function withServer(fn) {
  return async (t) => {
    const { root, paths } = makeProject();
    const port = await freePort();
    const child = await startServer(root, port);
    const base = `http://127.0.0.1:${port}`;
    const get = (p) => fetch(`${base}${p}${p.includes('?') ? '&' : '?'}project=${encodeURIComponent(root)}`);
    const post = (p, body, headers = {}) => fetch(`${base}${p}?project=${encodeURIComponent(root)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Host: `127.0.0.1:${port}`, ...headers }, body: JSON.stringify(body),
    });
    t.after(() => { child.kill(); fs.rmSync(root, { recursive: true, force: true }); });
    await fn({ base, get, post, root, paths, port });
  };
}

test('healthz answers the discovery contract orchestrate.sh depends on', withServer(async ({ base }) => {
  const body = await (await fetch(`${base}/healthz`)).json();
  assert.equal(body.service, 'pipeline-ui');
  assert.ok(body.repoRoot);
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
  assert.equal(body.runs[0].task, 'Legacy task');
  assert.equal(body.runs[0].live, true);
  assert.ok(body.runs.some((r) => r.id === 'r1' && r.live === false));
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

test('answering a decision from the dashboard records it and notifies the worker', withServer(async ({ post, get, paths }) => {
  const res = await post('/api/decisions/answer', { decisionId: 'd1', answer: 'approve' });
  assert.equal(res.status, 200);
  assert.equal((await (await get('/api/decisions')).json()).decisions.length, 0);
  const note = fs.readFileSync(path.join(paths.runs, 'r1', 'followups', 'reviewer.txt'), 'utf8');
  assert.match(note, /approve/);
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

test('a state-changing request from another origin is refused', withServer(async ({ base, root, port }) => {
  const res = await fetch(`${base}/api/pool/pause?project=${encodeURIComponent(root)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://evil.test' },
    body: '{}',
  });
  assert.equal(res.status, 403);
}));

test('every POST under /api is guarded, including ones added later', withServer(async ({ base, root }) => {
  for (const route of ['/api/decisions/answer', '/api/merge/approve', '/api/pool/pause', '/api/followup']) {
    const res = await fetch(`${base}${route}?project=${encodeURIComponent(root)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.test' }, body: '{}',
    });
    assert.equal(res.status, 403, `${route} was not guarded`);
  }
}));
