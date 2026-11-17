// End to end: stopping the engine (SIGTERM) while an agent runs. The agent's
// process group includes a worker that ignores SIGTERM. The engine must kill
// it (SIGKILL after the grace period) before it exits and frees the run lock,
// or a resumed agent could edit the worktree alongside the old one.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pipelinePaths } from './state.mjs';

const ENGINE = new URL('./orchestrator.mjs', import.meta.url).pathname;
const STAGES = ['planner', 'plan_reviewer', 'designer', 'coder', 'tester', 'reviewer', 'handoff', 'reporter'];
const WORKER = "process.on('SIGTERM', () => {}); require('fs').writeFileSync('worker.pid', String(process.pid)); setInterval(() => {}, 1000);";
const AGENT = [
  `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(WORKER)}], { stdio: 'ignore' });`,
  "process.on('SIGTERM', () => process.exit(0));",
  "console.log('planning');",
  'setInterval(() => {}, 1000);',
].join('\n');

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (cond, ms) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 50)); return cond(); };

test('a stopped engine kills an agent worker that ignores SIGTERM before it frees the run lock', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'interrupt-e2e-')));
  try {
    const git = (...args) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root });
    git('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(root, 'README.md'), 'demo\n');
    fs.writeFileSync(path.join(root, '.gitignore'), 'worker.pid\n');
    git('add', '-A'); git('commit', '-q', '-m', 'init');
    const paths = pipelinePaths(root);
    fs.mkdirSync(paths.prompts, { recursive: true });
    for (const stage of STAGES) fs.writeFileSync(path.join(paths.prompts, `${stage}_prompt.txt`), `prompt for ${stage}`);
    fs.writeFileSync(paths.config, JSON.stringify({
      bridge: { required: false }, agentTimeoutMs: 60000, agentRetries: 0,
      checks: { lint: '', typecheck: '', test: '' },
      customRunners: { stub: { command: process.execPath, args: ['-e', AGENT] } },
    }));
    const engine = spawn(process.execPath, [ENGINE, '--task', 'plan something', '--runner', 'stub', '--mode', 'cli', '--no-ui'], { cwd: root, stdio: 'ignore' });
    const exited = new Promise((resolve) => engine.on('exit', (code) => resolve(code)));
    const pidFile = path.join(root, 'worker.pid');
    assert.ok(await until(() => fs.existsSync(pidFile), 20000), 'the agent started its worker');
    const worker = Number(fs.readFileSync(pidFile, 'utf8'));
    let lockGoneWhileWorkerAlive = false;
    const watch = setInterval(() => { if (!fs.existsSync(paths.lock) && alive(worker)) lockGoneWhileWorkerAlive = true; }, 50);
    engine.kill('SIGTERM');
    const code = await exited;
    clearInterval(watch);
    assert.equal(code, 143);
    assert.equal(alive(worker), false, 'the worker was killed');
    assert.equal(lockGoneWhileWorkerAlive, false, 'the lock was held until the worker was gone');
    assert.equal(fs.existsSync(paths.lock), false, 'then the lock was released');
    const status = JSON.parse(fs.readFileSync(paths.status, 'utf8'));
    assert.equal(status.overall, 'halted');
    assert.equal(status.haltReason, 'INTERRUPTED');
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
