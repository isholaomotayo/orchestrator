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
import { recoveryFor } from './recoverability.mjs';
import { policyOf, readPolicyOverride } from './mode.mjs';
import { DEFAULT_MODEL_PROFILES, DEFAULT_STAGE_EFFORT, EFFORT_LEVELS, MODEL_CATALOG } from './models.mjs';
import { routeMessage } from './router.mjs';
import { isTrustedRequest, isLoopbackHost } from './http-guard.mjs';
import { openDecisions } from './attention.mjs';
import os from 'node:os';
import crypto from 'node:crypto';
import {
  API_VERSION, CONTRACT, CAPABILITIES, projectIdOf, runSummary, summarySignature,
  createEventHub, createEventTail, createCommandExecutor,
} from './api-v1.mjs';
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

// ---- identity for /api/v1 clients (the desktop app, scripts) ---------------
// The token gates every /api/v1 route. It is published only in a per-user,
// owner-only registry file and embedded in the dashboard page this server
// serves to its own (Host-checked) origin.
const ORCH_HOME = process.env.ORCHESTRATOR_HOME || path.join(os.homedir(), '.orchestrator');
const INSTANCE_ID = crypto.randomUUID();
const API_TOKEN = crypto.randomBytes(24).toString('hex');
const STARTED_AT = new Date().toISOString();
const SERVER_RECORD = path.join(ORCH_HOME, 'servers', `${INSTANCE_ID}.json`);
const PROJECTS_FILE = path.join(ORCH_HOME, 'projects.json');
const hub = createEventHub({ instanceId: INSTANCE_ID });
const tailEvents = createEventTail();
const childrenByPid = new Map();

function readKnownProjects() {
  try { return JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8')).filter((p) => typeof p === 'string'); } catch { return []; }
}
function rememberProject(repoRoot) {
  try {
    const known = readKnownProjects();
    if (known.includes(repoRoot)) return;
    fs.mkdirSync(ORCH_HOME, { recursive: true, mode: 0o700 });
    fs.writeFileSync(PROJECTS_FILE, JSON.stringify([...known, repoRoot], null, 2), { mode: 0o600 });
  } catch { /* the registry is a convenience; serving continues without it */ }
}
function writeServerRecord() {
  try {
    fs.mkdirSync(path.dirname(SERVER_RECORD), { recursive: true, mode: 0o700 });
    fs.writeFileSync(SERVER_RECORD, JSON.stringify({
      instanceId: INSTANCE_ID, port: PORT, pid: process.pid, startedAt: STARTED_AT, token: API_TOKEN,
      apiVersions: [API_VERSION], serverVersion: HOST_ENGINE.version, url: `http://127.0.0.1:${PORT}`,
    }, null, 2), { mode: 0o600 });
  } catch (err) { console.warn(`[UI] Could not write server registry ${SERVER_RECORD}: ${err.message}`); }
}

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

const ARTIFACTS = ['specs.md', 'plan_review.md', 'design.md', 'changes.md', 'checker_report.md', 'test_suite.md', 'review_report.md', 'review_correctness.md', 'review_security.md', 'review_architecture.md', 'handoff.md', 'reporter.md', 'diff.patch', 'vague_request.txt', 'stage-handoff.json'];
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
    // Agent edits and installs inside worktrees are not pipeline state; they
    // used to trigger a dashboard refresh on every keystroke.
    if (file && /^(worktrees|\.pipeline_sandbox)[\\/]|node_modules/.test(String(file))) return;
    project.changedSet.add(file || '*');
    clearTimeout(project.debounceTimer);
    project.debounceTimer = setTimeout(() => {
      const msg = `data: ${JSON.stringify({ type: 'change', changed: [...project.changedSet] })}\n\n`;
      for (const res of project.sseClients) {
        try { res.write(msg); } catch { project.sseClients.delete(res); }
      }
      try { publishProjectChanges(project, [...project.changedSet]); } catch (err) { console.warn(`[UI] v1 publish failed: ${err.message}`); }
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

  project.projectId = projectIdOf(resolvedPath);
  project.lastSigs = new Map();
  projects.set(resolvedPath, project);
  rememberProject(resolvedPath);
  // Prime the event tails so the first change publishes only new events.
  for (const runId of listRunIds(project)) tailEvents(runPathsFor(project, runId).events);
  return project;
}

function listRunIds(project) {
  const ids = [];
  if (fs.existsSync(path.join(project.paths.dir, 'status.json'))) ids.push(null);
  try { for (const d of fs.readdirSync(project.paths.runs)) if (isValidRunId(d) && fs.existsSync(path.join(project.paths.runs, d, 'status.json'))) ids.push(d); } catch { /* no runs */ }
  return ids;
}

function projectById(projectId) {
  for (const project of projects.values()) if (project.projectId === projectId) return project;
  return null;
}

function computeSummary(project, runId) {
  const dir = runDir(project, runId);
  if (!dir) return null;
  const status = loadRunStatus(dir);
  if (!status) return null;
  const runPaths = runPathsFor(project, runId);
  const lock = readLock(runPaths);
  const engineAlive = !!(lock && pidAlive(lock.pid));
  let owner = null;
  try { owner = inspectBridge(project.repoRoot, runId).owner; } catch { /* unreadable journal: no owner */ }
  let lastEventAt = null;
  try { lastEventAt = fs.statSync(runPaths.events).mtime.toISOString(); } catch { /* no events yet */ }
  return runSummary({ runId: runId || 'root', status, dir, config: project.config, engineAlive, pid: engineAlive ? lock.pid : null, owner, lastEventAt });
}

// Turn file changes into typed v1 events: run.upserted when a run's summary
// changes, run.event for each new events.jsonl line, and control-plane updates.
function publishProjectChanges(project, files) {
  const projectId = project.projectId;
  const runIds = new Set();
  let control = false;
  for (const f of files) {
    const rel = String(f || '').replaceAll('\\', '/');
    const m = /^runs\/([^/]+)\//.exec(rel);
    if (m && isValidRunId(m[1])) runIds.add(m[1]);
    else if (/^control\//.test(rel)) control = true;
    else if (rel === '*') { for (const id of listRunIds(project)) runIds.add(id); control = true; }
    else runIds.add(null);
  }
  for (const runId of runIds) {
    const runPaths = runPathsFor(project, runId);
    for (const { seq, event } of tailEvents(runPaths.events)) hub.publish('run.event', { projectId, runId: runId || 'root', seq, event });
    const summary = computeSummary(project, runId);
    if (!summary) continue;
    const sig = summarySignature(summary);
    if (project.lastSigs.get(runId || 'root') === sig) continue;
    project.lastSigs.set(runId || 'root', sig);
    hub.publish('run.upserted', { projectId, run: summary });
  }
  if (control) {
    let attention = [];
    try { attention = pool.pendingAttention(project.paths); } catch { /* none */ }
    hub.publish('attention.updated', { projectId, items: attention });
    let snapshot = null;
    try { snapshot = JSON.parse(fs.readFileSync(project.paths.snapshot, 'utf8')); } catch { /* no pool */ }
    if (snapshot) hub.publish('pool.updated', { projectId, snapshot });
  }
}

// Register the default project at startup, then every project a previous
// session knew about, so their dashboard links keep working after a restart.
getOrCreateProject(defaultRepoRoot);
for (const known of readKnownProjects()) {
  if (known !== defaultRepoRoot && fs.existsSync(path.join(known, '.pipeline'))) getOrCreateProject(known);
}

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
  // Same table the engine's --resume guard and the supervisor read, so a
  // button is only offered when the engine will actually accept it.
  const recovery = status ? recoveryFor(status, { engineAlive: alive }) : null;
  const canExtend = !alive && !!recovery?.extend;
  const canResume = !alive && !!recovery?.resume;
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
    policy: status ? policyOf(status, project.config, readPolicyOverride(dir)) : null,
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
      verdict: s?.verdict, haltReason: s?.haltReason, reportError: s?.reportError ?? null, startedAt: s?.startedAt,
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
            stage: entry.stage ?? null,
            reportRel: entry.reportRel || (entry.featureId && fs.existsSync(path.join(project.paths.control, 'reports', entry.featureId, 'work-done.html'))
              ? `.pipeline/control/reports/${entry.featureId}/work-done.html`
              : null),
            kind: 'pool',
            task: entry.task || `${entry.kind || 'run'} ${entry.featureId || ''}${entry.ticketId ? `/${entry.ticketId}` : ''}`,
            overall: entry.overall || 'unknown',
            verdict: entry.verdict ?? null,
            haltReason: entry.haltReason ?? null,
            reportError: entry.reportError ?? null,
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
          reportError: feature.reportError ?? null,
          kind: 'pool',
          task: item.title || feature.title,
          overall: isDone ? 'done' : 'unknown',
          verdict: null,
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
      verdict: primary.verdict, haltReason: primary.haltReason, reportError: primary.reportError ?? null, startedAt: primary.startedAt,
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
    env: { ...engineEnv(), PIPELINE_UI_PORT: String(PORT) },
  });
  
  child.unref();
  fs.closeSync(outFd);
  if (child.pid) {
    childrenByPid.set(child.pid, { child, outPath, exited: null });
    child.on('exit', (code) => { const rec = childrenByPid.get(child.pid); if (rec) rec.exited = code; setTimeout(() => childrenByPid.delete(child.pid), 60_000); });
  }
  return child;
}

// A command that spawns the engine is "applied" only once the engine has made
// its first move. A quick non-zero exit (refused resume, rejected continue)
// is reported back with its output instead of a success toast.
async function settleSpawn(result, { waitMs = 4000 } = {}) {
  if (!result?.pid) return result;
  const rec = childrenByPid.get(result.pid);
  if (!rec) return result;
  const deadline = Date.now() + waitMs;
  while (rec.exited === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  if (rec.exited === null || rec.exited === 0) return { ...result, engine: rec.exited === 0 ? 'exited' : 'running' };
  let tail = '';
  try { tail = fs.readFileSync(rec.outPath, 'utf8').trim().split('\n').slice(-15).join('\n'); } catch { /* no output */ }
  const reason = tail.split('\n').reverse().find((l) => /Cannot|Not continuing|Nothing to|Refusing|error|HALT/i.test(l)) || `the engine exited with code ${rec.exited}`;
  return { error: reason.replace(/^\[Orchestrator\]\s*/, ''), code: 409, outputTail: tail };
}

function startRun(project, { task, runner, sandbox, maxCycles, maxPostTesterCycles, maxReviewCycles, modelProfile, models, design, approvePlan, autonomy }) {
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
  // A dashboard-spawned run never infers chat-vs-cli from inherited
  // environment variables — this long-lived, detached server can carry stale
  // IDE env vars from whatever shell launched it (the documented root cause
  // of dashboard runs silently landing in the wrong mode). The dashboard is
  // not a chat session: a host run is an explicit "host" choice, and anything
  // else runs on the CLI surface.
  if (runner && runner !== 'auto') nodeArgs.push('--runner', runner);
  nodeArgs.push('--mode', runner === 'host' ? 'chat' : 'cli');
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
  if (approvePlan) nodeArgs.push('--approve-plan');
  if (autonomy === 'guided' || autonomy === 'autonomous') nodeArgs.push('--autonomy', autonomy);
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

// Chat-session markers the server may have inherited. Every engine it spawns
// gets an explicit --mode or keeps its recorded surface, so these can only
// mislead it (and the agent CLIs it starts).
const CHAT_ENV_KEYS = ['CLAUDECODE', 'CLAUDE_CODE', 'CURSOR_AGENT', 'CURSOR_TRACE_ID', 'CODEX_IN_IDE', 'GEMINI_CLI_IDE', 'PIPELINE_INVOCATION'];
function engineEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !CHAT_ENV_KEYS.includes(k) && !k.startsWith('ANTIGRAVITY')));
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
  const recovery = recoveryFor(target.status, { engineAlive: false });
  if (!recovery.resume) return { error: `cannot resume: ${recovery.reason}`, code: 409 };
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
function continueRun(project, { approve = false, run = null, handoffId = null } = {}) {
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

  // Name the handoff this click completes, so a stale button (or a race with
  // the host's own --continue) cannot advance a newer handoff.
  const id = handoffId || status.handoffId || null;
  if (handoffId && status.handoffId && handoffId !== status.handoffId) {
    return { error: `this Continue was for an earlier handoff; the run is now awaiting ${status.awaitingStage}. Refresh and check that stage.`, code: 409 };
  }
  const child = spawnForRun(project, target.runPaths, [orchestratorEntry(project), '--continue', ...(id ? ['--handoff-id', id] : [])]);
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

  if (rel.startsWith('.pipeline/') || rel.includes('/')) {
    const parts = rel.split('/');
    const repIdx = parts.indexOf('reports');
    if (repIdx !== -1) {
      let tail = parts.slice(repIdx + 1);
      if (featureId && tail[0] === featureId) tail = tail.slice(1);
      rel = tail.join('/') || 'work-done.html';
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

// ---- /api/v1 ----------------------------------------------------------------

function v1Authorized(req, url) {
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
  // EventSource cannot set headers, so the dashboard passes ?access_token=.
  const given = bearer || url.searchParams.get('access_token') || '';
  const a = Buffer.from(given), b = Buffer.from(API_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function projectInfo(project) {
  const engine = engineInfo(project);
  let attention = [];
  try { attention = pool.pendingAttention(project.paths); } catch { /* none */ }
  return {
    projectId: project.projectId, repoRoot: project.repoRoot, name: path.basename(project.repoRoot),
    install: engine, capabilities: CAPABILITIES,
    attention: { needsYou: attention.filter((a) => a.escalate).length, total: attention.length },
    defaults: { autonomy: project.config.autonomy || 'guided' },
  };
}

function v1Commands(project) {
  if (!project.executeCommand) {
    const via = (b) => b.client?.kind || 'api';
    const run = (b) => (b.runId && b.runId !== 'root' ? b.runId : null);
    const a = (b) => b.args || {};
    project.executeCommand = createCommandExecutor({ handlers: {
      'run.start': (b) => settleSpawn(startRun(project, a(b))),
      'run.continue': (b) => settleSpawn(continueRun(project, { run: run(b), handoffId: a(b).handoffId || null })),
      'plan.approve': (b) => settleSpawn(continueRun(project, { approve: true, run: run(b) })),
      'plan.reject': (b) => {
        if (!a(b).note?.trim()) return { error: 'a note describing the changes is required', code: 400 };
        queueStageNote(runPathsFor(project, run(b)), 'planner', a(b).note.trim());
        return settleSpawn(continueRun(project, { approve: true, run: run(b) }));
      },
      'run.resume': (b) => settleSpawn(resumeInterruptedRunUi(project, { run: run(b) })),
      'run.extend': (b) => settleSpawn(extendRun(project, { extend: a(b).extend, run: run(b) })),
      'run.cancel': (b) => cancelRun(project, { run: run(b) }),
      'run.dismiss': (b) => pool.dismissRun(project.paths, run(b), a(b).reason || 'Dismissed', { via: via(b) }),
      'run.set_autonomy': (b) => pool.setRunAutonomy(project.paths, run(b), a(b).autonomy, { via: via(b) }),
      'message.queue': (b) => {
        if (!a(b).stage || !a(b).text?.trim()) return { error: 'stage and text are required', code: 400 };
        return queueStageNote(runPathsFor(project, run(b)), a(b).stage, a(b).text.trim());
      },
      'decision.answer': (b) => pool.decide(project.paths, a(b).decisionId, a(b).answer, { via: via(b) }),
      'ticket.retry': (b) => pool.retryTicket(project.paths, a(b).featureId, a(b).ticketId),
      'run.resume_in_pool': (b) => { const r = pool.requestRunResume(project.paths, run(b)); return r.ok ? r : { error: r.reason, code: 409 }; },
      'merge.approve': (b) => pool.approveMerge(project.paths, a(b).featureId || null, { via: via(b), note: a(b).note ?? null }),
      'merge.request_changes': (b) => pool.requestChanges(project.paths, a(b).featureId, a(b).text, { via: via(b) }),
      'feature.hold': (b) => pool.holdFeature(project.paths, a(b).featureId, a(b).reason),
      'feature.release': (b) => pool.releaseFeature(project.paths, a(b).featureId),
      'feature.skip': (b) => pool.skipFeature(project.paths, a(b).featureId, a(b).reason),
      'pool.pause': (b) => pool.pause(project.paths, a(b).reason || ''),
      'pool.resume': () => pool.resume(project.paths),
      'attention.ack': (b) => { pool.ackAttention(project.paths, a(b).id); return { acked: a(b).id }; },
    } });
  }
  return project.executeCommand;
}

function readEventsAfter(file, afterSeq, limit) {
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { events: [], nextSeq: afterSeq, hasMore: false }; }
  // Same numbering as the live tail: one seq per newline-terminated line, so a
  // client can backfill and then continue from the stream without gaps.
  const lines = raw.split('\n').slice(0, -1);
  const events = [];
  for (let i = 0; i < lines.length; i++) {
    const seq = i + 1;
    const line = lines[i];
    if (!line.trim() || seq <= afterSeq) continue;
    if (events.length >= limit) return { events, nextSeq: events.at(-1).seq, hasMore: true };
    try { events.push({ seq, ...JSON.parse(line) }); } catch { /* torn line */ }
  }
  return { events, nextSeq: events.length ? events.at(-1).seq : afterSeq, hasMore: false };
}

function handleV1(req, res, url) {
  if (!v1Authorized(req, url)) return json(res, { error: 'unauthorized: pass the server token as "Authorization: Bearer <token>"' }, 401);
  const parts = url.pathname.split('/').filter(Boolean).slice(2); // after api/v1
  if (req.method === 'GET' && parts[0] === 'projects' && parts.length === 1) {
    return json(res, { projects: [...projects.values()].map(projectInfo) });
  }
  if (req.method === 'POST' && parts[0] === 'projects' && parts.length === 1) {
    return readBody(req, (body) => {
      const project = body?.repoRoot && fs.existsSync(path.join(body.repoRoot, '.pipeline')) ? getOrCreateProject(body.repoRoot) : null;
      return project ? json(res, projectInfo(project)) : json(res, { error: 'not a pipeline project (no .pipeline/ directory)' }, 400);
    });
  }
  if (req.method === 'GET' && parts[0] === 'events') {
    const wanted = url.searchParams.get('projects');
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    const detach = hub.attach(res, {
      lastEventId: req.headers['last-event-id'] || url.searchParams.get('lastEventId') || null,
      projects: wanted ? wanted.split(',').filter(Boolean) : null,
    });
    req.on('close', detach);
    return undefined;
  }
  if (parts[0] !== 'projects' || !parts[1]) return json(res, { error: 'not found' }, 404);
  const project = projectById(parts[1]);
  if (!project) return json(res, { error: 'unknown project' }, 404);
  if (req.method === 'GET' && parts[2] === 'snapshot') {
    let attention = [], decisions = [], snapshot = null;
    try { attention = pool.pendingAttention(project.paths); } catch { /* none */ }
    try { decisions = openDecisions(project.paths); } catch { /* none */ }
    try { snapshot = JSON.parse(fs.readFileSync(project.paths.snapshot, 'utf8')); } catch { /* no pool */ }
    return json(res, {
      cursor: hub.cursor, generatedAt: new Date().toISOString(), project: projectInfo(project),
      runs: listRunIds(project).map((id) => computeSummary(project, id)).filter(Boolean),
      attention, decisions, pool: snapshot,
    });
  }
  if (req.method === 'GET' && parts[2] === 'runs' && parts[3]) {
    const runId = parts[3] === 'root' ? null : parts[3];
    if (runId && !isValidRunId(runId)) return json(res, { error: 'invalid run id' }, 400);
    if (parts[4] === 'events') {
      const afterSeq = Math.max(0, Number(url.searchParams.get('afterSeq')) || 0);
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
      return json(res, readEventsAfter(runPathsFor(project, runId).events, afterSeq, limit));
    }
    const summary = computeSummary(project, runId);
    if (!summary) return json(res, { error: 'unknown run' }, 404);
    const dir = runDir(project, runId);
    const artifacts = ARTIFACTS.flatMap((name) => {
      try { const st = fs.statSync(path.join(dir, name)); return st.size ? [{ name, size: st.size, updatedAt: st.mtime.toISOString() }] : []; } catch { return []; }
    });
    return json(res, { run: summary, status: loadRunStatus(dir), artifacts });
  }
  if (req.method === 'POST' && parts[2] === 'commands') {
    return readBody(req, async (body) => {
      let result;
      try { result = await v1Commands(project)(body || {}); }
      catch (err) { return json(res, { status: 'rejected', error: { code: 'failed', message: err.message, retryable: false } }, 500); }
      // A command that changed state shows up on the stream right away.
      if (result.status === 'applied') publishProjectChanges(project, body?.runId && body.runId !== 'root' ? [`runs/${body.runId}/status.json`, 'control/'] : ['status.json', 'control/']);
      json(res, { ...result, cursor: hub.cursor }, result.status === 'rejected' && result.error?.code === 'bad_request' ? 400 : 200);
    });
  }
  return json(res, { error: 'not found' }, 404);
}

function getProjectForRequest(req, url) {
  const projectPath = url.searchParams.get('project');
  if (projectPath) {
    // Only projects registered with this server (POST /api/register, which
    // orchestrate.sh calls, or a previous session's registry). An arbitrary
    // path used to create .pipeline/ and a recursive watcher anywhere on disk.
    let resolved;
    try { resolved = path.resolve(projectPath); } catch { return null; }
    if (projects.has(resolved)) return projects.get(resolved);
    if (readKnownProjects().includes(resolved)) return getOrCreateProject(resolved);
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
  if (!isLoopbackHost(req.headers, PORT)) return json(res, { error: 'forbidden: unexpected Host header' }, 421);
  if (req.method === 'POST' && isGuardedPost(url.pathname) && !isTrustedRequest(req.headers, PORT)) {
    return json(res, { error: 'forbidden: untrusted origin' }, 403);
  }
  if (url.pathname.startsWith('/api/v1/')) return handleV1(req, res, url);
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
        if (body?.action === 'retry-ticket') return json(res, pool.retryTicket(project.paths, body.featureId, body.ticketId));
        if (body?.action === 'resume-run') {
          const result = pool.requestRunResume(project.paths, body.runId);
          return result.ok ? json(res, result) : json(res, { error: result.reason }, 409);
        }
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
        // Use the bridge only when a host session actually holds the run's
        // lease. An unclaimed run is driven through the documented
        // followups/<stage>.txt path; queueing a priority bridge message there
        // enrolled the run in ownership, after which every plain --continue
        // (and the dashboard's own Continue) failed for lack of credentials.
        const leased = status.bridgeRequired && !!inspectBridge(project.repoRoot, body.run || null).owner;
        json(res, leased ? bridgeCommand('message.queue',{project:project.repoRoot,runId:body.run || null,stage:body.stage,text:body.text.trim(),priority:body.priority || 'priority',handoffId:body.handoffId,commandId:body.commandId}) : queueStageNote(runPaths, body.stage, body.text.trim()));
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
      settleSpawn(startRun(project, body)).then((result) => json(res, result, result.code || 200));
    });
  } else if (req.method === 'POST' && url.pathname === '/api/continue') {
    const project = getProjectForRequest(req, url);
    if (!project) return json(res, { error: 'invalid project' }, 400);
    readBody(req, (body) => {
      settleSpawn(continueRun(project, body || {})).then((result) => json(res, result, result.code || 200));
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
      settleSpawn(extendRun(project, body)).then((result) => json(res, result, result.code || 200));
    });
  } else if (req.method === 'POST' && url.pathname === '/api/resume') {
    const project = getProjectForRequest(req, url);
    if (!project) return json(res, { error: 'invalid project' }, 400);
    readBody(req, (body) => {
      settleSpawn(resumeInterruptedRunUi(project, body || {})).then((result) => json(res, result, result.code || 200));
    });
  } else if (req.method === 'POST' && url.pathname === '/api/run/autonomy') {
    const project = getProjectForRequest(req, url);
    if (!project) return json(res, { error: 'invalid project' }, 400);
    readBody(req, (body) => {
      try {
        json(res, pool.setRunAutonomy(project.paths, body?.run || null, body?.autonomy, { via: 'dashboard' }));
      } catch (err) {
        json(res, { error: err.message }, 400);
      }
    });
  } else if (req.method === 'POST' && (url.pathname === '/api/run/dismiss' || url.pathname === '/api/dismiss')) {
    const project = getProjectForRequest(req, url);
    if (!project) return json(res, { error: 'invalid project' }, 400);
    readBody(req, (body) => {
      try {
        const runId = body?.run || body?.runId || null;
        const reason = body?.reason || 'Dismissed from dashboard';
        json(res, pool.dismissRun(project.paths, runId, reason, { via: 'dashboard' }));
      } catch (err) {
        json(res, { error: err.message }, 409);
      }
    });
  } else if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8')
      .replace('<head>', `<head><meta name="pipeline-api-token" content="${API_TOKEN}"><meta name="pipeline-instance" content="${INSTANCE_ID}">`));
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
        const decision = pool.readDecisions(project.paths).find((row) => row.decisionId === body.decisionId);
        if (decision?.kind === 'merge-approval' || decision?.kind === 'roadmap-merge') {
          const guard = selfGuardError(project);
          if (guard) return json(res, { error: guard.error }, guard.code);
        }
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
    json(res, {
      ok: true, service: 'pipeline-ui', repoRoot: defaultRepoRoot,
      instanceId: INSTANCE_ID, pid: process.pid, port: PORT, startedAt: STARTED_AT,
      serverVersion: HOST_ENGINE.version, apiVersions: [API_VERSION], contract: CONTRACT, capabilities: CAPABILITIES,
    });
  } else {
    res.writeHead(404); res.end('not found');
  }
});

function anySseClientsConnected() {
  if (hub.size > 0) return true;
  for (const project of projects.values()) if (project.sseClients.size > 0) return true;
  return false;
}
function anyRunActive() {
  // A chat run parked between stages holds no lock but is very much active:
  // shutting down then took the dashboard away mid-run.
  for (const project of projects.values()) {
    if (orchestratorAlive(project) || parkedPoolWork(project)) return true;
    const root = loadRunStatus(project.paths.dir);
    if (root && ['awaiting_chat', 'awaiting_plan_approval', 'running'].includes(root.overall)) return true;
  }
  return false;
}
setInterval(() => hub.heartbeat(), 15000).unref?.();

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
  try { fs.unlinkSync(SERVER_RECORD); } catch { /* already gone */ }
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
  writeServerRecord();
  console.log(`[UI] Pipeline dashboard running at http://${HOST}:${PORT} (repo: ${defaultRepoRoot})`);
});
