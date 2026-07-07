#!/usr/bin/env node
// Zero-dependency dashboard server: serves dashboard.html, exposes pipeline
// state (status + structured per-agent activity events) as JSON, accepts
// human follow-up notes for agents, and pushes change notifications over
// Server-Sent Events by watching the .pipeline/ directory.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { pipelinePaths, loadConfig } from './state.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = process.cwd();
const paths = pipelinePaths(repoRoot);
const config = loadConfig(paths);
const PORT = Number(process.env.PIPELINE_UI_PORT || config.uiPort || 4600);

const ARTIFACTS = ['specs.md', 'changes.md', 'checker_report.md', 'test_suite.md', 'review_report.md', 'vague_request.txt'];
const AGENT_STAGES = ['planner', 'coder', 'tester', 'reviewer'];
const EVENTS_PER_STAGE = 250;

function readEventsByStage() {
  // Read the tail of events.jsonl (last 1 MB is plenty for a live view) and
  // group agent_output / check events per stage.
  const byStage = Object.fromEntries(AGENT_STAGES.map((s) => [s, []]));
  let raw = '';
  try {
    const size = fs.statSync(paths.events).size;
    const start = Math.max(0, size - 1024 * 1024);
    const fd = fs.openSync(paths.events, 'r');
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    raw = buf.toString('utf8');
    if (start > 0) raw = raw.slice(raw.indexOf('\n') + 1); // drop partial first line
  } catch { return byStage; }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (!byStage[ev.stage]) continue;
    if (ev.type === 'agent_output' || ev.type === 'agent_start' || ev.type === 'checks_start' || ev.type === 'check_end') {
      byStage[ev.stage].push(ev);
    }
  }
  for (const s of AGENT_STAGES) {
    if (byStage[s].length > EVENTS_PER_STAGE) byStage[s] = byStage[s].slice(-EVENTS_PER_STAGE);
  }
  return byStage;
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

function readState() {
  let status = null;
  try { status = JSON.parse(fs.readFileSync(paths.status, 'utf8')); } catch {}
  const artifacts = ARTIFACTS.filter((n) => {
    try { return fs.statSync(path.join(paths.dir, n)).size > 0; } catch { return false; }
  });
  return { status, artifacts, events: readEventsByStage(), followups: readFollowups(), now: new Date().toISOString() };
}

function json(res, body, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

const sseClients = new Set();
function broadcast(payload) {
  const msg = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) res.write(msg);
}

// Watch .pipeline/ with debounce; recursive fs.watch is supported on macOS and
// Windows; on Linux we fall back to a non-recursive watch of the top level.
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
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (req.method === 'POST' && url.pathname === '/api/followup') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 64 * 1024) req.destroy(); });
    req.on('end', () => {
      try {
        const { stage, text } = JSON.parse(body);
        if (!AGENT_STAGES.includes(stage) || typeof text !== 'string' || !text.trim()) {
          return json(res, { error: 'expected { stage: planner|coder|tester|reviewer, text }' }, 400);
        }
        const dir = path.join(paths.dir, 'followups');
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(path.join(dir, `${stage}.txt`), text.trim() + '\n');
        json(res, { ok: true, queued: stage });
      } catch {
        json(res, { error: 'invalid JSON' }, 400);
      }
    });
  } else if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(fs.readFileSync(path.join(__dirname, 'dashboard.html')));
  } else if (url.pathname === '/api/state') {
    json(res, readState());
  } else if (url.pathname === '/api/artifact') {
    const name = url.searchParams.get('name');
    if (!ARTIFACTS.includes(name)) return json(res, { error: 'unknown artifact' }, 400);
    try {
      json(res, { name, content: fs.readFileSync(path.join(paths.dir, name), 'utf8') });
    } catch {
      json(res, { name, content: '' });
    }
  } else if (url.pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
  } else if (url.pathname === '/healthz') {
    json(res, { ok: true, service: 'pipeline-ui' });
  } else {
    res.writeHead(404); res.end('not found');
  }
});

setInterval(() => broadcast({ type: 'ping' }), 25000);

server.listen(PORT, () => {
  attachWatchers();
  console.log(`[UI] Pipeline dashboard running at http://localhost:${PORT}`);
});
