// Read one run from disk into the v1 RunSummary. Shared by the dashboard
// server and `orchestrate.sh doctor`, so the CLI can never describe a run
// differently from the UI (and works with no server running).
import fs from 'node:fs';
import path from 'node:path';
import { pipelinePaths, readLock, pidAlive } from './state.mjs';
import { isValidRunId } from './run-registry.mjs';
import { inspectBridge } from './bridge.mjs';
import { runSummary } from './api-v1.mjs';
import { supervisorState } from './pool.mjs';

/** Run ids present in a project: null is the single-run (root) run. */
export function listRunIdsOf(repoRoot) {
  const paths = pipelinePaths(repoRoot);
  const ids = [];
  if (fs.existsSync(path.join(paths.dir, 'status.json'))) ids.push(null);
  try {
    for (const d of fs.readdirSync(paths.runs)) {
      if (isValidRunId(d) && fs.existsSync(path.join(paths.runs, d, 'status.json'))) ids.push(d);
    }
  } catch { /* no runs yet */ }
  return ids;
}

/** @returns {{summary: object, supervisor: object|null}|null} null when the run has no readable status. */
export function readRunSummary(repoRoot, runId, { config = {}, now } = {}) {
  const paths = pipelinePaths(repoRoot);
  if (runId && !isValidRunId(runId)) return null;
  const dir = runId ? path.join(paths.runs, runId) : paths.dir;
  let status = null;
  try { status = JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8')); } catch { return null; }
  const runPaths = pipelinePaths(repoRoot, { runId: runId || null });
  const lock = readLock(runPaths);
  const engineAlive = !!(lock && pidAlive(lock.pid));
  let owner = null;
  try { owner = inspectBridge(repoRoot, runId).owner; } catch { /* unreadable journal: no owner */ }
  let lastEventAt = null;
  try { lastEventAt = fs.statSync(runPaths.events).mtime.toISOString(); } catch { /* no events yet */ }
  // Only pool runs depend on the supervisor; a single run is never blamed on it.
  let supervisor = null;
  if (status.featureId) { try { supervisor = supervisorState(paths); } catch { /* no pool state: no accusation */ } }
  const summary = runSummary({
    runId: runId || 'root', status, dir, config, engineAlive, pid: engineAlive ? lock.pid : null,
    owner, lastEventAt, supervisor, ...(now ? { now } : {}),
  });
  return { summary, supervisor };
}
