#!/usr/bin/env node
// Record /api/v1 payloads from a REAL ui-server into tests/contract/fixtures/v1,
// so the desktop client's types are tested against what the server actually
// sends (not against a hand-written guess). Runs against a throwaway project
// with synthetic run states; nothing from a real project is recorded.
//
// Usage: node scripts/record-contract-fixtures.mjs [--check]
//   --check  record into a temp dir and fail if the result differs in shape
//            from the committed fixtures (used by CI).
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'tests', 'contract', 'fixtures', 'v1');
const check = process.argv.includes('--check');

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function seedProject() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'contract-')));
  const pipeline = path.join(root, '.pipeline');
  const now = Date.now();
  const iso = (ago) => new Date(now - ago).toISOString();
  const runs = {
    'r-awaiting': { overall: 'awaiting_chat', awaitingStage: 'coder', handoffId: 'h-1', executionSurface: 'host-handoff', hostClient: 'antigravity', task: '- **Goal:** Add a health check', stages: [{ name: 'coder', status: 'awaiting_host', cycle: 1, maxCycles: 5, startedAt: iso(2 * 60_000) }] },
    'r-unattended': { overall: 'awaiting_chat', awaitingStage: 'tester', handoffId: 'h-2', executionSurface: 'host-handoff', task: 'Notifications center', stages: [{ name: 'tester', status: 'awaiting_host', startedAt: iso(3 * 3600_000) }] },
    'r-halted': { overall: 'halted', haltReason: 'MISSING_ARTIFACT', haltedStage: 'coder', executionSurface: 'cli-subprocess', runner: 'claude', task: 'Library sync', stages: [{ name: 'coder', status: 'failed', detail: 'missing self-review' }] },
    'r-plan': { overall: 'awaiting_plan_approval', executionSurface: 'host-handoff', task: 'Account security', stages: [{ name: 'planner', status: 'passed' }] },
    'r-done': { overall: 'done', verdict: 'APPROVED', executionSurface: 'cli-subprocess', runner: 'codex', task: 'Broadcast guide', stages: [] },
  };
  for (const [id, status] of Object.entries(runs)) {
    fs.mkdirSync(path.join(pipeline, 'runs', id), { recursive: true });
    fs.writeFileSync(path.join(pipeline, 'runs', id, 'status.json'), JSON.stringify(status));
    fs.writeFileSync(path.join(pipeline, 'runs', id, 'events.jsonl'), '');
  }
  fs.mkdirSync(path.join(pipeline, 'control'), { recursive: true });
  fs.writeFileSync(path.join(pipeline, 'config.json'), JSON.stringify({ uiIdleTimeoutMs: 0 }));
  return root;
}

async function main() {
  const root = seedProject();
  const port = await freePort();
  const home = path.join(root, '.orch-home');
  const server = spawn(process.execPath, [path.join(ROOT, 'pipeline', 'ui-server.mjs')], {
    cwd: root, env: { ...process.env, PIPELINE_UI_PORT: String(port), ORCHESTRATOR_HOME: home, PIPELINE_UI_IDLE_TIMEOUT_MS: '0' }, stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    let health = null;
    for (let i = 0; i < 100 && !health; i++) { try { health = await (await fetch(`${base}/healthz`)).json(); } catch { await sleep(50); } }
    if (!health) throw new Error('ui-server did not start');
    const record = JSON.parse(fs.readFileSync(path.join(home, 'servers', fs.readdirSync(path.join(home, 'servers'))[0]), 'utf8'));
    const auth = { Authorization: `Bearer ${record.token}` };
    const get = async (p) => (await fetch(`${base}${p}`, { headers: auth })).json();
    const projects = await get('/api/v1/projects');
    const pid = projects.projects[0].projectId;
    const snapshot = await get(`/api/v1/projects/${pid}/snapshot`);
    const runDetail = await get(`/api/v1/projects/${pid}/runs/r-halted`);

    // Live stream: a status change and an event line, as frames.
    const ctrl = new AbortController();
    const stream = await fetch(`${base}/api/v1/events?projects=${pid}`, { headers: auth, signal: ctrl.signal });
    const reader = stream.body.getReader();
    let sse = '';
    const pump = (async () => { for (;;) { const { value, done } = await reader.read(); if (done) return; sse += new TextDecoder().decode(value); } })().catch(() => {});
    await sleep(300);
    fs.appendFileSync(path.join(root, '.pipeline', 'runs', 'r-awaiting', 'events.jsonl'), JSON.stringify({ ts: new Date().toISOString(), stage: 'coder', type: 'agent_output', kind: 'text', text: 'Editing src/health.ts' }) + '\n');
    fs.writeFileSync(path.join(root, '.pipeline', 'runs', 'r-awaiting', 'status.json'), JSON.stringify({ overall: 'halted', haltReason: 'INTERRUPTED', executionSurface: 'host-handoff', task: 'Add a health check', stages: [] }));
    for (let i = 0; i < 40 && !/run\.event/.test(sse); i++) await sleep(100);
    ctrl.abort();
    await pump;

    const post = async (body) => (await fetch(`${base}/api/v1/projects/${pid}/commands`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
    const commands = [
      await post({ commandId: 'fixture-1', type: 'run.dismiss', runId: 'r-done', args: { reason: 'fixture' }, client: { kind: 'desktop', version: '0' } }),
      await post({ commandId: 'fixture-1', type: 'run.dismiss', runId: 'r-done', args: { reason: 'fixture' }, client: { kind: 'desktop', version: '0' } }),
      await post({ commandId: 'fixture-2', type: 'run.resume', runId: 'r-done', args: {}, client: { kind: 'desktop', version: '0' } }),
    ];

    // Volatile values (ids, ports, times, paths) are normalised so the files diff cleanly.
    const scrub = (text) => text
      .replaceAll(record.token, '<token>').replaceAll(root, '<repo>').replaceAll(health.instanceId, '<instance>').replaceAll(pid, '<project>').replaceAll(path.basename(root), '<repo-name>').replaceAll(base, 'http://127.0.0.1:0')
      .replace(/"(startedAt|endedAt|generatedAt|at|ts|updatedAt|waitingSince|lastActivityAt|leaseExpiresAt|installedAt|dismissedAt)":(\s*)"[^"]*"/g, '"$1":$2"<time>"')
      .replace(/"(port|pid|revision)":(\s*)\d+/g, '"$1":$20')
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>');
    const files = {
      'health.json': JSON.stringify(health, null, 2),
      'server-record.json': JSON.stringify(record, null, 2),
      'projects.json': JSON.stringify(projects, null, 2),
      'snapshot.json': JSON.stringify(snapshot, null, 2),
      'run-detail.json': JSON.stringify(runDetail, null, 2),
      'commands.json': JSON.stringify(commands, null, 2),
      'events.sse': sse.replace(/id: [^\n]+/g, 'id: <instance>.<n>'),
    };
    const target = check ? fs.mkdtempSync(path.join(os.tmpdir(), 'fixtures-')) : OUT;
    fs.mkdirSync(target, { recursive: true });
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(target, name), scrub(body) + '\n');
    console.log(`Recorded ${Object.keys(files).length} fixtures into ${path.relative(process.cwd(), target) || target}`);
  } finally {
    server.kill();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
