#!/usr/bin/env node
// Capture dashboard screenshots for README using Playwright.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const outDir = path.join(repoRoot, 'docs', 'screenshots');
const port = Number(process.env.PIPELINE_UI_PORT || 4600);
const url = `http://127.0.0.1:${port}`;
const pidFile = path.join(repoRoot, '.pipeline', 'ui-server.pid');

const shots = [
  { mode: 'idle', file: '01-dashboard-idle.png', action: null },
  { mode: 'running', file: '02-dashboard-running.png', action: null },
  { mode: 'completed', file: '03-dashboard-completed.png', action: null },
  { mode: 'halted', file: '04-dashboard-halted.png', action: null },
  { mode: 'idle', file: '05-new-run-modal.png', action: 'modal' },
];

function stopUi() {
  try {
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    if (pid) process.kill(pid, 'SIGTERM');
  } catch {}
  try { fs.unlinkSync(pidFile); } catch {}
}

function startUi() {
  stopUi();
  const child = spawn(process.execPath, ['pipeline/ui-server.mjs'], {
    cwd: repoRoot,
    env: { ...process.env, PIPELINE_UI_PORT: String(port) },
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, String(child.pid));
}

async function waitForServer() {
  for (let i = 0; i < 40; i++) {
    const res = spawnSync('curl', ['-sf', `${url}/healthz`], { encoding: 'utf8' });
    if (res.status === 0) return;
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
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.app', { timeout: 10000 });
    if (shot.action === 'modal') {
      await page.click('#newrun-btn');
      await page.waitForTimeout(300);
    }
    await page.screenshot({ path: path.join(outDir, shot.file), fullPage: false });
    console.log(`[capture-screenshots] ${shot.file}`);
  }

  await browser.close();
  seed('idle');
  stopUi();
}

main().catch((err) => {
  console.error(err);
  stopUi();
  process.exit(1);
});
