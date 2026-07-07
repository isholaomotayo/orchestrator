#!/usr/bin/env node
// Zero-dependency dashboard server: serves dashboard.html, exposes pipeline
// state as JSON, and pushes change notifications over Server-Sent Events by
// watching the .pipeline/ directory.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { pipelinePaths, loadConfig, tailFile } from './state.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = process.cwd();
const paths = pipelinePaths(repoRoot);
const config = loadConfig(paths);
const PORT = Number(process.env.PIPELINE_UI_PORT || config.uiPort || 4600);

const ARTIFACTS = ['specs.md', 'changes.md', 'checker_report.md', 'test_suite.md', 'review_report.md', 'vague_request.txt'];
const LOG_STAGES = ['planner', 'coder', 'tester', 'reviewer'];

function readState() {
  let status = null;
  try { status = JSON.parse(fs.readFileSync(paths.status, 'utf8')); } catch {}
  const artifacts = ARTIFACTS.filter((n) => {
    try { return fs.statSync(path.join(paths.dir, n)).size > 0; } catch { return false; }
  });
  const logs = {};
  for (const s of LOG_STAGES) logs[s] = tailFile(path.join(paths.logs, `${s}.log`), 120);
  return { status, artifacts, logs, now: new Date().toISOString() };
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

// Watch .pipeline/ (and logs/) with debounce; recursive fs.watch is supported
// on macOS and Windows; on Linux we re-attach a watcher to logs/ manually.
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
    setInterval(() => {
      try { fs.watch(paths.logs, (_e, f) => onFsChange('logs/' + f)); } catch {}
    }, 5000);
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(fs.readFileSync(path.join(__dirname, 'dashboard.html')));
  } else if (url.pathname === '/api/state') {
    json(res, readState());
  } else if (url.pathname === '/api/artifact') {
    const name = url.searchParams.get('name');
    if (!ARTIFACTS.includes(name)) return json(res, { error: 'unknown artifact' }, 400);
    try {
      const content = fs.readFileSync(path.join(paths.dir, name), 'utf8');
      json(res, { name, content });
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
