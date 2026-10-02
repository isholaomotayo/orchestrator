#!/usr/bin/env node
// Find or start the dashboard server for a project and print where it is.
// One launch path for everything that needs a server (orchestrate.sh, the
// desktop app, scripts): reuse a healthy pipeline-ui on the port range and
// register this project with it, otherwise start one detached.
//
// Usage: node pipeline/ui-ensure.mjs [--repo <dir>] [--json]
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const repoRoot = path.resolve(flag('--repo') || process.cwd());
const json = argv.includes('--json');
const pipelineDir = path.join(repoRoot, '.pipeline');

function basePort() {
  try { return Number(JSON.parse(fs.readFileSync(path.join(pipelineDir, 'config.json'), 'utf8')).uiPort) || 4600; } catch { return 4600; }
}

async function health(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) });
    const body = await res.json();
    return body?.service === 'pipeline-ui' ? body : null;
  } catch { return null; }
}

function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function register(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repoRoot }),
      signal: AbortSignal.timeout(2000),
    });
    return (await res.json())?.ok === true;
  } catch { return false; }
}

function report(result) {
  try { fs.writeFileSync(path.join(pipelineDir, 'ui.url'), `${result.url}/?project=${encodeURIComponent(repoRoot)}\n`); } catch { /* not fatal */ }
  if (json) console.log(JSON.stringify(result));
  else console.log(`${result.started ? 'Started' : 'Using'} dashboard at ${result.url} (instance ${result.instanceId})`);
}

async function main() {
  if (!fs.existsSync(pipelineDir)) {
    console.error(`[ui] ${repoRoot} has no .pipeline/ directory; install the orchestrator there first.`);
    return 1;
  }
  const base = basePort();
  for (let port = base; port <= base + 20; port++) {
    const h = await health(port);
    if (h) {
      if (await register(port)) { report({ url: `http://127.0.0.1:${port}`, port, instanceId: h.instanceId || null, apiVersions: h.apiVersions || [], started: false }); return 0; }
      continue;
    }
    if (!(await portFree(port))) continue;
    const engine = fs.existsSync(path.join(repoRoot, 'pipeline', 'ui-server.mjs')) ? path.join(repoRoot, 'pipeline', 'ui-server.mjs') : path.join(HERE, 'ui-server.mjs');
    const out = fs.openSync(path.join(pipelineDir, 'ui-server.out'), 'a');
    const child = spawn(process.execPath, [engine], { cwd: repoRoot, detached: true, stdio: ['ignore', out, out], env: { ...process.env, PIPELINE_UI_PORT: String(port) } });
    child.unref();
    fs.closeSync(out);
    try { fs.writeFileSync(path.join(pipelineDir, 'ui-server.pid'), String(child.pid)); } catch { /* not fatal */ }
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 150));
      const started = await health(port);
      if (started) { report({ url: `http://127.0.0.1:${port}`, port, instanceId: started.instanceId || null, apiVersions: started.apiVersions || [], started: true }); return 0; }
    }
    console.error(`[ui] The dashboard did not come up on port ${port}; see ${path.join(pipelineDir, 'ui-server.out')}.`);
    return 1;
  }
  console.error(`[ui] No free port in ${base}-${base + 20} and no reusable dashboard.`);
  return 1;
}

process.exitCode = await main();
