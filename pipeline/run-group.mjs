#!/usr/bin/env node
// Runs one configured check command in its own process group and kills the
// whole group on timeout. checker.mjs used spawnSync({ shell: true, timeout }),
// which kills only the shell: a hung test runner's workers lived on, holding
// ports and CPU while the next cycle started.
//
// Usage: PIPELINE_CHECK_CMD="<shell command>" node run-group.mjs <timeoutMs>
import { spawn } from 'node:child_process';

const TIMEOUT_MARKER = '[checker] command timed out after';
const timeoutMs = Number(process.argv[2]) || 0;
const cmd = process.env.PIPELINE_CHECK_CMD || '';
const child = spawn(cmd, { shell: true, detached: true, stdio: 'inherit' });
const killGroup = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already gone */ } };
let timedOut = false;
const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; killGroup(); }, timeoutMs) : null;
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { killGroup(); process.exit(143); });
child.on('error', (err) => { process.stderr.write(`${err.message}\n`); process.exit(127); });
child.on('exit', (code, signal) => {
  if (timer) clearTimeout(timer);
  // Background processes a check left behind (watchers, servers) go too.
  killGroup();
  if (timedOut) {
    process.stderr.write(`\n${TIMEOUT_MARKER} ${timeoutMs}ms and its process group was killed\n`);
    process.exit(124);
  }
  process.exit(code ?? (signal ? 128 : 1));
});
