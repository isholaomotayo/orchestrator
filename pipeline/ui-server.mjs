#!/usr/bin/env node
// Zero-dependency dashboard server: serves dashboard.html, exposes pipeline
// state (status + structured per-agent activity events + run history) as JSON,
// starts/cancels runs, accepts human follow-up notes for agents, and pushes
// change notifications over Server-Sent Events by watching .pipeline/.
// Binds to 127.0.0.1 only — the dashboard exposes code, diffs, and controls.
import fs from 'node:fs';
import { bridgeCommand, inspectBridge } from './bridge.mjs';
import { isValidRunId } from './run-registry.mjs';
import { readUsage } from './usage.mjs';
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
import { AGENT_STAGES, DASHBOARD_EVENT_TYPES, queueStageNote, readStageNotes } from './events.mjs';

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
  if (!isValidRunId(runId)) return null;
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
    const stage = ev.stage === 'checker' ? 'coder' : ev.stage;
    if (!byStage[stage]) continue;
    if (DASHBOARD_EVENT_TYPES.includes(ev.type)) {
      byStage[stage].push({ ...ev, stage });
    }
  }
  for (const s of AGENT_STAGES) {
    if (byStage[s].length > EVENTS_PER_STAGE) byStage[s] = byStage[s].slice(-EVENTS_PER_STAGE);
  }
  return { byStage, totalCost, costPartial };
}

function readFollowups(dir) {
  return readStageNotes(dir);
}

function runPathsFor(project, runId) {
  return pipelinePaths(project.repoRoot, { runId: runId || null });
}

function runProcessAlive(runPaths) {
  const lock = readLock(runPaths);
  return !!(lock && pidAlive(lock.pid));
}

function loadRunStatus(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8')); } catch { return null; }
}

function activeStageName(status) {
  if (!status) return null;
  if (status.awaitingStage) return status.awaitingStage;
  return (status.stages || []).find((s) => ['running', 'awaiting_host'].includes(s.status))?.name || null;
}

function isArchivedStatus(status) {
  return ['done'].includes(status?.overall);
}

function parkedPoolWork(project) {
  try {
    for (const id of fs.readdirSync(project.paths.runs)) {
      const s = loadRunStatus(path.join(project.paths.runs, id));
      if (s && (s.overall === 'awaiting_chat' || s.overall === 'awaiting_plan_approval' || s.overall === 'running')) return id;
    }
  } catch { /* no runs */ }
  return null;
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
  let status = loadRunStatus(dir);
  if (status) ensureStageEntries(status);
  const runPaths = runPathsFor(project, runId);
  const isRoot = dir === project.paths.dir;
  const alive = runProcessAlive(runPaths);
  const stale = status?.overall === 'running' && !alive;
  const artifacts = ARTIFACTS.filter((n) => {
    try { return fs.statSync(path.join(dir, n)).size > 0; } catch { return false; }
  });
  const { byStage, totalCost, costPartial } = readEventsByStage(dir);
  const canExtend = !alive && status?.overall === 'halted' && status?.haltReason === 'MAX_CYCLES';
  const canResume = !alive &&
    ((status?.overall === 'halted' && status?.haltReason === 'INTERRUPTED') ||
      (status?.overall === 'running' && stale));
  const canApprovePlan = !alive && status?.overall === 'awaiting_plan_approval';
  const canContinue = !alive && status?.overall === 'awaiting_chat';
  const canCancel = alive;
  let stageReady = null;
  if (canContinue && status?.awaitingStage) {
    const artifact = STAGE_ARTIFACT_FILES[status.awaitingStage];
    stageReady = artifact
      ? validateArtifactFile(status.awaitingStage, path.join(dir, artifact))
      : { ok: true, reason: null };
  }
  const live = canCancel || canExtend || canResume || canContinue || canApprovePlan;
  const goal = (() => {
    try {
      const snap = pool.snapshot(project.paths, { config: project.config });
      const row = (snap.inProgress || []).find((r) => r.runId === (runId || snap.pool?.primaryRunId));
      if (row?.goal) return row.goal;
      const feature = snap.roadmap?.features?.find((f) => f.id === status?.featureId);
      return feature
        ? { featureId: feature.id, title: feature.title, dependsOn: feature.dependsOn, acceptance: feature.acceptance, specRunId: feature.specRunId, integrationRunId: feature.integrationRunId }
        : null;
    } catch { return null; }
  })();
  return {
    status, artifacts, events: byStage, bridge: inspectBridge(project.repoRoot, runId || null),
    followups: readFollowups(dir),
    live, stale, runId: runId || null, isRoot, goal,
    totals: { ...readUsage(path.join(dir,'events.jsonl')), costPartial: readUsage(path.join(dir,'events.jsonl')).partial },
    canCancel, canExtend, canResume, canApprovePlan, canContinue,
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
    const controlReportExists = s?.featureId && fs.existsSync(path.join(project.paths.control, 'reports', s.featureId, 'work-done.html'));
    return {
      id, featureId:s?.featureId, ticketId:s?.ticketId,
      hostClient: s?.hostClient ?? null, runner: s?.runner ?? null, invocationMode: s?.invocationMode ?? null, runnerRequested: s?.runnerRequested ?? null,
      stage:s?.awaitingStage || s?.stages?.find(x=>x.status==='running')?.name,
      reportRel: fs.existsSync(path.join(project.paths.runs,id,'reports/work-done.html'))
        ? `.pipeline/runs/${id}/reports/work-done.html`
        : (controlReportExists ? `.pipeline/control/reports/${s.featureId}/work-done.html` : null),
      kind: 'pool', task: s?.task || '(unknown)', overall: s?.overall || 'unknown',
      verdict: s?.verdict, haltReason: s?.haltReason, startedAt: s?.startedAt,
      live: s?.overall === 'running' || s?.overall === 'awaiting_chat' || s?.overall === 'awaiting_plan_approval',
    };
  });

  const seenIds = new Set(runs.map((r) => r.id));

  // Durable runs from control/runs.jsonl
  if (project.paths.runsLedger && fs.existsSync(project.paths.runsLedger)) {
    try {
      const lines = fs.readFileSync(project.paths.runsLedger, 'utf8').trim().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const entry = JSON.parse(line);
          if (!entry.runId || seenIds.has(entry.runId)) continue;
          seenIds.add(entry.runId);
          runs.push({
            id: entry.runId,
            featureId: entry.featureId ?? null,
            ticketId: entry.ticketId ?? null,
            hostClient: entry.hostClient ?? null,
            runner: entry.runner ?? null,
            invocationMode: entry.invocationMode ?? null,
            runnerRequested: entry.runnerRequested ?? null,
            stage: 'reporter',
            reportRel: entry.reportRel || (entry.featureId && fs.existsSync(path.join(project.paths.control, 'reports', entry.featureId, 'work-done.html'))
              ? `.pipeline/control/reports/${entry.featureId}/work-done.html`
              : null),
            kind: 'pool',
            task: entry.task || `${entry.kind || 'run'} ${entry.featureId || ''}${entry.ticketId ? `/${entry.ticketId}` : ''}`,
            overall: entry.overall || 'done',
            verdict: 'APPROVED',
            haltReason: entry.haltReason ?? null,
            startedAt: entry.spawnedAt || entry.recordedAt || null,
            live: false,
          });
        } catch {}
      }
    } catch {}
  }

  // Synthesize from roadmap.json if not already present
  try {
    const rm = JSON.parse(fs.readFileSync(project.paths.roadmapJson, 'utf8'));
    for (const feature of rm?.features || []) {
      const featureItems = [
        feature.specRunId ? { runId: feature.specRunId, kind: 'plan' } : null,
        ...(feature.tickets || []).map((t) => t.runId ? { runId: t.runId, ticketId: t.id, title: t.title, status: t.status, kind: 'ticket' } : null),
        feature.integrationRunId ? { runId: feature.integrationRunId, kind: 'integration' } : null,
      ].filter(Boolean);

      for (const item of featureItems) {
        if (!item.runId || seenIds.has(item.runId)) continue;
        seenIds.add(item.runId);
        const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(item.runId);
        const startedAt = m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : (feature.landedAt || null);
        const isDone = ['landed', 'accepted'].includes(feature.status) || item.status === 'completed';
        const reportRel = feature.reportRel || (fs.existsSync(path.join(project.paths.control, 'reports', feature.id, 'work-done.html'))
          ? `.pipeline/control/reports/${feature.id}/work-done.html`
          : null);
        runs.push({
          id: item.runId,
          featureId: feature.id,
          ticketId: item.ticketId ?? null,
          hostClient: null,
          runner: feature.runner ?? 'host',
          invocationMode: null,
          runnerRequested: null,
          stage: 'reporter',
          reportRel,
          kind: 'pool',
          task: item.title || feature.title,
          overall: isDone ? 'done' : 'unknown',
          verdict: isDone ? 'APPROVED' : null,
          haltReason: null,
          startedAt,
          live: false,
        });
      }
    }
  } catch {}
  // A plain single-run project (no pool) keeps its live run at the project
  // root, not under paths.runs — without this it has state to read
  // (readState already serves it) but nothing in the sidebar ever opens it.
  // id '' is deliberate: /api/state with a falsy run param serves the root dir.
  let primary = null;
  try { primary = JSON.parse(fs.readFileSync(path.join(project.paths.dir, 'status.json'), 'utf8')); } catch {}
  if (primary && !primary.pool) {
    runs.unshift({
      id: '', kind: 'single', task: primary.task || '(unknown)', overall: primary.overall,
      hostClient: primary.hostClient ?? null, runner: primary.runner ?? null, invocationMode: primary.invocationMode ?? null, runnerRequested: primary.runnerRequested ?? null,
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
  const outPath = options.outPath || path.join(project.paths.dir, 'orchestrator.out');
  const flags = options.append ? 'a' : 'w';
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
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
  if (orchestratorAlive(project) || parkedPoolWork(project)) return { error: 'a pipeline run is already active', code: 409 };
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
    // A dashboard-spawned run must never infer chat-vs-cli from inherited
    // environment variables — this is a long-lived, detached process that can
    // still carry stale IDE env vars from whatever shell originally launched
    // it (the documented root cause of a dashboard-started run silently
    // landing in the wrong mode). The operator's own runner choice is the
    // only signal that matters here.
    nodeArgs.push('--mode', runner === 'host' ? 'chat' : 'cli');
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

function targetRun(project, run) {
  if (run && !runDir(project, run)) return { error: 'unknown run', code: 404 };
  const runPaths = runPathsFor(project, run || null);
  const status = loadRunStatus(runPaths.dir);
  if (!status) return { error: 'no run recorded at this path', code: 409 };
  return { runPaths, status, run: run || null };
}

function spawnForRun(project, runPaths, nodeArgs) {
  const args = runPaths.runId ? [...nodeArgs, '--run-id', runPaths.runId] : nodeArgs;
  return spawnOrchestrator(project, args, {
    append: true,
    outPath: path.join(runPaths.dir, 'orchestrator.out'),
  });
}

function extendRun(project, { extend, runner, run = null } = {}) {
  const guarded = selfGuardError(project);
  if (guarded) return guarded;
  const n = positiveInt(extend);
  if (!n) return { error: 'extend must be a positive integer', code: 400 };
  const target = targetRun(project, run);
  if (target.error) return target;
  if (runProcessAlive(target.runPaths)) return { error: 'a pipeline run is already active', code: 409 };
  if (target.status.overall !== 'halted' || target.status.haltReason !== 'MAX_CYCLES') {
    return { error: `cannot extend: last halt reason was "${target.status.haltReason || target.status.overall}", not MAX_CYCLES`, code: 409 };
  }
  const nodeArgs = [orchestratorEntry(project), '--resume', '--extend', String(n)];
  if (runner && runner !== 'auto') {
    nodeArgs.push('--runner', runner);
    // A dashboard-spawned run must never infer chat-vs-cli from inherited
    // environment variables — this is a long-lived, detached process that can
    // still carry stale IDE env vars from whatever shell originally launched
    // it (the documented root cause of a dashboard-started run silently
    // landing in the wrong mode). The operator's own runner choice is the
    // only signal that matters here.
    nodeArgs.push('--mode', runner === 'host' ? 'chat' : 'cli');
  }
  const child = spawnForRun(project, target.runPaths, nodeArgs);
  return { ok: true, pid: child.pid, extend: n };
}

function resumeInterruptedRunUi(project, { runner, run = null } = {}) {
  const guarded = selfGuardError(project);
  if (guarded) return guarded;
  const target = targetRun(project, run);
  if (target.error) return target;
  if (runProcessAlive(target.runPaths)) return { error: 'a pipeline run is already active', code: 409 };
  const stale = target.status.overall === 'running' && !runProcessAlive(target.runPaths);
  const isInterrupted = target.status.overall === 'halted' && target.status.haltReason === 'INTERRUPTED';
  if (!isInterrupted && !stale) {
    return { error: `cannot resume: run is not interrupted or stale (overall=${target.status.overall}, haltReason=${target.status.haltReason})`, code: 409 };
  }
  const nodeArgs = [orchestratorEntry(project), '--resume'];
  if (runner && runner !== 'auto') {
    nodeArgs.push('--runner', runner);
    // A dashboard-spawned run must never infer chat-vs-cli from inherited
    // environment variables — this is a long-lived, detached process that can
    // still carry stale IDE env vars from whatever shell originally launched
    // it (the documented root cause of a dashboard-started run silently
    // landing in the wrong mode). The operator's own runner choice is the
    // only signal that matters here.
    nodeArgs.push('--mode', runner === 'host' ? 'chat' : 'cli');
  }
  const child = spawnForRun(project, target.runPaths, nodeArgs);
  return { ok: true, pid: child.pid };
}

// Advance a run parked at a chat handoff or the plan-approval gate. Without
// this the dashboard could only print the shell command for the user to go and
// type somewhere else — it could observe the pipeline but never move it.
function continueRun(project, { approve = false, run = null } = {}) {
  const guarded = selfGuardError(project);
  if (guarded) return guarded;
  const target = targetRun(project, run);
  if (target.error) return target;
  if (runProcessAlive(target.runPaths)) return { error: 'a pipeline run is already active', code: 409 };
  const status = target.status;

  if (status.overall === 'awaiting_plan_approval') {
    if (!approve) return { error: 'plan approval requires an explicit approve', code: 400 };
  } else if (status.overall === 'awaiting_chat') {
    const stage = status.awaitingStage;
    const artifact = STAGE_ARTIFACT_FILES[stage];
    const check = artifact ? validateArtifactFile(stage, path.join(target.runPaths.dir, artifact)) : { ok: true };
    if (!check.ok) {
      return { error: `the ${stage} stage has not been completed yet — ${artifact}: ${check.reason}`, code: 409 };
    }
  } else {
    return { error: `cannot continue: run is "${status.overall}", not awaiting a handoff or approval`, code: 409 };
  }

  const child = spawnForRun(project, target.runPaths, [orchestratorEntry(project), '--continue']);
  return { ok: true, pid: child.pid, continued: status.overall };
}

function cancelRun(project, { run = null } = {}) {
  const runPaths = runPathsFor(project, run || null);
  const lock = readLock(runPaths);
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
  let rel = url.searchParams.get('file') || 'work-done.html';
  const runId = url.searchParams.get('run');
  const featureId = url.searchParams.get('feature');

  if (rel.includes('/')) {
    const parts = rel.split('/');
    if (parts.includes('reports')) {
      rel = parts.slice(parts.lastIndexOf('reports') + 1).join('/') || 'work-done.html';
    } else {
      rel = parts[parts.length - 1] || 'work-done.html';
    }
  }

  // A traversal here would serve any file the server can read, so the path is
  // both pattern-checked and resolved against its root before anything is read.
  if (!/^[\w.\-/]+$/.test(rel) || rel.split('/').includes('..')) {
    return json(res, { error: 'invalid file' }, 400);
  }

  const candidateRoots = [];
  if (runId && /^[\w.-]+$/.test(runId)) {
    candidateRoots.push(path.join(project.paths.runs, runId, 'reports'));
  }
  if (featureId && /^[\w.-]+$/.test(featureId)) {
    candidateRoots.push(path.join(project.paths.control, 'reports', featureId));
  }

  // Cross-lookup in roadmap.json if needed
  try {
    const rm = JSON.parse(fs.readFileSync(project.paths.roadmapJson, 'utf8'));
    if (runId && !featureId) {
      const match = (rm?.features || []).find((f) =>
        f.specRunId === runId || f.integrationRunId === runId || (f.tickets || []).some((t) => t.runId === runId)
      );
      if (match) candidateRoots.push(path.join(project.paths.control, 'reports', match.id));
    } else if (featureId && !runId) {
      const match = (rm?.features || []).find((f) => f.id === featureId);
      if (match) {
        if (match.integrationRunId) candidateRoots.push(path.join(project.paths.runs, match.integrationRunId, 'reports'));
        for (const t of (match.tickets || []).slice().reverse()) {
          if (t.runId) candidateRoots.push(path.join(project.paths.runs, t.runId, 'reports'));
        }
      }
    }
  } catch {}

  if (!candidateRoots.length) return json(res, { error: 'expected run or feature' }, 400);

  let resolved = null;
  for (const root of candidateRoots) {
    try {
      if (!fs.existsSync(root)) continue;
      const cand = fs.realpathSync(path.resolve(root, rel));
      const rootReal = fs.realpathSync(root);
      if (cand === rootReal || cand.startsWith(rootReal + path.sep)) {
        resolved = cand;
        break;
      }
    } catch {}
  }

  if (!resolved) {
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
    return null;
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
  if (url.pathname === '/api/bridge' && req.method === 'GET') {
    const project = getProjectForRequest(req,url);
    if (!project) return json(res,{error:'invalid project'},400);
    try { return json(res,bridgeCommand('bridge.inspect',{project:project.repoRoot})); }
    catch (err) { return json(res,{error:err.message},409); }
  }
  if (url.pathname === '/api/messages' && req.method === 'POST') {
    const project = getProjectForRequest(req,url);
    if (!project) return json(res,{error:'invalid project'},400);
    return readBody(req, body => {
      try { if (!body || !Object.hasOwn(body,'runId')) throw new Error('runId required');
        return json(res,bridgeCommand('message.queue',{...body,project:project.repoRoot}));
      } catch (err) { return json(res,{error:err.message},409); }
    });
  }
  if (url.pathname === '/api/pool/action' && req.method === 'POST') {
    const project = getProjectForRequest(req,url);
    if (!project) return json(res,{error:'invalid project'},400);
    return readBody(req, body => {
      try {
        const actions = {retry:pool.retryFeature,hold:pool.holdFeature,release:pool.releaseFeature,skip:pool.skipFeature};
        if (!actions[body?.action]) throw new Error('Unknown action');
        return json(res,actions[body.action](project.paths,body.featureId,body.reason || 'Dashboard action'));
      } catch (err) { return json(res,{error:err.message},409); }
    });
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
      if (body.run && !runDir(project, body.run)) return json(res, { error: 'unknown run' }, 404);
      const runPaths = runPathsFor(project, body.run || null);
      const status = loadRunStatus(runPaths.dir);
      if (!status) return json(res, { error: 'no run recorded at this path' }, 409);
      if (isArchivedStatus(status)) return json(res, { error: 'cannot note an archived run' }, 409);
      const active = activeStageName(status);
      if (active && body.stage !== active) {
        return json(res, { error: `stage "${body.stage}" is not active on this run (active: ${active})` }, 409);
      }
      try {
        json(res, status.bridgeRequired ? bridgeCommand('message.queue',{project:project.repoRoot,runId:body.run || null,stage:body.stage,text:body.text.trim(),priority:body.priority || 'priority',handoffId:body.handoffId,commandId:body.commandId}) : queueStageNote(runPaths, body.stage, body.text.trim()));
      } catch (err) {
        json(res, { error: err.message }, 400);
      }
    });
  } else if (req.method === 'POST' && url.pathname === '/api/orchestrate') {
    const project = getProjectForRequest(req, url);
    if (!project) return json(res, { error: 'invalid project' }, 400);
    readBody(req, async (body) => {
      if (!body || typeof body.text !== 'string' || !body.text.trim()) {
        return json(res, { error: 'expected { text }' }, 400);
      }
      if (body.run && !runDir(project, body.run)) return json(res, { error: 'unknown run' }, 404);
      const runPaths = runPathsFor(project, body.run || null);
      let status = loadRunStatus(runPaths.dir);
      try {
        const result = await routeMessage({ text: body.text, status, config: project.config });
        queueStageNote(runPaths, result.stage, body.text.trim());
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
    readBody(req, (body) => {
      const result = cancelRun(project, body || {});
      json(res, result, result.code || 200);
    });
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
  } else if (req.method === 'POST' && (url.pathname === '/api/run/dismiss' || url.pathname === '/api/dismiss')) {
    const project = getProjectForRequest(req, url);
    if (!project) return json(res, { error: 'invalid project' }, 400);
    readBody(req, (body) => {
      try {
        const runId = body?.run || body?.runId || null;
        const reason = body?.reason || 'Dismissed from dashboard';
        const result = bridgeCommand('run.dismiss', { project: project.repoRoot, runId, reason });
        json(res, result);
      } catch (err) {
        json(res, { error: err.message }, 409);
      }
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
