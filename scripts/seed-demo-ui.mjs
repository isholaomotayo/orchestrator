#!/usr/bin/env node
// Seeds .pipeline/ with demo data for README screenshots and local UI previews.
// Usage: node scripts/seed-demo-ui.mjs [idle|running|completed|halted]
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const fixtureRoot = path.join(repoRoot, 'docs', 'screenshots', 'fixtures');
const pipelineDir = path.join(repoRoot, '.pipeline');
const keeperPidFile = path.join(pipelineDir, '.screenshot-keeper.pid');

const mode = process.argv[2] || 'completed';
const fixtureDir = path.join(fixtureRoot, mode);

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === '.gitkeep') continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

function stopKeeper() {
  try {
    const pid = Number(fs.readFileSync(keeperPidFile, 'utf8').trim());
    if (pid) process.kill(pid, 'SIGTERM');
  } catch {}
  try { fs.unlinkSync(keeperPidFile); } catch {}
  try { fs.unlinkSync(path.join(pipelineDir, '.lock')); } catch {}
}

function clearRuntime() {
  stopKeeper();
  const keep = new Set(['config.json', 'prompts', 'orchestrate.sh', 'spawn.sh', 'skill.json']);
  for (const name of fs.readdirSync(pipelineDir)) {
    if (keep.has(name)) continue;
    fs.rmSync(path.join(pipelineDir, name), { recursive: true, force: true });
  }
}

if (!fs.existsSync(fixtureDir)) {
  console.error(`Unknown fixture mode "${mode}". Expected idle|running|completed|halted.`);
  process.exit(1);
}

clearRuntime();
copyDir(fixtureDir, pipelineDir);

if (mode === 'running') {
  const child = spawn('sleep', ['600'], { detached: true, stdio: 'ignore' });
  child.unref();
  fs.writeFileSync(keeperPidFile, String(child.pid));
  fs.writeFileSync(
    path.join(pipelineDir, '.lock'),
    JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString() }, null, 2),
  );
}

console.log(`[seed-demo-ui] Loaded "${mode}" fixture into .pipeline/`);
