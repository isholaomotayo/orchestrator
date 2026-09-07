#!/usr/bin/env node
// Capture dashboard screenshots for README using Playwright (v2 control room).
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const outDir = path.join(repoRoot, 'docs', 'screenshots');
// Prefer 4650 so a casual dashboard on 4600 is not overwritten or contested.
const port = Number(process.env.PIPELINE_UI_PORT || 4650);
const url = `http://127.0.0.1:${port}`;
const projectQ = `project=${encodeURIComponent(repoRoot)}`;
const pidFile = path.join(repoRoot, '.pipeline', 'ui-server.pid');
let uiPid = null;

const shots = [
  { mode: 'idle', file: '01-dashboard-idle.png', hash: 'tabs=home&active=0', wait: 'h1' },
  { mode: 'running', file: '02-dashboard-running.png', hash: 'tabs=run.coder&active=0', wait: '.agent-header' },
  { mode: 'completed', file: '03-dashboard-completed.png', hash: 'tabs=run.reviewer&active=0', wait: '.agent-header' },
  { mode: 'halted', file: '04-dashboard-halted.png', hash: 'tabs=run.coder&active=0', wait: '.banner.fail, .agent-header' },
  { mode: 'idle', file: '05-dashboard-decisions.png', hash: 'tabs=decisions&active=0', wait: 'h1' },
];

function stopUi() {
  const pid = uiPid || (() => {
    try { return Number(fs.readFileSync(pidFile, 'utf8').trim()); } catch { return 0; }
  })();
  if (pid) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
  uiPid = null;
  try { fs.unlinkSync(pidFile); } catch {}
}

function startUi() {
  stopUi();
  const child = spawn(process.execPath, ['pipeline/ui-server.mjs'], {
    cwd: repoRoot,
    env: { ...process.env, PIPELINE_UI_PORT: String(port), PIPELINE_UI_IDLE_TIMEOUT_MS: '0' },
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
  uiPid = child.pid;
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, String(child.pid));
}

// A dashboard on this port may belong to a DIFFERENT project — one server
// serves many repos, and our own spawn dies with EADDRINUSE while /healthz keeps
// answering. Without checking repoRoot the capture silently screenshots someone
// else's dashboard and overwrites the committed PNGs with it.
async function waitForServer() {
  for (let i = 0; i < 40; i++) {
    const res = spawnSync('curl', ['-sf', `${url}/healthz`], { encoding: 'utf8' });
    if (res.status === 0) {
      let health = {};
      try { health = JSON.parse(res.stdout); } catch {}
      if (health.repoRoot && path.resolve(health.repoRoot) !== repoRoot) {
        throw new Error(
          `Port ${port} is serving a different project (${health.repoRoot}).\n` +
          `Re-run on a free port, e.g. PIPELINE_UI_PORT=4660 npm run screenshots`
        );
      }
      // Ensure this repo is registered even if the server was already up.
      spawnSync('curl', [
        '-sf', '-H', 'Content-Type: application/json',
        '-d', JSON.stringify({ repoRoot }),
        `${url}/api/register`,
      ], { encoding: 'utf8' });
      return;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Dashboard not reachable at ${url}`);
}

function seed(mode) {
  const res = spawnSync(process.execPath, ['scripts/seed-demo-ui.mjs', mode], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    throw new Error(res.stderr || res.stdout || `seed failed for ${mode}`);
  }
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  startUi();
  await waitForServer();

  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  for (const shot of shots) {
    seed(shot.mode);
    // Bust the query so Playwright does a full reload — a hash-only change
    // reuses the previous document and never re-runs boot()/tabs.restore().
    const bust = `t=${Date.now()}`;
    await page.goto(`${url}/?${projectQ}&${bust}#${shot.hash}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.app', { timeout: 10000 });
    await page.waitForSelector(shot.wait, { timeout: 10000 });
    // Let sidebar Runs list + SSE refresh settle after seed.
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(outDir, shot.file), fullPage: false });
    console.log(`[capture-screenshots] ${shot.file}`);
  }

  await browser.close();
  seed('idle');
  stopUi();

  // Drop the old v1 modal shot if it is still around.
  const legacyModal = path.join(outDir, '05-new-run-modal.png');
  try { fs.unlinkSync(legacyModal); } catch {}
}

main().catch((err) => {
  console.error(err);
  stopUi();
  process.exit(1);
});
