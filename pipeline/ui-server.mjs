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
import { pipelinePaths, loadConfig, pidAlive, readLock, ensureStageEntries, CORE_STAGES, STAGE_ARTIFACT_FILES } from './state.mjs';
import { validateArtifactFile } from './artifacts.mjs';
import { DEFAULT_MODEL_PROFILES, DEFAULT_STAGE_EFFORT, EFFORT_LEVELS, MODEL_CATALOG } from './models.mjs';
import { routeMessage } from './router.mjs';
import { isTrustedRequest } from './http-guard.mjs';
import { isOrchestratorSourceRepo } from './self-guard.mjs';
import { resolveEngineEntry, readInstall, readCheck, gitHead, packageVersion } from './installer.mjs';
import * as pool from './pool.mjs';
import { skillStatuses } from './skills.mjs';

// Dashboard-initiated runs must honor the same self-targeting guard as the CLI
// entrypoints (the spawned engine would refuse anyway — this returns a friendly
// 403 instead of a dead orchestrator.out).
function selfGuardError(project) {
  if (isOrchestratorSourceRepo(project.repoRoot) && process.env.ORCH_ALLOW_SELF !== '1') {
    return { error: 'refusing to target the orchestrator source repository — install the pipeline into a consumer project and run it there (maintainers: set ORCH_ALLOW_SELF=1)', code: 403 };
  }
  return null;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// One dashboard serves many projects, so "which engine runs this?" is a real
// question. Prefer the target project's own orchestrator.mjs — that is what its
// CLI entrypoint uses, and a run should not behave differently just because it
// was started from the sidebar.
function orchestratorEntry(project) {
  const resolved = resolveEngineEntry({ repoRoot: project.repoRoot, hostDir: __dirname });
  if (resolved.source === 'host' && !project.warnedHostEngine) {
    project.warnedHostEngine = true;
    console.warn(`[UI] ${project.repoRoot} has no pipeline/orchestrator.mjs — falling back to this server's engine.`);
  }
  return resolved.entry;
}

// The host's own identity, resolved once, for comparison against each project's.
const HOST_ENGINE = { version: packageVersion(path.dirname(__dirname)), commit: gitHead(__dirname) };

const defaultRepoRoot = path.resolve(process.cwd());
const defaultPaths = pipelinePaths(defaultRepoRoot);
const defaultConfig = loadConfig(defaultPaths);
const PORT = Number(process.env.PIPELINE_UI_PORT || defaultConfig.uiPort || 4600);
const HOST = '127.0.0.1';

// This server is started detached (nohup, see orchestrate.sh) so nothing else
// ever stops it — a run finishing doesn't touch it, since one dashboard is
// meant to keep serving run history and other projects after that. Left alone
// that means it survives indefinitely: idle for hours or days after every run
// it was watching has finished. Auto-shut-down once nobody has a tab open
// (no requests, no SSE clients) AND no registered project has a run in flight.
// 0 disables this (see uiIdleTimeoutMs in config.json / PIPELINE_UI_IDLE_TIMEOUT_MS).
const IDLE_TIMEOUT_MS = process.env.PIPELINE_UI_IDLE_TIMEOUT_MS !== undefined
  ? Number(process.env.PIPELINE_UI_IDLE_TIMEOUT_MS)
  : defaultConfig.uiIdleTimeoutMs;
let lastActivityAt = Date.now();

const ARTIFACTS = ['specs.md', 'design.md', 'changes.md', 'checker_report.md', 'test_suite.md', 'review_report.md', 'review_correctness.md', 'review_security.md', 'review_architecture.md', 'handoff.md', 'reporter.md', 'diff.patch', 'vague_request.txt', 'stage-handoff.json'];
const AGENT_STAGES = ['planner', 'designer', 'coder', 'tester', 'reviewer', 'handoff', 'reporter'];
const RUNNERS = ['auto', 'host', 'claude', 'cursor', 'codex', 'antigravity'];
const EVENTS_PER_STAGE = 250;

// Project registry map: repoRoot -> project context object
const projects = new Map();

function getOrCreateProject(projectPath) {
  let resolvedPath;
  try {
    resolvedPath = path.resolve(projectPath);
    if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isDirectory()) {
      return null;
    }
  } catch {
    return null;
  }

  if (projects.has(resolvedPath)) {
    return projects.get(resolvedPath);
  }

  const pPaths = pipelinePaths(resolvedPath);
  const pConfig = loadConfig(pPaths);
  const project = {
    repoRoot: resolvedPath,
    paths: pPaths,
    config: pConfig,
    sseClients: new Set(),
    changedSet: new Set(),
    debounceTimer: null,
    watcher: null,
  };

  // Watcher setup
  fs.mkdirSync(pPaths.dir, { recursive: true });
  const onFsChange = (file) => {
    project.changedSet.add(file || '*');
    clearTimeout(project.debounceTimer);
    project.debounceTimer = setTimeout(() => {
      const msg = `data: ${JSON.stringify({ type: 'change', changed: [...project.changedSet] })}\n\n`;
      for (const res of project.sseClients) {
        try { res.write(msg); } catch { project.sseClients.delete(res); }
      }
      project.changedSet.clear();
    }, 150);
  };

  try {
    project.watcher = fs.watch(pPaths.dir, { recursive: true }, (_e, f) => onFsChange(f));
  } catch {
    try {
      project.watcher = fs.watch(pPaths.dir, (_e, f) => onFsChange(f));
    } catch (err) {
      console.error(`[UI] Failed to watch ${pPaths.dir}: ${err.message}`);
    }
  }

  projects.set(resolvedPath, project);
  return project;
}

// Register the default project at startup
getOrCreateProject(defaultRepoRoot);

function runDir(project, runId) {
  if (!runId) return project.paths.dir;
  if (!/^[\w.-]+$/.test(runId)) return null;
  const dir = path.join(project.paths.runs, runId);
  return fs.existsSync(dir) ? dir : null;
}

// Cost must be summed over the WHOLE log: reading only the trailing window (as
// the feed does) silently under-reports every run long enough to need it. The
// log is truncated per run, so a full scan stays bounded.
function readTotalCost(file) {
  let total = 0;
  let truncated = false;
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { costUsd: 0, truncated }; }
  for (const line of raw.split('\n')) {
    if (!line.includes('costUsd')) continue; // cheap prefilter; most lines have none
    try {
      const ev = JSON.parse(line);
      if (typeof ev.costUsd === 'number') total += ev.costUsd;
    } catch { truncated = true; }
  }
  return { costUsd: total, truncated };
}

function readEventsByStage(dir) {
  const byStage = Object.fromEntries(AGENT_STAGES.map((s) => [s, []]));
  const file = path.join(dir, 'events.jsonl');
  const { costUsd: totalCost, truncated: costPartial } = readTotalCost(file);
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
  } catch { return { byStage, totalCost, costPartial }; }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (!byStage[ev.stage]) continue;
    if (['agent_output', 'agent_start', 'checks_start', 'check_end', 'followup_applied', 'chat_handoff'].includes(ev.type)) {
      byStage[ev.stage].push(ev);
    }
  }
  for (const s of AGENT_STAGES) {
    if (byStage[s].length > EVENTS_PER_STAGE) byStage[s] = byStage[s].slice(-EVENTS_PER_STAGE);
  }
  return { byStage, totalCost, costPartial };
}

function readFollowups(project) {
  const out = {};
  for (const s of AGENT_STAGES) {
    try {
      const t = fs.readFileSync(path.join(project.paths.dir, 'followups', `${s}.txt`), 'utf8').trim();
      if (t) out[s] = t;
    } catch {}
  }
  return out;
}

function orchestratorAlive(project) {
  const lock = readLock(project.paths);
  return !!(lock && pidAlive(lock.pid));
}

// Which engine this project's runs use, and whether its scaffold is behind
// upstream. Both are read from disk each time — they are two small JSON files,
// and a stale answer here would be worse than the read.
function engineInfo(project) {
  const installed = readInstall(project.repoRoot);
  const check = readCheck(project.repoRoot);
  const source = resolveEngineEntry({ repoRoot: project.repoRoot, hostDir: __dirname }).source;
  const latest = check?.latestCommit || null;
  return {
    engine: {
      source,
      projectCommit: installed?.commit || null,
      hostCommit: HOST_ENGINE.commit,
      // Commits are not orderable from here, so this says "differs" — never "older".
      mismatch: !!(installed?.commit && HOST_ENGINE.commit && installed.commit !== HOST_ENGINE.commit),
    },
    install: installed && {
      version: installed.version || null,
      commit: installed.commit || null,
      updatedAt: installed.updatedAt || null,
      latestCommit: latest,
      updateAvailable: !!(installed.commit && latest && installed.commit !== latest),
    },
  };
}

function readState(project, runId) {
  const dir = runDir(project, runId);
  if (!dir) return { error: 'unknown run' };
  let status = null;
  try { status = JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8')); } catch {}
  // Backfill stages a legacy (4-stage) status.json never wrote, so the dashboard
  // can tell "optional stage never ran" (skipped) from "not started yet" (pending).
  if (status) ensureStageEntries(status);
  const live = dir === project.paths.dir;
  const stale = live && status?.overall === 'running' && !orchestratorAlive(project);
  const artifacts = ARTIFACTS.filter((n) => {
    try { return fs.statSync(path.join(dir, n)).size > 0; } catch { return false; }
  });
  const { byStage, totalCost, costPartial } = readEventsByStage(dir);
  const canExtend = live && !orchestratorAlive(project) && status?.overall === 'halted' && status?.haltReason === 'MAX_CYCLES';
  const canResume = live &&
    !orchestratorAlive(project) &&
    ((status?.overall === 'halted' && status?.haltReason === 'INTERRUPTED') ||
      (status?.overall === 'running' && stale));
  const idle = live && !orchestratorAlive(project);
  const canApprovePlan = idle && status?.overall === 'awaiting_plan_approval';
  // Whether the awaited stage's artifact is present and usable yet — lets the
  // dashboard enable "Continue" only when continuing would actually work.
  let stageReady = null;
  if (idle && status?.overall === 'awaiting_chat' && status?.awaitingStage) {
    const artifact = STAGE_ARTIFACT_FILES[status.awaitingStage];
    stageReady = artifact
      ? validateArtifactFile(status.awaitingStage, path.join(dir, artifact))
      : { ok: true, reason: null };
  }
  return {
    status, artifacts, events: byStage,
    followups: live ? readFollowups(project) : {},
    live, stale, runId: runId || null,
    totals: { costUsd: totalCost, costPartial: !!costPartial },
    canCancel: live && orchestratorAlive(project),
    canExtend,
    canResume,
    canApprovePlan,
    canContinue: idle && status?.overall === 'awaiting_chat',
    stageReady,
    ...engineInfo(project),
    runners: [...RUNNERS, ...Object.keys(project.config.customRunners || {})],
    defaults: {
      maxCoderCycles: project.config.maxCoderCycles,
      maxPostTesterCycles: project.config.maxPostTesterCycles,
      maxReviewCycles: project.config.maxReviewCycles,
      extendCycles: project.config.maxCoderCycles,
      modelProfiles: project.config.modelProfiles?.auto || DEFAULT_MODEL_PROFILES.auto,
      modelCatalog: MODEL_CATALOG,
      stageEffort: { ...DEFAULT_STAGE_EFFORT, ...(project.config.stageEffort || {}) },
      effortLevels: EFFORT_LEVELS,
    },
    now: new Date().toISOString(),
  };
}

function listRuns(project) {
  let ids = [];
  try { ids = fs.readdirSync(project.paths.runs).filter((n) => /^[\w.-]+$/.test(n)).sort().reverse(); } catch {}
  const runs = ids.map((id) => {
    let s = null;
    try { s = JSON.parse(fs.readFileSync(path.join(project.paths.runs, id, 'status.json'), 'utf8')); } catch {}
    return {
      id, kind: 'pool', task: s?.task || '(unknown)', overall: s?.overall,
      verdict: s?.verdict, haltReason: s?.haltReason, startedAt: s?.startedAt, live: false,
    };
  });
  // A plain single-run project (no pool) keeps its live run at the project
  // root, not under paths.runs — without this it has state to read
  // (readState already serves it) but nothing in the sidebar ever opens it.
  // id '' is deliberate: /api/state with a falsy run param serves the root dir.
  let primary = null;
  try { primary = JSON.parse(fs.readFileSync(path.join(project.paths.dir, 'status.json'), 'utf8')); } catch {}
  if (primary) {
    runs.unshift({
      id: '', kind: 'single', task: primary.task || '(unknown)', overall: primary.overall,
      verdict: primary.verdict, haltReason: primary.haltReason, startedAt: primary.startedAt,
      live: primary.overall === 'running' || primary.overall === 'awaiting_chat' || primary.overall === 'awaiting_plan_approval',
    });
  }
  return runs;
}

function positiveInt(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function spawnOrchestrator(project, nodeArgs, options = {}) {
  const outPath = path.join(project.paths.dir, 'orchestrator.out');
  const flags = options.append ? 'a' : 'w';
  const outFd = fs.openSync(outPath, flags);
  fs.writeSync(outFd, `\n[UI] Spawning at ${new Date().toISOString()}: ${process.execPath} ${nodeArgs.join(' ')}\n`);
  
  const child = spawn(process.execPath, nodeArgs, {
    cwd: project.repoRoot,
    detached: true,
    stdio: ['ignore', outFd, outFd],
    env: { ...process.env, PIPELINE_UI_PORT: String(PORT) },
  });
  
  child.unref();
  fs.closeSync(outFd);
  return child;
}

function startRun(project, { task, runner, sandbox, maxCycles, maxPostTesterCycles, maxReviewCycles, modelProfile, models, design, handoff, approvePlan }) {
  const guarded = selfGuardError(project);
  if (guarded) return guarded;
  if (typeof task !== 'string' || !task.trim()) return { error: 'task is required', code: 400 };
  if (runner && !RUNNERS.includes(runner) && !project.config.customRunners?.[runner]) return { error: 'unknown runner', code: 400 };
  if (orchestratorAlive(project)) return { error: 'a pipeline run is already active', code: 409 };
  const profile = modelProfile === 'manual' ? 'manual' : 'auto';
  if (profile === 'manual') {
    if (!models || typeof models !== 'object') return { error: 'manual model profile requires models object', code: 400 };
    for (const stage of CORE_STAGES) {
      if (typeof models[stage] !== 'string' || !models[stage].trim()) {
        return { error: `models.${stage} is required for manual profile`, code: 400 };
      }
    }
  }
  const nodeArgs = [orchestratorEntry(project), '--task', task.trim(), '--model-profile', profile];
  if (profile === 'manual') nodeArgs.push('--models', JSON.stringify(models));
  if (runner && runner !== 'auto') {
    nodeArgs.push('--runner', runner);
    if (runner === 'host') nodeArgs.push('--mode', 'chat');
  }
  if (sandbox) nodeArgs.push('--sandbox');
  const mc = positiveInt(maxCycles);
  if (mc) nodeArgs.push('--max-cycles', String(mc));
  const mptc = positiveInt(maxPostTesterCycles);
  if (mptc) nodeArgs.push('--max-post-tester-cycles', String(mptc));
  const mrc = positiveInt(maxReviewCycles);
  if (mrc) nodeArgs.push('--max-review-cycles', String(mrc));
  // The optional stages and the approval gate were CLI-only until now, so the
  // dashboard could not start the pipeline's three headline features.
  if (design) nodeArgs.push('--design');
  if (handoff) nodeArgs.push('--handoff');
  if (approvePlan) nodeArgs.push('--approve-plan');
  const child = spawnOrchestrator(project, nodeArgs, { append: false });
  return { ok: true, pid: child.pid };
}

function extendRun(project, { extend, runner }) {
  const guarded = selfGuardError(project);
  if (guarded) return guarded;
  const n = positiveInt(extend);
  if (!n) return { error: 'extend must be a positive integer', code: 400 };
  if (orchestratorAlive(project)) return { error: 'a pipeline run is already active', code: 409 };
  let status;
  try { status = JSON.parse(fs.readFileSync(path.join(project.paths.dir, 'status.json'), 'utf8')); } catch {
    return { error: 'no run to extend', code: 409 };
  }
  if (status.overall !== 'halted' || status.haltReason !== 'MAX_CYCLES') {
    return { error: `cannot extend: last halt reason was "${status.haltReason || status.overall}", not MAX_CYCLES`, code: 409 };
  }
  const nodeArgs = [orchestratorEntry(project), '--resume', '--extend', String(n)];
  if (runner && runner !== 'auto') {
    nodeArgs.push('--runner', runner);
    if (runner === 'host') nodeArgs.push('--mode', 'chat');
  }
  const child = spawnOrchestrator(project, nodeArgs, { append: true });
  return { ok: true, pid: child.pid, extend: n };
}

function resumeInterruptedRunUi(project, { runner }) {
  const guarded = selfGuardError(project);
  if (guarded) return guarded;
  if (orchestratorAlive(project)) return { error: 'a pipeline run is already active', code: 409 };
  let status;
  try { status = JSON.parse(fs.readFileSync(path.join(project.paths.dir, 'status.json'), 'utf8')); } catch {
    return { error: 'no run to resume', code: 409 };
  }
  const lock = readLock(project.paths);
  const stale = status.overall === 'running' && !(lock && pidAlive(lock.pid));
  const isInterrupted = status.overall === 'halted' && status.haltReason === 'INTERRUPTED';
  if (!isInterrupted && !stale) {
    return { error: `cannot resume: run is not interrupted or stale (overall=${status.overall}, haltReason=${status.haltReason})`, code: 409 };
  }
  const nodeArgs = [orchestratorEntry(project), '--resume'];
  if (runner && runner !== 'auto') {
    nodeArgs.push('--runner', runner);
    if (runner === 'host') nodeArgs.push('--mode', 'chat');
  }
  const child = spawnOrchestrator(project, nodeArgs, { append: true });
  return { ok: true, pid: child.pid };
}

// Advance a run parked at a chat handoff or the plan-approval gate. Without
// this the dashboard could only print the shell command for the user to go and
// type somewhere else — it could observe the pipeline but never move it.
function continueRun(project, { approve = false } = {}) {
  const guarded = selfGuardError(project);
  if (guarded) return guarded;
  if (orchestratorAlive(project)) return { error: 'a pipeline run is already active', code: 409 };
  let status;
  try { status = JSON.parse(fs.readFileSync(project.paths.status, 'utf8')); } catch {
    return { error: 'no run to continue', code: 409 };
  }

  if (status.overall === 'awaiting_plan_approval') {
    // Approving is the human decision this gate exists for; requesting changes
    // is done by queueing a Planner follow-up, which --continue then picks up.
    if (!approve) return { error: 'plan approval requires an explicit approve', code: 400 };
  } else if (status.overall === 'awaiting_chat') {
    // Continuing before the stage was actually completed would march straight
    // into a MISSING_ARTIFACT halt. Say so here instead.
    const stage = status.awaitingStage;
    const artifact = STAGE_ARTIFACT_FILES[stage];
    const check = artifact ? validateArtifactFile(stage, path.join(project.paths.dir, artifact)) : { ok: true };
    if (!check.ok) {
      return { error: `the ${stage} stage has not been completed yet — ${artifact}: ${check.reason}`, code: 409 };
    }
  } else {
    return { error: `cannot continue: run is "${status.overall}", not awaiting a handoff or approval`, code: 409 };
  }

  const child = spawnOrchestrator(project, [orchestratorEntry(project), '--continue'], { append: true });
  return { ok: true, pid: child.pid, continued: status.overall };
}

function cancelRun(project) {
  const lock = readLock(project.paths);
  if (!lock || !pidAlive(lock.pid)) return { error: 'no active run', code: 409 };
  try { process.kill(lock.pid, 'SIGTERM'); return { ok: true, signalled: lock.pid }; }
  catch (err) { return { error: err.message, code: 500 }; }
}

// Reports are HTML written by the engine and, for diagrams, by a verified
// third-party renderer. They are served from the same origin as the dashboard's
// API, so two independent things keep them harmless: a Content-Security-Policy
// that denies them any network access at all, and the dashboard embedding them
// in a sandbox without same-origin privileges.
const REPORT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
};
const REPORT_CSP = [
  "sandbox allow-scripts",
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
  "base-uri 'none'",
].join('; ');

function serveReport(project, url, res) {
  const rel = url.searchParams.get('file') || '';
  const runId = url.searchParams.get('run');
  const featureId = url.searchParams.get('feature');
  // A traversal here would serve any file the server can read, so the path is
  // both pattern-checked and resolved against its root before anything is read.
  if (!/^[\w.\-/]+$/.test(rel) || rel.split('/').includes('..')) {
    return json(res, { error: 'invalid file' }, 400);
  }
  let root = null;
  if (runId && /^[\w.-]+$/.test(runId)) root = path.join(project.paths.runs, runId, 'reports');
  else if (featureId && /^[\w.-]+$/.test(featureId)) root = path.join(project.paths.control, 'reports', featureId);
  if (!root) return json(res, { error: 'expected run or feature' }, 400);

  let resolved;
  try {
    resolved = fs.realpathSync(path.resolve(root, rel));
    const rootReal = fs.realpathSync(root);
    if (resolved !== rootReal && !resolved.startsWith(rootReal + path.sep)) throw new Error('outside');
  } catch {
    return json(res, { error: 'not found' }, 404);
  }
  const type = REPORT_TYPES[path.extname(resolved).toLowerCase()];
  if (!type) return json(res, { error: 'unsupported file type' }, 415);
  try {
    const body = fs.readFileSync(resolved);
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Security-Policy': REPORT_CSP,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    json(res, { error: 'not found' }, 404);
  }
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

function getProjectForRequest(req, url) {
  const projectPath = url.searchParams.get('project');
  if (projectPath) {
    const proj = getOrCreateProject(projectPath);
    if (proj) return proj;
  }
  return getOrCreateProject(defaultRepoRoot);
}

// Every state-changing endpoint is protected from CSRF and DNS-rebinding.
// A prefix test rather than a list: a new POST route is guarded by default,
// which is the safe direction to be wrong in.
function isGuardedPost(pathname) {
  return pathname.startsWith('/api/');
}

const server = http.createServer((req, res) => {
  lastActivityAt = Date.now();
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (req.method === 'POST' && isGuardedPost(url.pathname) && !isTrustedRequest(req.headers, PORT)) {
    return json(res, { error: 'forbidden: untrusted origin' }, 403);
  }
  if (req.method === 'POST' && url.pathname === '/api/register') {
    readBody(req, (body) => {
      if (!body || typeof body.repoRoot !== 'string') {
        return json(res, { error: 'expected { repoRoot }' }, 400);
      }
      const project = getOrCreateProject(body.repoRoot);
      if (!project) {
        return json(res, { error: 'invalid repository path' }, 400);
      }
      json(res, { ok: true, repoRoot: project.repoRoot });
    });
  } else if (req.method === 'POST' && url.pathname === '/api/followup') {
    const project = getProjectForRequest(req, url);
    if (!project) return json(res, { error: 'invalid project' }, 400);
    readBody(req, (body) => {
      if (!body || !AGENT_STAGES.includes(body.stage) || typeof body.text !== 'string' || !body.text.trim()) {
        return json(res, { error: 'expected { stage: planner|designer|coder|tester|reviewer|handoff, text }' }, 400);
      }
      const dir = path.join(project.paths.dir, 'followups');
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, `${body.stage}.txt`), body.text.trim() + '\n');
      json(res, { ok: true, queued: body.stage });
    });
  } else if (req.method === 'POST' && url.pathname === '/api/orchestrate') {
    const project = getProjectForRequest(req, url);
    if (!project) return json(res, { error: 'invalid project' }, 400);
    readBody(req, async (body) => {
      if (!body || typeof body.text !== 'string' || !body.text.trim()) {
        return json(res, { error: 'expected { text }' }, 400);
      }
      let status = null;
      try {
        status = JSON.parse(fs.readFileSync(path.join(project.paths.dir, 'status.json'), 'utf8'));
      } catch (e) {}
      try {
        const result = await routeMessage({ text: body.text, status, config: project.config });
        const dir = path.join(project.paths.dir, 'followups');
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(path.join(dir, `${result.stage}.txt`), body.text.trim() + '\n');
        json(res, { ok: true, stage: result.stage, via: result.via, reason: result.reason });
      } catch (err) {
        json(res, { error: err.message || 'Internal routing error' }, 500);
      }
    });
  } else if (req.method === 'POST' && url.pathname === '/api/run') {
    const project = getProjectForRequest(req, url);
    if (!project) return json(res, { error: 'invalid project' }, 400);
    readBody(req, (body) => {
      if (!body) return json(res, { error: 'invalid JSON' }, 400);
      const result = startRun(project, body);
      json(res, result, result.code || 200);
    });
  } else if (req.method === 'POST' && url.pathname === '/api/continue') {
    const project = getProjectForRequest(req, url);
    if (!project) return json(res, { error: 'invalid project' }, 400);
    readBody(req, (body) => {
      const result = continueRun(project, body || {});
      json(res, result, result.code || 200);
    });
  } else if (req.method === 'POST' && url.pathname === '/api/cancel') {
    const project = getProjectForRequest(req, url);
    if (!project) return json(res, { error: 'invalid project' }, 400);
    const result = cancelRun(project);
    json(res, result, result.code || 200);
  } else if (req.method === 'POST' && url.pathname === '/api/extend') {
    const project = getProjectForRequest(req, url);
    if (!project) return json(res, { error: 'invalid project' }, 400);
    readBody(req, (body) => {
      if (!body) return json(res, { error: 'invalid JSON' }, 400);
      const result = extendRun(project, body);
      json(res, result, result.code || 200);
    });
  } else if (req.method === 'POST' && url.pathname === '/api/resume') {
    const project = getProjectForRequest(req, url);
    if (!project) return json(res, { error: 'invalid project' }, 400);
    readBody(req, (body) => {
      const result = resumeInterruptedRunUi(project, body || {});
      json(res, result, result.code || 200);
    });
  } else if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(fs.readFileSync(path.join(__dirname, 'dashboard.html')));
  } else if (url.pathname === '/api/state') {
    const project = getProjectForRequest(req, url);
    if (!project) return json(res, { error: 'invalid project' }, 400);
    const state = readState(project, url.searchParams.get('run'));
    json(res, state, state.error ? 404 : 200);
  } else if (url.pathname === '/api/runs') {
    const project = getProjectForRequest(req, url);
    if (!project) return json(res, { error: 'invalid project' }, 400);
    json(res, { runs: listRuns(project) });
  } else if (url.pathname === '/api/projects') {
    const list = [];
    for (const [pRoot, p] of projects.entries()) {
      let status = null;
      try {
        status = JSON.parse(fs.readFileSync(path.join(p.paths.dir, 'status.json'), 'utf8'));
      } catch {}
      list.push({
        repoRoot: pRoot,
        name: path.basename(pRoot),
        overall: status?.overall || 'idle',
        task: status?.task || '(no active task)'
      });
    }
    json(res, { projects: list });
  } else if (url.pathname === '/api/artifact') {
    const project = getProjectForRequest(req, url);
    if (!project) return json(res, { error: 'invalid project' }, 400);
    const name = url.searchParams.get('name');
    const dir = runDir(project, url.searchParams.get('run'));
    if (!ARTIFACTS.includes(name) || !dir) return json(res, { error: 'unknown artifact' }, 400);
    try {
      json(res, { name, content: fs.readFileSync(path.join(dir, name), 'utf8') });
    } catch {
      json(res, { name, content: '' });
    }
  } else if (url.pathname === '/api/pool') {
    const project = getProjectForRequest(req, url);
    if (!project) return json(res, { error: 'invalid project' }, 400);
    if (!fs.existsSync(project.paths.control)) return json(res, { enabled: false });
    try {
      const snap = pool.snapshot(project.paths, { config: project.config });
      snap.skills = skillStatuses(project.config, { repoRoot: project.repoRoot, paths: project.paths });
      json(res, { enabled: true, snapshot: snap, roadmap: pool.readRoadmap(project.paths) });
    } catch (err) {
      json(res, { enabled: true, degraded: true, error: err.message }, 200);
    }
  } else if (url.pathname === '/api/decisions') {
    const project = getProjectForRequest(req, url);
    if (!project) return json(res, { error: 'invalid project' }, 400);
    const all = url.searchParams.get('status') === 'all';
    json(res, { decisions: all ? pool.readDecisions(project.paths) : pool.openDecisions(project.paths) });
  } else if (url.pathname === '/api/log') {
    const project = getProjectForRequest(req, url);
    if (!project) return json(res, { error: 'invalid project' }, 400);
    const stage = url.searchParams.get('stage');
    const dir = runDir(project, url.searchParams.get('run'));
    if (!AGENT_STAGES.includes(stage) || !dir) return json(res, { error: 'unknown stage' }, 400);
    // Logs are unbounded; serve a bounded window so one enormous transcript
    // cannot stall the dashboard or the server.
    const file = path.join(dir, 'logs', `${stage}.log`);
    try {
      const size = fs.statSync(file).size;
      const limit = Math.min(Number(url.searchParams.get('limit')) || 65536, 262144);
      const offset = url.searchParams.has('offset')
        ? Math.max(0, Math.min(Number(url.searchParams.get('offset')) || 0, size))
        : Math.max(0, size - limit);
      const fd = fs.openSync(file, 'r');
      const length = Math.min(limit, size - offset);
      const buf = Buffer.alloc(Math.max(0, length));
      if (length > 0) fs.readSync(fd, buf, 0, length, offset);
      fs.closeSync(fd);
      json(res, { stage, offset, next: offset + length, size, text: buf.toString('utf8') });
    } catch {
      json(res, { stage, offset: 0, next: 0, size: 0, text: '' });
    }
  } else if (url.pathname === '/api/report') {
    const project = getProjectForRequest(req, url);
    if (!project) return json(res, { error: 'invalid project' }, 400);
    serveReport(project, url, res);
  } else if (req.method === 'POST' && url.pathname === '/api/decisions/answer') {
    const project = getProjectForRequest(req, url);
    if (!project) return json(res, { error: 'invalid project' }, 400);
    readBody(req, (body) => {
      if (!body?.decisionId || !body.answer) return json(res, { error: 'expected { decisionId, answer }' }, 400);
      try {
        json(res, { ok: true, decision: pool.decide(project.paths, body.decisionId, String(body.answer), { via: 'dashboard' }) });
      } catch (err) {
        json(res, { error: err.message }, 409);
      }
    });
  } else if (req.method === 'POST' && url.pathname === '/api/merge/approve') {
    const project = getProjectForRequest(req, url);
    if (!project) return json(res, { error: 'invalid project' }, 400);
    const guard = selfGuardError(project);
    if (guard) return json(res, { error: guard.error }, guard.code);
    readBody(req, (body) => {
      if (!body?.featureId) {
        try {
          json(res, { ok: true, ...pool.approveMerge(project.paths, null, { via: 'dashboard', note: body?.note ?? null }) });
        } catch (err) {
          json(res, { error: err.message }, 409);
        }
        return;
      }
      try {
        json(res, { ok: true, ...pool.approveMerge(project.paths, body.featureId, { via: 'dashboard', note: body.note ?? null }) });
      } catch (err) {
        json(res, { error: err.message }, 409);
      }
    });
  } else if (req.method === 'POST' && url.pathname === '/api/merge/request-changes') {
    const project = getProjectForRequest(req, url);
    if (!project) return json(res, { error: 'invalid project' }, 400);
    readBody(req, (body) => {
      if (!body?.featureId || !body.text) return json(res, { error: 'expected { featureId, text }' }, 400);
      try {
        json(res, { ok: true, ...pool.requestChanges(project.paths, body.featureId, String(body.text), { via: 'dashboard' }) });
      } catch (err) {
        json(res, { error: err.message }, 409);
      }
    });
  } else if (req.method === 'POST' && url.pathname === '/api/pool/pause') {
    const project = getProjectForRequest(req, url);
    if (!project) return json(res, { error: 'invalid project' }, 400);
    readBody(req, (body) => json(res, { ok: true, ...pool.pause(project.paths, body?.why ?? '') }));
  } else if (req.method === 'POST' && url.pathname === '/api/pool/resume') {
    const project = getProjectForRequest(req, url);
    if (!project) return json(res, { error: 'invalid project' }, 400);
    readBody(req, () => json(res, { ok: true, ...pool.resume(project.paths) }));
  } else if (url.pathname === '/events') {
    const project = getProjectForRequest(req, url);
    if (!project) return json(res, { error: 'invalid project' }, 400);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    project.sseClients.add(res);
    req.on('close', () => project.sseClients.delete(res));
  } else if (url.pathname === '/healthz') {
    json(res, { ok: true, service: 'pipeline-ui', repoRoot: defaultRepoRoot });
  } else {
    res.writeHead(404); res.end('not found');
  }
});

function anySseClientsConnected() {
  for (const project of projects.values()) if (project.sseClients.size > 0) return true;
  return false;
}
function anyRunActive() {
  for (const project of projects.values()) if (orchestratorAlive(project)) return true;
  return false;
}

setInterval(() => {
  for (const project of projects.values()) {
    const msg = `data: ${JSON.stringify({ type: 'ping' })}\n\n`;
    for (const res of project.sseClients) {
      try { res.write(msg); } catch { project.sseClients.delete(res); }
    }
  }

  if (IDLE_TIMEOUT_MS > 0 && Date.now() - lastActivityAt > IDLE_TIMEOUT_MS && !anySseClientsConnected() && !anyRunActive()) {
    console.log(`[UI] Idle for over ${Math.round(IDLE_TIMEOUT_MS / 60000)}m with no open tabs and no active runs across ${projects.size} project(s) — shutting down.`);
    process.exit(0);
  }
}, 25000);

// Nothing else will do this: the process is started detached (nohup), so its
// own pid/url files are the only record that it's running. Leaving them behind
// after an idle shutdown (or any other exit) would make the next
// orchestrate.sh invocation trust a stale ui.url until its health check fails.
process.on('exit', () => {
  // Only clear the records this process actually wrote. A second dashboard on
  // another port, or a restarted one, must not have its pid and url deleted by
  // an unrelated exit — the next orchestrate.sh would then fail to find it.
  for (const project of new Set([defaultPaths, ...[...projects.values()].map((p) => p.paths)])) {
    try {
      if (Number(fs.readFileSync(path.join(project.dir, 'ui-server.pid'), 'utf8').trim()) === process.pid) {
        fs.unlinkSync(path.join(project.dir, 'ui-server.pid'));
      }
    } catch {}
    try {
      if (fs.readFileSync(path.join(project.dir, 'ui.url'), 'utf8').includes(`:${PORT}`)) {
        fs.unlinkSync(path.join(project.dir, 'ui.url'));
      }
    } catch {}
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[UI] Port ${PORT} is already in use. Set PIPELINE_UI_PORT or config.uiPort to a free port, or stop the process using it.`);
  } else {
    console.error(`[UI] Server error: ${err.message}`);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`[UI] Pipeline dashboard running at http://${HOST}:${PORT} (repo: ${defaultRepoRoot})`);
});
