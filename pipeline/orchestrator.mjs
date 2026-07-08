#!/usr/bin/env node
// Unified pipeline orchestrator:
//   Planner -> Coder (self-healing builder-checker loop) -> Tester -> Reviewer
// Guardrails: mutex lock, configurable max fix cycles, regression halt,
// artifact validation, optional git-worktree sandbox. When a fix loop
// exhausts its cycle budget it halts as MAX_CYCLES rather than looping
// forever — from there `--resume --extend <n>` (or the dashboard's "Extend"
// button) continues the SAME loop for N more cycles, repeatably, without
// re-running Planner or discarding prior progress. State is mirrored to
// .pipeline/status.json and .pipeline/events.jsonl for the live dashboard.
import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { pipelinePaths, loadConfig, newStatus, writeStatus, appendEvent, pidAlive, readLock, tailFile } from './state.mjs';
import { runChecks } from './checker.mjs';
import { runAgent, detectRunner } from './adapters.mjs';
import { detectInvocationMode } from './invocation.mjs';
import { resolveModelProfile, parseModelsJson, modelForStage } from './models.mjs';

function parseArgs(argv) {
  const args = {
    task: null, runner: null, sandbox: false, resume: false, continue: false, extend: null,
    maxCycles: null, maxPostTesterCycles: null, mode: null,
    modelProfile: 'auto', models: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--task') args.task = argv[++i];
    else if (a === '--runner') args.runner = argv[++i];
    else if (a === '--sandbox') args.sandbox = true;
    else if (a === '--resume') args.resume = true;
    else if (a === '--continue') args.continue = true;
    else if (a === '--extend') args.extend = parseInt(argv[++i], 10);
    else if (a === '--max-cycles') args.maxCycles = parseInt(argv[++i], 10);
    else if (a === '--max-post-tester-cycles') args.maxPostTesterCycles = parseInt(argv[++i], 10);
    else if (a === '--mode') args.mode = argv[++i];
    else if (a === '--model-profile') args.modelProfile = argv[++i];
    else if (a === '--models') args.models = argv[++i];
    else if (!args.task && !a.startsWith('--')) args.task = a;
  }
  return args;
}

const USAGE = 'Usage: node pipeline/orchestrator.mjs --task "description" [--runner claude|cursor|codex|gemini|host] [--mode chat|cli] [--model-profile auto|manual] [--models \'{"planner":"...","coder":"..."}\'] [--sandbox] [--max-cycles n] [--max-post-tester-cycles n]\n   or: node pipeline/orchestrator.mjs --continue\n   or: node pipeline/orchestrator.mjs --resume [--extend <n>] [--runner ...]';

const repoRoot = process.cwd();
const paths = pipelinePaths(repoRoot);
const config = loadConfig(paths);
const args = parseArgs(process.argv.slice(2));
const uiPort = process.env.PIPELINE_UI_PORT || config.uiPort;

if (args.resume) {
  if (args.extend !== null && (!Number.isInteger(args.extend) || args.extend < 1)) { console.error(USAGE); process.exit(2); }
} else if (args.continue) {
  // no task required
} else if (!args.task) {
  console.error(USAGE); process.exit(2);
}
if (args.runner) config.runner = args.runner;

const invocation = detectInvocationMode({ env: process.env, argv: process.argv });
const invocationMode = args.mode === 'chat' || args.mode === 'cli' ? args.mode : invocation.mode;

// ---- Guardrail 3: mutex lock -----------------------------------------------
if (fs.existsSync(paths.lock)) {
  const lock = readLock(paths);
  if (lock && pidAlive(lock.pid)) {
    console.error(`[Orchestrator] Pipeline execution is locked by a running orchestrator (pid ${lock.pid}).`);
    process.exit(1);
  }
  console.error('[Orchestrator] Clearing stale lock (owning process is gone).');
  try { fs.unlinkSync(paths.lock); } catch {}
}
fs.mkdirSync(paths.dir, { recursive: true });
fs.writeFileSync(paths.lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));

let status, history, workCwd, runner, models;

function resolveModelsForRun(runnerName) {
  if (args.modelProfile !== 'auto' && args.modelProfile !== 'manual') {
    console.error('[Orchestrator] --model-profile must be "auto" or "manual".');
    haltAndExit(2);
  }
  const manualStages = args.modelProfile === 'manual' ? parseModelsJson(args.models) : null;
  return resolveModelProfile({
    config,
    runner: runnerName,
    profile: args.modelProfile,
    manualStages,
  });
}

function loadWorkCwdFromStatus() {
  workCwd = repoRoot;
  if (status.sandbox) {
    const sandbox = path.join(repoRoot, '.pipeline_sandbox');
    if (!fs.existsSync(sandbox)) {
      console.error(`[Orchestrator] Sandbox worktree ${sandbox} no longer exists.`);
      haltAndExit(1);
    }
    workCwd = sandbox;
  }
}

function loadHistory() {
  try { history = JSON.parse(fs.readFileSync(paths.testHistory, 'utf8')); } catch { history = { coder: [], postTester: [] }; }
}

function releaseLock() {
  try { fs.unlinkSync(paths.lock); } catch {}
}
function haltAndExit(code) {
  releaseLock();
  process.exit(code);
}
function interrupted(code) {
  if (status) {
    status.overall = 'halted';
    status.haltReason = status.haltReason || 'INTERRUPTED';
    for (const s of status.stages) {
      if (s.status === 'running') {
        s.status = 'interrupted';
        s.endedAt = new Date().toISOString();
      }
    }
    finalize();
  }
  haltAndExit(code);
}
process.on('SIGINT', () => interrupted(130));
process.on('SIGTERM', () => interrupted(143));
process.on('exit', releaseLock);

// ---- Set up run state: continue chat handoff, resume halted run, or fresh --
if (args.continue) {
  let onDisk;
  try { onDisk = JSON.parse(fs.readFileSync(paths.status, 'utf8')); } catch {
    console.error('[Orchestrator] Nothing to continue: no status.json found.');
    haltAndExit(1);
  }
  if (onDisk.overall !== 'awaiting_chat' || !onDisk.chatResume?.step) {
    console.error('[Orchestrator] Nothing to continue: pipeline is not awaiting an IDE chat handoff.');
    haltAndExit(1);
  }
  status = onDisk;
  status.overall = 'running';
  status.awaitingStage = null;
  runner = status.runner || 'host';
  models = status.models || null;
  loadWorkCwdFromStatus();
  loadHistory();
  appendEvent(paths, { stage: 'orchestrator', type: 'pipeline_continue_chat', step: onDisk.chatResume.step });
  console.log(`[Orchestrator] Continuing chat handoff (step=${onDisk.chatResume.step}, runner=${runner}). Dashboard: http://localhost:${uiPort}`);
} else if (args.resume) {
  let onDisk;
  try { onDisk = JSON.parse(fs.readFileSync(paths.status, 'utf8')); } catch {
    console.error('[Orchestrator] Nothing to resume: no previous run found.');
    haltAndExit(1);
  }
  const isExtend = args.extend !== null;
  if (isExtend) {
    if (onDisk.overall !== 'halted' || onDisk.haltReason !== 'MAX_CYCLES' || !onDisk.haltedPhase) {
      console.error(`[Orchestrator] Cannot resume: last run's halt reason was "${onDisk.haltReason || onDisk.overall}", not MAX_CYCLES. Only cycle-budget halts can be extended.`);
      haltAndExit(1);
    }
    status = onDisk;
    status.limits = status.limits || { coderMax: config.maxCoderCycles, postTesterMax: config.maxPostTesterCycles }; // back-compat
    runner = args.runner || status.runner;
    models = status.models || null;
    loadWorkCwdFromStatus();
    loadHistory();
    console.log(`[Orchestrator] Resuming pipeline (phase=${status.haltedPhase}, +${args.extend} cycles). Dashboard: http://localhost:${uiPort}`);
  } else {
    const lock = readLock(paths);
    const stale = onDisk.overall === 'running' && !(lock && pidAlive(lock.pid));
    const isInterrupted = onDisk.overall === 'halted' && onDisk.haltReason === 'INTERRUPTED';
    if (onDisk.overall === 'done') {
      console.error('[Orchestrator] Cannot resume: the last run completed successfully.');
      haltAndExit(1);
    }
    if (onDisk.overall === 'halted' && onDisk.haltReason !== 'INTERRUPTED') {
      console.error(`[Orchestrator] Cannot resume: last run's halt reason was "${onDisk.haltReason}". Resuming is only supported for interrupted or stale runs.`);
      haltAndExit(1);
    }
    if (!isInterrupted && !stale) {
      console.error(`[Orchestrator] Cannot resume: last run is in state "${onDisk.overall}" (haltReason=${onDisk.haltReason}) and is not stale.`);
      haltAndExit(1);
    }
    status = onDisk;
    runner = args.runner || status.runner;
    models = status.models || null;
    loadWorkCwdFromStatus();
    loadHistory();
    console.log(`[Orchestrator] Resuming interrupted/stale run. Dashboard: http://localhost:${uiPort}`);
  }
} else {
  // ---- Guardrail 1: sandbox worktree ------------------------------------------
  workCwd = repoRoot;
  if (args.sandbox) {
    const sandbox = path.join(repoRoot, '.pipeline_sandbox');
    console.log('[Orchestrator] Isolating workspace in git worktree sandbox...');
    try { execSync(`git worktree remove "${sandbox}" --force`, { cwd: repoRoot, stdio: 'ignore' }); } catch {}
    try { execSync('git branch -D tmp-pipeline-branch', { cwd: repoRoot, stdio: 'ignore' }); } catch {}
    execSync(`git worktree add "${sandbox}" -b tmp-pipeline-branch`, { cwd: repoRoot, stdio: 'inherit' });
    // Point the sandbox's .pipeline at the main one so all artifacts/logs land
    // in a single place the UI server is watching.
    const sandboxPipeline = path.join(sandbox, '.pipeline');
    fs.rmSync(sandboxPipeline, { recursive: true, force: true });
    fs.symlinkSync(paths.dir, sandboxPipeline, 'dir');
    workCwd = sandbox;
  }

  // ---- Archive previous run, then fresh-run reset -----------------------------
  const RUN_FILES = [paths.status, paths.events, paths.vagueRequest, paths.specs, paths.changes, paths.checkerReport, paths.testSuite, paths.reviewReport, paths.testHistory, paths.diff, paths.stageHandoff];
  if (fs.existsSync(paths.status)) {
    let runId = 'run';
    try { runId = (JSON.parse(fs.readFileSync(paths.status, 'utf8')).startedAt || new Date().toISOString()).replace(/[:]/g, '-').replace(/\..*$/, ''); } catch {}
    const dest = path.join(paths.runs, runId);
    fs.mkdirSync(dest, { recursive: true });
    for (const f of RUN_FILES) { try { fs.renameSync(f, path.join(dest, path.basename(f))); } catch {} }
    try { fs.renameSync(paths.logs, path.join(dest, 'logs')); } catch {}
    console.log(`[Orchestrator] Archived previous run to .pipeline/runs/${runId}`);
  }
  for (const f of RUN_FILES) { try { fs.unlinkSync(f); } catch {} }
  fs.rmSync(paths.logs, { recursive: true, force: true });
  fs.writeFileSync(paths.vagueRequest, args.task);

  runner = detectRunner(config, { invocationMode });
  try {
    models = resolveModelsForRun(runner);
  } catch (err) {
    console.error(`[Orchestrator] ${err.message}`);
    haltAndExit(2);
  }
  status = newStatus(args.task);
  status.invocationMode = invocationMode;
  status.runner = runner;
  status.models = models;
  status.sandbox = args.sandbox;
  status.haltedPhase = null;
  status.extensions = [];
  status.limits = {
    coderMax: Number.isInteger(args.maxCycles) && args.maxCycles > 0 ? args.maxCycles : config.maxCoderCycles,
    postTesterMax: Number.isInteger(args.maxPostTesterCycles) && args.maxPostTesterCycles > 0 ? args.maxPostTesterCycles : config.maxPostTesterCycles,
  };
  status.stages.find((s) => s.name === 'coder').maxCycles = status.limits.coderMax;
  history = { coder: [], postTester: [] };
  writeStatus(paths, status);
  appendEvent(paths, { stage: 'orchestrator', type: 'pipeline_start', task: args.task, runner, invocationMode, models });
  const modeLabel = invocationMode === 'chat' ? 'chat (IDE host)' : 'cli (subprocess)';
  const modelSummary = models ? Object.entries(models.stages).map(([s, m]) => `${s}=${m}`).join(', ') : '';
  console.log(`[Orchestrator] Pipeline started (mode=${modeLabel}, runner=${runner}, models=${modelSummary || 'default'}, sandbox=${args.sandbox}, coderMax=${status.limits.coderMax}, postTesterMax=${status.limits.postTesterMax}). Dashboard: http://localhost:${uiPort}`);
}

function stage(name) { return status.stages.find((s) => s.name === name); }
function setStage(name, patch) {
  Object.assign(stage(name), patch);
  writeStatus(paths, status);
  appendEvent(paths, { stage: name, type: 'stage_update', ...patch });
}
function finalize() {
  status.endedAt = new Date().toISOString();
  writeStatus(paths, status);
  appendEvent(paths, { stage: 'orchestrator', type: 'pipeline_end', overall: status.overall, verdict: status.verdict, haltReason: status.haltReason });
}
function halt(stageName, reason, detail) {
  console.error(`\n[HALT] ${reason}: ${detail}`);
  setStage(stageName, { status: reason === 'REGRESSION_BLOCKED' ? 'blocked' : 'failed', endedAt: new Date().toISOString(), detail });
  status.overall = 'halted';
  status.haltReason = reason;
  finalize();
  haltAndExit(1);
}
// MAX_CYCLES halts record WHICH loop ran out (status.haltedPhase) so a later
// `--resume --extend N` knows exactly where to pick back up.
function haltMaxCycles(phase, stageName, limit) {
  status.haltedPhase = phase;
  // The Coder loop is what's actually stuck in both phases (the post-tester
  // loop halts via the 'tester' stage) — make sure its card never shows a
  // stale "Running" badge once the pipeline has halted.
  if (stage('coder').status === 'running') setStage('coder', { status: 'failed', endedAt: new Date().toISOString() });
  const label = phase === 'coder' ? 'Coder' : 'Post-tester coder';
  halt(stageName, 'MAX_CYCLES', `${label} loop reached ${limit} cycles without passing verification. Inspect .pipeline/checker_report.md and .pipeline/changes.md — extend from the dashboard, or run: node pipeline/orchestrator.mjs --resume --extend <n>.`);
}
function artifactOk(file) {
  try { return fs.statSync(file).size > 0; } catch { return false; }
}
function requireArtifact(stageName, file) {
  if (!artifactOk(file)) halt(stageName, 'MISSING_ARTIFACT', `${stageName} did not produce ${path.relative(repoRoot, file)}`);
}

function requestChatHandoff(stageName, chatResume) {
  status.chatResume = chatResume;
  status.overall = 'awaiting_chat';
  status.awaitingStage = stageName;
  status.dashboardUrl = `http://localhost:${uiPort}`;
  try { fs.writeFileSync(path.join(paths.dir, 'ui.url'), `${status.dashboardUrl}\n`); } catch {}
  setStage(stageName, { status: 'awaiting_host', detail: 'Waiting for IDE chat agent to complete this stage' });
  finalize();
  console.log(`\n[Orchestrator] Chat handoff — complete the ${stageName} stage in your IDE, then run:`);
  console.log('  bash .pipeline/orchestrate.sh --continue');
  console.log('[Orchestrator] Stage brief: .pipeline/stage-handoff.json');
  console.log(`[Orchestrator] Live dashboard: ${status.dashboardUrl}\n`);
  haltAndExit(0);
}

function agentAuthHint(runnerName) {
  const hints = {
    cursor: "Run `agent login` or set CURSOR_API_KEY.",
    claude: 'Run `claude auth login`.',
    codex: 'Run `codex login`.',
    gemini: 'Run `gemini auth login` (see Gemini CLI docs).',
  };
  return hints[runnerName] || 'Log in to the agent CLI or invoke from IDE chat (host mode).';
}

// Human follow-up notes queued from the dashboard are injected into the next
// invocation of that agent, then cleared.
function consumeFollowups(name) {
  const file = path.join(paths.dir, 'followups', `${name}.txt`);
  try {
    const text = fs.readFileSync(file, 'utf8').trim();
    fs.unlinkSync(file);
    if (text) appendEvent(paths, { stage: name, type: 'followup_applied', text });
    return text;
  } catch { return ''; }
}

async function runStageAgent(name, task, { cycle = 1, readOnly = false, chatResume = null } = {}) {
  const promptFile = path.join(paths.prompts, `${name === 'coder' ? 'coder' : name}_prompt.txt`);
  const followup = consumeFollowups(name);
  if (followup) task += `\n\nHUMAN FOLLOW-UP NOTES (address these):\n${followup}`;
  const stageModel = modelForStage(models, name);
  const res = await runAgent({
    runner, stage: name, cycle, task, systemPromptFile: promptFile, cwd: workCwd, readOnly, paths, config,
    model: stageModel,
    modelSelection: models?.selection,
  });
  if (res.hostHandoff) {
    if (!chatResume?.step) halt(name, 'AGENT_ERROR', 'Internal error: missing chatResume step for host handoff.');
    requestChatHandoff(name, chatResume);
  }
  if (!res.ok) {
    const logTail = tailFile(path.join(paths.logs, `${name}.log`), 40);
    if (/authentication required|not authenticated|please run .* login/i.test(logTail)) {
      halt(name, 'AGENT_ERROR', `${runner} is not authenticated. ${agentAuthHint(runner)} Or re-run from IDE chat without --runner to use host mode.`);
    }
    if (res.error) halt(name, 'AGENT_ERROR', `${runner} CLI failed: ${res.error}`);
    halt(name, 'AGENT_ERROR', `${runner} CLI exited with code ${res.exitCode ?? '?'}. Inspect .pipeline/logs/${name}.log`);
  }
  return res;
}

function writeDiffArtifact() {
  const git = (gitArgs) => spawnSync('git', gitArgs, { cwd: workCwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  let patch = git(['diff', 'HEAD']).stdout || '';
  const untracked = (git(['ls-files', '--others', '--exclude-standard']).stdout || '').split('\n').filter(Boolean);
  for (const f of untracked) {
    if (f.startsWith('.pipeline')) continue;
    patch += git(['diff', '--no-index', '/dev/null', f]).stdout || '';
  }
  try { fs.writeFileSync(paths.diff, patch || 'No working-tree changes detected.\n'); } catch {}
}

function saveHistory() { fs.writeFileSync(paths.testHistory, JSON.stringify(history, null, 2)); }

// Returns 'pass' | 'continue', or halts the process on regression. Regression
// halts are intentionally NOT resumable via --extend — a passed-count drop
// means something broke and needs a human look, not more automated cycles.
function evaluateChecks(phase, stageName, check) {
  const prev = history[phase].at(-1);
  history[phase].push({ passedCount: check.passedCount, failedCount: check.failedCount, isPassed: check.isPassed, at: new Date().toISOString() });
  saveHistory();
  setStage('coder', { checks: { passedCount: check.passedCount, failedCount: check.failedCount, isPassed: check.isPassed } });
  if (check.isPassed) return 'pass';
  if (prev && check.passedCount < prev.passedCount) {
    halt(stageName, 'REGRESSION_BLOCKED',
      `Previous cycle passed ${prev.passedCount} tests; this cycle only passed ${check.passedCount}. A change broke existing functionality — human inspection required.`);
  }
  return 'continue';
}

// ---- Composable stage runners (shared by fresh runs, --continue, and --resume) -

function coderTask(cycle) {
  return cycle === 1
    ? `Implement the specification in .pipeline/specs.md for this feature request:\n\n${status.task}\n\nDocument your work in .pipeline/changes.md.`
    : `Fix cycle ${cycle}: the checker found failures. Read .pipeline/checker_report.md, fix the root causes for the task "${status.task}", and append a "## Fix Cycle ${cycle}" section to .pipeline/changes.md. Do NOT weaken or remove tests.`;
}

function postTesterCoderTask(localCycle) {
  return `The Tester added new tests that expose failures. Read .pipeline/checker_report.md, fix the root causes for the task "${status.task}", and append a "## Post-Tester Fix Cycle ${localCycle}" section to .pipeline/changes.md. Do NOT weaken or remove the new tests.`;
}

async function invokeInitialCoderCycle(cycle) {
  status.resumePoint = { step: 'coder', context: { cycle, loop: 'initial' } };
  setStage('coder', { status: 'running', cycle, maxCycles: status.limits.coderMax });
  console.log(`[Stage] Coder — fix cycle ${cycle}/${status.limits.coderMax}...`);
  await runStageAgent('coder', coderTask(cycle), {
    cycle,
    chatResume: { step: 'after_coder', context: { cycle, loop: 'initial' } },
  });
}

async function runCoderChecksAfterInitialCycle(cycle) {
  requireArtifact('coder', paths.changes);
  console.log('[Checker] Running verification (test / lint / typecheck)...');
  appendEvent(paths, { stage: 'coder', cycle, type: 'checks_start' });
  const check = runChecks({ cwd: workCwd, config, paths });
  console.log(`[Checker] ${check.isPassed ? 'PASS' : 'FAIL'} — ${check.passedCount} passed, ${check.failedCount} failed`);
  if (evaluateChecks('coder', 'coder', check) === 'pass') return 'pass';
  if (cycle >= status.limits.coderMax) return 'exhausted';
  return 'continue';
}

async function runInitialCoderLoop(startCycle) {
  for (let cycle = startCycle; cycle <= status.limits.coderMax; cycle++) {
    await invokeInitialCoderCycle(cycle);
    status.resumePoint = { step: 'after_coder', context: { cycle, loop: 'initial' } };
    writeStatus(paths, status);
    const outcome = await runCoderChecksAfterInitialCycle(cycle);
    if (outcome === 'pass') return true;
    if (outcome === 'exhausted') return false;
  }
  return false;
}

async function invokePostTesterCoderCycle(cycle) {
  const localCycle = cycle - status.limits.coderMax;
  const totalMax = status.limits.coderMax + status.limits.postTesterMax;
  status.resumePoint = { step: 'coder', context: { cycle, loop: 'postTester' } };
  setStage('coder', { status: 'running', cycle, maxCycles: totalMax });
  console.log(`[Stage] Coder (post-tester fix) — cycle ${localCycle}/${status.limits.postTesterMax}...`);
  await runStageAgent('coder', postTesterCoderTask(localCycle), {
    cycle,
    chatResume: { step: 'after_coder', context: { cycle, loop: 'postTester' } },
  });
}

async function runCoderChecksAfterPostTesterCycle(cycle) {
  requireArtifact('coder', paths.changes);
  const check = runChecks({ cwd: workCwd, config, paths });
  console.log(`[Checker] ${check.isPassed ? 'PASS' : 'FAIL'} — ${check.passedCount} passed, ${check.failedCount} failed`);
  if (evaluateChecks('postTester', 'tester', check) === 'pass') return 'pass';
  const totalMax = status.limits.coderMax + status.limits.postTesterMax;
  if (cycle >= totalMax) return 'exhausted';
  return 'continue';
}

async function runPostTesterLoop(startCycle) {
  const totalMax = status.limits.coderMax + status.limits.postTesterMax;
  for (let cycle = startCycle; cycle <= totalMax; cycle++) {
    await invokePostTesterCoderCycle(cycle);
    status.resumePoint = { step: 'after_coder', context: { cycle, loop: 'postTester' } };
    writeStatus(paths, status);
    const outcome = await runCoderChecksAfterPostTesterCycle(cycle);
    if (outcome === 'pass') return true;
    if (outcome === 'exhausted') return false;
  }
  return false;
}

async function runPlannerStage() {
  status.resumePoint = { step: 'planner', context: {} };
  setStage('planner', { status: 'running', startedAt: new Date().toISOString(), cycle: 1 });
  console.log('[Stage] Planner...');
  await runStageAgent('planner', `Produce a technical specification for this feature request:\n\n${status.task}\n\nThe raw request is also in .pipeline/vague_request.txt. Write the spec to .pipeline/specs.md.`, {
    chatResume: { step: 'after_planner', context: {} },
  });
  status.resumePoint = { step: 'after_planner', context: {} };
  writeStatus(paths, status);
  requireArtifact('planner', paths.specs);
  setStage('planner', { status: 'passed', endedAt: new Date().toISOString(), artifact: 'specs.md' });
}

async function runCoderStage() {
  setStage('coder', { status: 'running', startedAt: new Date().toISOString() });
  const green = await runInitialCoderLoop(1);
  if (!green) { haltMaxCycles('coder', 'coder', status.limits.coderMax); return false; }
  setStage('coder', { status: 'passed', endedAt: new Date().toISOString(), artifact: 'changes.md' });
  return true;
}

async function runTesterStage() {
  status.resumePoint = { step: 'tester', context: {} };
  setStage('tester', { status: 'running', startedAt: new Date().toISOString(), cycle: 1 });
  console.log('[Stage] Tester...');
  await runStageAgent('tester', `Write rigorous tests for the implementation of: ${status.task}\n\nRead .pipeline/specs.md and .pipeline/changes.md first. Summarize coverage in .pipeline/test_suite.md.`, {
    chatResume: { step: 'after_tester', context: {} },
  });
  status.resumePoint = { step: 'after_tester', context: {} };
  writeStatus(paths, status);
  requireArtifact('tester', paths.testSuite);

  console.log('[Checker] Re-running full suite with the new tests...');
  let check = runChecks({ cwd: workCwd, config, paths });
  console.log(`[Checker] ${check.isPassed ? 'PASS' : 'FAIL'} — ${check.passedCount} passed, ${check.failedCount} failed`);
  if (!check.isPassed) {
    history.postTester.push({ passedCount: check.passedCount, failedCount: check.failedCount, isPassed: false, at: new Date().toISOString() });
    saveHistory();
    const green = await runPostTesterLoop(status.limits.coderMax + 1);
    if (!green) { haltMaxCycles('postTester', 'tester', status.limits.postTesterMax); return false; }
    setStage('coder', { status: 'passed' });
    check = stage('coder').checks;
  }
  setStage('tester', { status: 'passed', endedAt: new Date().toISOString(), artifact: 'test_suite.md', checks: { passedCount: check.passedCount, failedCount: check.failedCount, isPassed: true } });
  return true;
}

async function runReviewerStage() {
  // Snapshot the working-tree diff so the dashboard can render the audit
  // surface alongside the review.
  writeDiffArtifact();
  status.resumePoint = { step: 'reviewer', context: {} };
  setStage('reviewer', { status: 'running', startedAt: new Date().toISOString(), cycle: 1 });
  console.log('[Stage] Reviewer (read-only audit)...');
  await runStageAgent('reviewer', `Audit the completed implementation of: ${status.task}\n\nRead .pipeline/specs.md, .pipeline/changes.md and .pipeline/test_suite.md, run git diff, and write your verdict to .pipeline/review_report.md.`, {
    readOnly: true,
    chatResume: { step: 'after_reviewer', context: {} },
  });
  status.resumePoint = { step: 'after_reviewer', context: {} };
  writeStatus(paths, status);
  await finishReviewerStage();
}

async function finishReviewerStage() {
  requireArtifact('reviewer', paths.reviewReport);
  const report = fs.readFileSync(paths.reviewReport, 'utf8');
  const verdictMatch = report.match(/##\s*Verdict:\s*\[?\s*(APPROVED|REQUEST_CHANGES|BLOCK)/i);
  status.verdict = verdictMatch ? verdictMatch[1].toUpperCase() : 'UNKNOWN';
  setStage('reviewer', { status: status.verdict === 'APPROVED' ? 'passed' : 'failed', endedAt: new Date().toISOString(), artifact: 'review_report.md', detail: `Verdict: ${status.verdict}` });

  status.overall = 'done';
  status.chatResume = null;
  finalize();
  console.log(`\n[Orchestrator] Pipeline complete. Verdict: ${status.verdict}`);
  console.log(`Review: ${path.relative(repoRoot, paths.reviewReport)}`);
  haltAndExit(status.verdict === 'APPROVED' ? 0 : 1);
}

async function chatContinueRun() {
  const resume = status.chatResume;
  status.chatResume = null;
  try { fs.unlinkSync(paths.stageHandoff); } catch {}

  const step = resume.step;
  const context = resume.context || {};

  if (step === 'after_planner') {
    requireArtifact('planner', paths.specs);
    setStage('planner', { status: 'passed', endedAt: new Date().toISOString(), artifact: 'specs.md' });
    if (!(await runCoderStage())) return;
    if (!(await runTesterStage())) return;
    await runReviewerStage();
    return;
  }

  if (step === 'after_coder') {
    if (context.loop === 'postTester') {
      const outcome = await runCoderChecksAfterPostTesterCycle(context.cycle);
      if (outcome === 'pass') {
        setStage('coder', { status: 'passed' });
        setStage('tester', { status: 'passed', endedAt: new Date().toISOString(), artifact: 'test_suite.md', checks: stage('coder').checks });
        await runReviewerStage();
        return;
      }
      if (outcome === 'exhausted') {
        haltMaxCycles('postTester', 'tester', status.limits.postTesterMax);
        return;
      }
      await invokePostTesterCoderCycle(context.cycle + 1);
      return;
    }

    const outcome = await runCoderChecksAfterInitialCycle(context.cycle);
    if (outcome === 'pass') {
      setStage('coder', { status: 'passed', endedAt: new Date().toISOString(), artifact: 'changes.md' });
      if (!(await runTesterStage())) return;
      await runReviewerStage();
      return;
    }
    if (outcome === 'exhausted') {
      haltMaxCycles('coder', 'coder', status.limits.coderMax);
      return;
    }
    await invokeInitialCoderCycle(context.cycle + 1);
    return;
  }

  if (step === 'after_tester') {
    requireArtifact('tester', paths.testSuite);
    console.log('[Checker] Re-running full suite with the new tests...');
    let check = runChecks({ cwd: workCwd, config, paths });
    console.log(`[Checker] ${check.isPassed ? 'PASS' : 'FAIL'} — ${check.passedCount} passed, ${check.failedCount} failed`);
    if (!check.isPassed) {
      history.postTester.push({ passedCount: check.passedCount, failedCount: check.failedCount, isPassed: false, at: new Date().toISOString() });
      saveHistory();
      const green = await runPostTesterLoop(status.limits.coderMax + 1);
      if (!green) { haltMaxCycles('postTester', 'tester', status.limits.postTesterMax); return; }
      setStage('coder', { status: 'passed' });
      check = stage('coder').checks;
    }
    setStage('tester', { status: 'passed', endedAt: new Date().toISOString(), artifact: 'test_suite.md', checks: { passedCount: check.passedCount, failedCount: check.failedCount, isPassed: true } });
    await runReviewerStage();
    return;
  }

  if (step === 'after_reviewer') {
    await finishReviewerStage();
    return;
  }

  halt('orchestrator', 'AGENT_ERROR', `Unknown chat resume step "${step}".`);
}

async function freshRun() {
  await runPlannerStage();
  if (!(await runCoderStage())) return;
  if (!(await runTesterStage())) return;
  await runReviewerStage();
}

function getResumePoint() {
  if (status.resumePoint) return status.resumePoint;
  
  const planner = stage('planner');
  const coder = stage('coder');
  const tester = stage('tester');
  const reviewer = stage('reviewer');
  
  if (planner.status !== 'passed') {
    return { step: 'planner', context: {} };
  }
  if (coder.status !== 'passed') {
    const isPostTester = coder.maxCycles > status.limits.coderMax;
    const cycle = coder.cycle || 1;
    const loop = isPostTester ? 'postTester' : 'initial';
    if (coder.status === 'failed') {
      return { step: 'after_coder', context: { cycle, loop } };
    }
    return { step: 'coder', context: { cycle, loop } };
  }
  if (tester.status !== 'passed') {
    return { step: 'tester', context: {} };
  }
  return { step: 'reviewer', context: {} };
}

async function resumeInterruptedRun() {
  status.overall = 'running';
  status.haltReason = null;
  status.limits = status.limits || { coderMax: config.maxCoderCycles, postTesterMax: config.maxPostTesterCycles };
  writeStatus(paths, status);
  appendEvent(paths, { stage: 'orchestrator', type: 'pipeline_resume_interrupted' });

  const pt = getResumePoint();
  const step = pt.step;
  const context = pt.context || {};
  const cycle = context.cycle;
  const loop = context.loop;

  console.log(`[Orchestrator] Resuming interrupted run at step: ${step}${cycle ? ` (cycle ${cycle}, loop ${loop})` : ''}`);

  if (step === 'planner') {
    await runPlannerStage();
    if (!(await runCoderStage())) return;
    if (!(await runTesterStage())) return;
    await runReviewerStage();
    return;
  }

  if (step === 'after_planner') {
    requireArtifact('planner', paths.specs);
    setStage('planner', { status: 'passed', endedAt: new Date().toISOString(), artifact: 'specs.md' });
    if (!(await runCoderStage())) return;
    if (!(await runTesterStage())) return;
    await runReviewerStage();
    return;
  }

  if (step === 'coder') {
    if (loop === 'initial') {
      const green = await runInitialCoderLoop(cycle);
      if (!green) { haltMaxCycles('coder', 'coder', status.limits.coderMax); return; }
      setStage('coder', { status: 'passed', endedAt: new Date().toISOString(), artifact: 'changes.md' });
      if (!(await runTesterStage())) return;
      await runReviewerStage();
    } else if (loop === 'postTester') {
      const green = await runPostTesterLoop(cycle);
      if (!green) { haltMaxCycles('postTester', 'tester', status.limits.postTesterMax); return; }
      setStage('coder', { status: 'passed' });
      let check = stage('coder').checks;
      setStage('tester', { status: 'passed', endedAt: new Date().toISOString(), artifact: 'test_suite.md', checks: { passedCount: check.passedCount, failedCount: check.failedCount, isPassed: true } });
      await runReviewerStage();
    }
    return;
  }

  if (step === 'after_coder') {
    if (loop === 'postTester') {
      const outcome = await runCoderChecksAfterPostTesterCycle(cycle);
      if (outcome === 'pass') {
        setStage('coder', { status: 'passed' });
        setStage('tester', { status: 'passed', endedAt: new Date().toISOString(), artifact: 'test_suite.md', checks: stage('coder').checks });
        await runReviewerStage();
        return;
      }
      if (outcome === 'exhausted') {
        haltMaxCycles('postTester', 'tester', status.limits.postTesterMax);
        return;
      }
      if (status.invocationMode === 'chat') {
        await invokePostTesterCoderCycle(cycle + 1);
      } else {
        const green = await runPostTesterLoop(cycle + 1);
        if (!green) { haltMaxCycles('postTester', 'tester', status.limits.postTesterMax); return; }
        setStage('coder', { status: 'passed' });
        let check = stage('coder').checks;
        setStage('tester', { status: 'passed', endedAt: new Date().toISOString(), artifact: 'test_suite.md', checks: { passedCount: check.passedCount, failedCount: check.failedCount, isPassed: true } });
        await runReviewerStage();
      }
      return;
    }

    const outcome = await runCoderChecksAfterInitialCycle(cycle);
    if (outcome === 'pass') {
      setStage('coder', { status: 'passed', endedAt: new Date().toISOString(), artifact: 'changes.md' });
      if (!(await runTesterStage())) return;
      await runReviewerStage();
      return;
    }
    if (outcome === 'exhausted') {
      haltMaxCycles('coder', 'coder', status.limits.coderMax);
      return;
    }
    if (status.invocationMode === 'chat') {
      await invokeInitialCoderCycle(cycle + 1);
    } else {
      const green = await runInitialCoderLoop(cycle + 1);
      if (!green) { haltMaxCycles('coder', 'coder', status.limits.coderMax); return; }
      setStage('coder', { status: 'passed', endedAt: new Date().toISOString(), artifact: 'changes.md' });
      if (!(await runTesterStage())) return;
      await runReviewerStage();
    }
    return;
  }

  if (step === 'tester') {
    if (!(await runTesterStage())) return;
    await runReviewerStage();
    return;
  }

  if (step === 'after_tester') {
    requireArtifact('tester', paths.testSuite);
    console.log('[Checker] Re-running full suite with the new tests...');
    let check = runChecks({ cwd: workCwd, config, paths });
    console.log(`[Checker] ${check.isPassed ? 'PASS' : 'FAIL'} — ${check.passedCount} passed, ${check.failedCount} failed`);
    if (!check.isPassed) {
      history.postTester.push({ passedCount: check.passedCount, failedCount: check.failedCount, isPassed: false, at: new Date().toISOString() });
      saveHistory();
      if (status.invocationMode === 'chat') {
        await invokePostTesterCoderCycle(status.limits.coderMax + 1);
        return;
      } else {
        const green = await runPostTesterLoop(status.limits.coderMax + 1);
        if (!green) { haltMaxCycles('postTester', 'tester', status.limits.postTesterMax); return; }
        setStage('coder', { status: 'passed' });
        check = stage('coder').checks;
      }
    }
    setStage('tester', { status: 'passed', endedAt: new Date().toISOString(), artifact: 'test_suite.md', checks: { passedCount: check.passedCount, failedCount: check.failedCount, isPassed: true } });
    await runReviewerStage();
    return;
  }

  if (step === 'reviewer') {
    await runReviewerStage();
    return;
  }

  if (step === 'after_reviewer') {
    await finishReviewerStage();
    return;
  }

  halt('orchestrator', 'AGENT_ERROR', `Unknown resume step "${step}".`);
}

async function resumeRun() {
  const phase = status.haltedPhase;
  status.overall = 'running';
  status.haltReason = null;
  status.extensions = status.extensions || [];
  status.extensions.push({ phase, addedCycles: args.extend, at: new Date().toISOString() });
  appendEvent(paths, { stage: 'orchestrator', type: 'pipeline_resume', phase, extend: args.extend });

  if (phase === 'coder') {
    const startCycle = stage('coder').cycle + 1;
    status.limits.coderMax += args.extend;
    setStage('coder', { status: 'running', maxCycles: status.limits.coderMax, detail: null });
    const green = await runInitialCoderLoop(startCycle);
    if (!green) { haltMaxCycles('coder', 'coder', status.limits.coderMax); return; }
    setStage('coder', { status: 'passed', endedAt: new Date().toISOString(), artifact: 'changes.md' });
    if (!(await runTesterStage())) return;
    await runReviewerStage();
  } else if (phase === 'postTester') {
    const startCycle = stage('coder').cycle + 1;
    status.limits.postTesterMax += args.extend;
    setStage('tester', { status: 'running', detail: null });
    setStage('coder', { status: 'running', maxCycles: status.limits.coderMax + status.limits.postTesterMax });
    const green = await runPostTesterLoop(startCycle);
    if (!green) { haltMaxCycles('postTester', 'tester', status.limits.postTesterMax); return; }
    setStage('coder', { status: 'passed' });
    setStage('tester', { status: 'passed', endedAt: new Date().toISOString(), artifact: 'test_suite.md', checks: stage('coder').checks });
    await runReviewerStage();
  } else {
    console.error(`[Orchestrator] Cannot resume: unknown halted phase "${phase}".`);
    haltAndExit(1);
  }
}

(args.continue ? chatContinueRun() : args.resume ? (args.extend !== null ? resumeRun() : resumeInterruptedRun()) : freshRun()).catch((err) => {
  console.error('[Orchestrator] Uncaught error:', err);
  if (status) { status.overall = 'halted'; status.haltReason = 'AGENT_ERROR'; finalize(); }
  haltAndExit(1);
});
