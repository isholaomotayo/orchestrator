#!/usr/bin/env node
// Zero-dependency dashboard server: serves dashboard.html, exposes pipeline
// state (status + structured per-agent activity events + run history) as JSON,
// starts/cancels runs, accepts human follow-up notes for agents, and pushes
// change notifications over Server-Sent Events by watching .pipeline/.
// Binds to 127.0.0.1 only — the dashboard exposes code, diffs, and controls.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pipelinePaths, loadConfig, pidAlive, readLock } from './state.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = process.cwd();
const paths = pipelinePaths(repoRoot);
const config = loadConfig(paths);
const PORT = Number(process.env.PIPELINE_UI_PORT || config.uiPort || 4600);
const HOST = '127.0.0.1';

const ARTIFACTS = ['specs.md', 'changes.md', 'checker_report.md', 'test_suite.md', 'review_report.md', 'diff.patch', 'vague_request.txt', 'stage-handoff.json'];
const AGENT_STAGES = ['planner', 'coder', 'tester', 'reviewer'];
const RUNNERS = ['auto', 'claude', 'cursor', 'codex', 'gemini'];
const EVENTS_PER_STAGE = 250;

// A "run" is either the live .pipeline/ dir (runId null) or an archived
// .pipeline/runs/<id>/ dir. IDs are timestamps — validate strictly.
function runDir(runId) {
  if (!runId) return paths.dir;
  if (!/^[\w.-]+$/.test(runId)) return null;
  const dir = path.join(paths.runs, runId);
  return fs.existsSync(dir) ? dir : null;
}

function readEventsByStage(dir) {
  const byStage = Object.fromEntries(AGENT_STAGES.map((s) => [s, []]));
  let totalCost = 0;
  const file = path.join(dir, 'events.jsonl');
  let raw = '';
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - 1024 * 1024);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    raw = buf.toString('utf8');
    if (start > 0) raw = raw.slice(raw.indexOf('\n') + 1);
  } catch { return { byStage, totalCost }; }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (typeof ev.costUsd === 'number') totalCost += ev.costUsd;
    if (!byStage[ev.stage]) continue;
    if (['agent_output', 'agent_start', 'checks_start', 'check_end', 'followup_applied', 'chat_handoff'].includes(ev.type)) {
      byStage[ev.stage].push(ev);
    }
  }
  for (const s of AGENT_STAGES) {
    if (byStage[s].length > EVENTS_PER_STAGE) byStage[s] = byStage[s].slice(-EVENTS_PER_STAGE);
  }
  return { byStage, totalCost };
}

function readFollowups() {
  const out = {};
  for (const s of AGENT_STAGES) {
    try {
      const t = fs.readFileSync(path.join(paths.dir, 'followups', `${s}.txt`), 'utf8').trim();
      if (t) out[s] = t;
    } catch {}
  }
  return out;
}

// The lock's PID is the source of truth for liveness: status.json can claim
// "running" forever after a kill -9 or sleep/crash.
function orchestratorAlive() {
  const lock = readLock(paths);
  return !!(lock && pidAlive(lock.pid));
}

function readState(runId) {
  const dir = runDir(runId);
  if (!dir) return { error: 'unknown run' };
  let status = null;
  try { status = JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8')); } catch {}
  const live = dir === paths.dir;
  const stale = live && status?.overall === 'running' && !orchestratorAlive();
  const artifacts = ARTIFACTS.filter((n) => {
    try { return fs.statSync(path.join(dir, n)).size > 0; } catch { return false; }
  });
  const { byStage, totalCost } = readEventsByStage(dir);
  const canExtend = live && !orchestratorAlive() && status?.overall === 'halted' && status?.haltReason === 'MAX_CYCLES';
  return {
    status, artifacts, events: byStage,
    followups: live ? readFollowups() : {},
    live, stale, runId: runId || null,
    totals: { costUsd: totalCost },
    canCancel: live && orchestratorAlive(),
    canExtend,
    runners: [...RUNNERS, ...Object.keys(config.customRunners || {})],
    // Config-driven defaults — the UI should never hardcode a cycle count.
    defaults: { maxCoderCycles: config.maxCoderCycles, maxPostTesterCycles: config.maxPostTesterCycles, extendCycles: config.maxCoderCycles },
    now: new Date().toISOString(),
  };
}

function listRuns() {
  let ids = [];
  try { ids = fs.readdirSync(paths.runs).filter((n) => /^[\w.-]+$/.test(n)).sort().reverse(); } catch {}
  return ids.map((id) => {
    let s = null;
    try { s = JSON.parse(fs.readFileSync(path.join(paths.runs, id, 'status.json'), 'utf8')); } catch {}
    return { id, task: s?.task || '(unknown)', overall: s?.overall, verdict: s?.verdict, haltReason: s?.haltReason, startedAt: s?.startedAt };
  });
}

function positiveInt(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function startRun({ task, runner, sandbox, maxCycles, maxPostTesterCycles }) {
  if (typeof task !== 'string' || !task.trim()) return { error: 'task is required', code: 400 };
  if (runner && !RUNNERS.includes(runner) && !config.customRunners?.[runner]) return { error: 'unknown runner', code: 400 };
  if (orchestratorAlive()) return { error: 'a pipeline run is already active', code: 409 };
  const nodeArgs = [path.join(__dirname, 'orchestrator.mjs'), '--task', task.trim()];
  if (runner && runner !== 'auto') nodeArgs.push('--runner', runner);
  if (sandbox) nodeArgs.push('--sandbox');
  const mc = positiveInt(maxCycles);
  if (mc) nodeArgs.push('--max-cycles', String(mc));
  const mptc = positiveInt(maxPostTesterCycles);
  if (mptc) nodeArgs.push('--max-post-tester-cycles', String(mptc));
  const child = spawn(process.execPath, nodeArgs, {
    cwd: repoRoot,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, PIPELINE_UI_PORT: String(PORT) },
  });
  child.unref();
  return { ok: true, pid: child.pid };
}

// Continue a run that halted with MAX_CYCLES for `extend` more cycles of
// whichever loop (initial coder fix loop, or post-tester fix loop) ran out —
// repeatable as many times as needed.
function extendRun({ extend, runner }) {
  const n = positiveInt(extend);
  if (!n) return { error: 'extend must be a positive integer', code: 400 };
  if (orchestratorAlive()) return { error: 'a pipeline run is already active', code: 409 };
  let status;
  try { status = JSON.parse(fs.readFileSync(path.join(paths.dir, 'status.json'), 'utf8')); } catch {
    return { error: 'no run to extend', code: 409 };
  }
  if (status.overall !== 'halted' || status.haltReason !== 'MAX_CYCLES') {
    return { error: `cannot extend: last halt reason was "${status.haltReason || status.overall}", not MAX_CYCLES`, code: 409 };
  }
  const nodeArgs = [path.join(__dirname, 'orchestrator.mjs'), '--resume', '--extend', String(n)];
  if (runner && runner !== 'auto') nodeArgs.push('--runner', runner);
  const child = spawn(process.execPath, nodeArgs, {
    cwd: repoRoot,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, PIPELINE_UI_PORT: String(PORT) },
  });
  child.unref();
  return { ok: true, pid: child.pid, extend: n };
}

function cancelRun() {
  const lock = readLock(paths);
  if (!lock || !pidAlive(lock.pid)) return { error: 'no active run', code: 409 };
  try { process.kill(lock.pid, 'SIGTERM'); return { ok: true, signalled: lock.pid }; }
  catch (err) { return { error: err.message, code: 500 }; }
}

function json(res, body, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req, cb) {
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 64 * 1024) req.destroy(); });
  req.on('end', () => {
    try { cb(JSON.parse(body || '{}')); } catch { cb(null); }
  });
}

const sseClients = new Set();
function broadcast(payload) {
  const msg = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) res.write(msg);
}

let debounceTimer = null;
const changedSet = new Set();
function onFsChange(file) {
  changedSet.add(file || '*');
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    broadcast({ type: 'change', changed: [...changedSet] });
    changedSet.clear();
  }, 150);
}
function attachWatchers() {
  fs.mkdirSync(paths.dir, { recursive: true });
  try {
    fs.watch(paths.dir, { recursive: true }, (_e, f) => onFsChange(f));
  } catch {
    fs.watch(paths.dir, (_e, f) => onFsChange(f));
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (req.method === 'POST' && url.pathname === '/api/followup') {
    readBody(req, (body) => {
      if (!body || !AGENT_STAGES.includes(body.stage) || typeof body.text !== 'string' || !body.text.trim()) {
        return json(res, { error: 'expected { stage: planner|coder|tester|reviewer, text }' }, 400);
      }
      const dir = path.join(paths.dir, 'followups');
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, `${body.stage}.txt`), body.text.trim() + '\n');
      json(res, { ok: true, queued: body.stage });
    });
  } else if (req.method === 'POST' && url.pathname === '/api/run') {
    readBody(req, (body) => {
      if (!body) return json(res, { error: 'invalid JSON' }, 400);
      const result = startRun(body);
      json(res, result, result.code || 200);
    });
  } else if (req.method === 'POST' && url.pathname === '/api/cancel') {
    const result = cancelRun();
    json(res, result, result.code || 200);
  } else if (req.method === 'POST' && url.pathname === '/api/extend') {
    readBody(req, (body) => {
      if (!body) return json(res, { error: 'invalid JSON' }, 400);
      const result = extendRun(body);
      json(res, result, result.code || 200);
    });
  } else if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(fs.readFileSync(path.join(__dirname, 'dashboard.html')));
  } else if (url.pathname === '/api/state') {
    const state = readState(url.searchParams.get('run'));
    json(res, state, state.error ? 404 : 200);
  } else if (url.pathname === '/api/runs') {
    json(res, { runs: listRuns() });
  } else if (url.pathname === '/api/artifact') {
    const name = url.searchParams.get('name');
    const dir = runDir(url.searchParams.get('run'));
    if (!ARTIFACTS.includes(name) || !dir) return json(res, { error: 'unknown artifact' }, 400);
    try {
      json(res, { name, content: fs.readFileSync(path.join(dir, name), 'utf8') });
    } catch {
      json(res, { name, content: '' });
    }
  } else if (url.pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
  } else if (url.pathname === '/healthz') {
    json(res, { ok: true, service: 'pipeline-ui', repoRoot });
  } else {
    res.writeHead(404); res.end('not found');
  }
});

setInterval(() => broadcast({ type: 'ping' }), 25000);

server.listen(PORT, HOST, () => {
  attachWatchers();
  console.log(`[UI] Pipeline dashboard running at http://${HOST}:${PORT} (repo: ${repoRoot})`);
});
