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
import { pipelinePaths, loadConfig, newStatus, writeStatus, appendEvent, pidAlive, readLock, tailFile, ensureStageEntries } from './state.mjs';
import { runChecks } from './checker.mjs';
import { runAgent, detectRunner } from './adapters.mjs';
import { detectInvocationMode } from './invocation.mjs';
import { resolveModelProfile, parseModelsJson, modelForStage } from './models.mjs';

function parseArgs(argv) {
  const args = {
    task: null, runner: null, sandbox: false, resume: false, continue: false, extend: null,
    maxCycles: null, maxPostTesterCycles: null, maxReviewCycles: null, mode: null,
    modelProfile: 'auto', models: null,
    approvePlan: false, design: false, handoff: false,
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
    else if (a === '--max-review-cycles') args.maxReviewCycles = parseInt(argv[++i], 10);
    else if (a === '--mode') args.mode = argv[++i];
    else if (a === '--model-profile') args.modelProfile = argv[++i];
    else if (a === '--models') args.models = argv[++i];
    else if (a === '--approve-plan') args.approvePlan = true;
    else if (a === '--design') args.design = true;
    else if (a === '--handoff') args.handoff = true;
    else if (!args.task && !a.startsWith('--')) args.task = a;
  }
  return args;
}

const USAGE = 'Usage: node pipeline/orchestrator.mjs --task "description" [--runner claude|cursor|codex|gemini|host] [--mode chat|cli] [--model-profile auto|manual] [--models \'{"planner":"...","coder":"..."}\'] [--approve-plan] [--design] [--handoff] [--sandbox] [--max-cycles n] [--max-post-tester-cycles n] [--max-review-cycles n]\n   or: node pipeline/orchestrator.mjs --continue\n   or: node pipeline/orchestrator.mjs --resume [--extend <n>] [--runner ...]';

const repoRoot = process.cwd();
const paths = pipelinePaths(repoRoot);
const config = loadConfig(paths);
const args = parseArgs(process.argv.slice(2));
const rawUiPort = process.env.PIPELINE_UI_PORT;
const uiPort = (rawUiPort === 'disabled') ? null : (rawUiPort || config.uiPort);
const dashboardUrl = uiPort ? `http://localhost:${uiPort}` : null;
const dashboardMsg = dashboardUrl ? `. Dashboard: ${dashboardUrl}` : '';

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
// Acquire atomically with the 'wx' (exclusive create) flag so two orchestrators
// launched in the same tick cannot both pass an existsSync check and clobber the
// lock. On EEXIST, inspect the owner: reclaim only if its process is gone.
fs.mkdirSync(paths.dir, { recursive: true });
function acquireLock() {
  const payload = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(paths.lock, 'wx');
      fs.writeSync(fd, payload);
      fs.closeSync(fd);
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const lock = readLock(paths);
      if (lock && pidAlive(lock.pid)) {
        console.error(`[Orchestrator] Pipeline execution is locked by a running orchestrator (pid ${lock.pid}).`);
        process.exit(1);
      }
      console.error('[Orchestrator] Clearing stale lock (owning process is gone).');
      try { fs.unlinkSync(paths.lock); } catch {}
    }
  }
  console.error('[Orchestrator] Could not acquire lock after clearing a stale one (lost a race to another orchestrator).');
  process.exit(1);
}
acquireLock();

let status, history, workCwd, runner, models;
let planApprovalPending = false;

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
  if (onDisk.overall === 'awaiting_plan_approval' && onDisk.resumePoint?.step === 'plan_approval') {
    planApprovalPending = true;
  } else if (onDisk.overall !== 'awaiting_chat' || !onDisk.chatResume?.step) {
    console.error('[Orchestrator] Nothing to continue: pipeline is not awaiting an IDE chat handoff or plan approval.');
    haltAndExit(1);
  }
  status = onDisk;
  ensureStageEntries(status);
  status.flags = status.flags || { design: false, handoff: false, approvePlan: false };
  if (status.planApproved == null) status.planApproved = true; // legacy runs never gated
  status.overall = 'running';
  status.awaitingStage = null;
  status.limits = status.limits || { coderMax: config.maxCoderCycles, postTesterMax: config.maxPostTesterCycles, reviewMax: config.maxReviewCycles };
  if (status.limits.reviewMax == null) status.limits.reviewMax = config.maxReviewCycles;
  if (status.reviewPass == null) status.reviewPass = 0;
  runner = status.runner || 'host';
  models = status.models || null;
  loadWorkCwdFromStatus();
  loadHistory();
  if (!planApprovalPending) {
    appendEvent(paths, { stage: 'orchestrator', type: 'pipeline_continue_chat', step: onDisk.chatResume.step });
    console.log(`[Orchestrator] Continuing chat handoff (step=${onDisk.chatResume.step}, runner=${runner})${dashboardMsg}`);
  }
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
    ensureStageEntries(status);
    status.flags = status.flags || { design: false, handoff: false, approvePlan: false };
    if (status.planApproved == null) status.planApproved = true; // legacy runs never gated
    status.limits = status.limits || { coderMax: config.maxCoderCycles, postTesterMax: config.maxPostTesterCycles, reviewMax: config.maxReviewCycles }; // back-compat
    if (status.limits.reviewMax == null) status.limits.reviewMax = config.maxReviewCycles;
    if (status.reviewPass == null) status.reviewPass = 0;
    runner = args.runner || status.runner;
    models = status.models || null;
    loadWorkCwdFromStatus();
    loadHistory();
    console.log(`[Orchestrator] Resuming pipeline (phase=${status.haltedPhase}, +${args.extend} cycles)${dashboardMsg}`);
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
    ensureStageEntries(status);
    status.flags = status.flags || { design: false, handoff: false, approvePlan: false };
    if (status.planApproved == null) status.planApproved = true; // legacy runs never gated
    runner = args.runner || status.runner;
    models = status.models || null;
    loadWorkCwdFromStatus();
    loadHistory();
    console.log(`[Orchestrator] Resuming interrupted/stale run${dashboardMsg}`);
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
  const RUN_FILES = [paths.status, paths.events, paths.vagueRequest, paths.specs, paths.design, paths.changes, paths.checkerReport, paths.testSuite, paths.reviewReport, paths.handoffDoc, paths.testHistory, paths.diff, paths.stageHandoff];
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
  const runFlags = {
    design: args.design || config.designStage === true,
    handoff: args.handoff || config.handoffStage === true,
    approvePlan: args.approvePlan || config.approvePlan === true,
  };
  status = newStatus(args.task, { design: runFlags.design, handoff: runFlags.handoff });
  status.flags = runFlags;
  status.planApproved = false;
  status.invocationMode = invocationMode;
  status.runner = runner;
  status.models = models;
  status.sandbox = args.sandbox;
  // Capture the commit the run starts from, before any agent runs, so the
  // review diff can be scoped to this run even after agents commit their work.
  {
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: workCwd, encoding: 'utf8' });
    status.baseRef = head.status === 0 ? head.stdout.trim() : null;
  }
  status.haltedPhase = null;
  status.extensions = [];
  status.limits = {
    coderMax: Number.isInteger(args.maxCycles) && args.maxCycles > 0 ? args.maxCycles : config.maxCoderCycles,
    postTesterMax: Number.isInteger(args.maxPostTesterCycles) && args.maxPostTesterCycles > 0 ? args.maxPostTesterCycles : config.maxPostTesterCycles,
    reviewMax: Number.isInteger(args.maxReviewCycles) && args.maxReviewCycles > 0 ? args.maxReviewCycles : config.maxReviewCycles,
  };
  status.stages.find((s) => s.name === 'coder').maxCycles = status.limits.coderMax;
  history = { coder: [], postTester: [] };
  writeStatus(paths, status);
  appendEvent(paths, { stage: 'orchestrator', type: 'pipeline_start', task: args.task, runner, invocationMode, models, flags: runFlags });
  const modeLabel = invocationMode === 'chat' ? 'chat (IDE host)' : 'cli (subprocess)';
  const modelSummary = models ? Object.entries(models.stages).map(([s, m]) => `${s}=${m}`).join(', ') : '';
  console.log(`[Orchestrator] Pipeline started (mode=${modeLabel}, runner=${runner}, models=${modelSummary || 'default'}, sandbox=${args.sandbox}, coderMax=${status.limits.coderMax}, postTesterMax=${status.limits.postTesterMax}, reviewMax=${status.limits.reviewMax}, design=${runFlags.design}, approvePlan=${runFlags.approvePlan}, handoff=${runFlags.handoff})${dashboardMsg}`);
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
  // The Coder loop is what's actually stuck in the coder/post-tester phases (the
  // post-tester loop halts via the 'tester' stage) — make sure its card never
  // shows a stale "Running" badge once the pipeline has halted.
  if (phase !== 'review' && stage('coder').status === 'running') setStage('coder', { status: 'failed', endedAt: new Date().toISOString() });
  if (phase === 'review') {
    halt(stageName, 'MAX_CYCLES', `Reviewer fix loop reached ${limit} automatic pass${limit === 1 ? '' : 'es'} without an APPROVED verdict. Inspect .pipeline/review_report.md and .pipeline/changes.md — extend from the dashboard, or run: node pipeline/orchestrator.mjs --resume --extend <n>.`);
    return;
  }
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
  if (dashboardUrl) {
    status.dashboardUrl = dashboardUrl;
    try { fs.writeFileSync(path.join(paths.dir, 'ui.url'), `${status.dashboardUrl}\n`); } catch {}
  } else {
    status.dashboardUrl = null;
    try { fs.unlinkSync(path.join(paths.dir, 'ui.url')); } catch {}
  }
  setStage(stageName, { status: 'awaiting_host', detail: 'Waiting for IDE chat agent to complete this stage' });
  finalize();
  console.log(`\n[Orchestrator] Chat handoff — complete the ${stageName} stage in your IDE, then run:`);
  console.log('  bash .pipeline/orchestrate.sh --continue');
  const stageModel = modelForStage(models, stageName);
  if (stageModel) {
    console.log(`[Orchestrator] Suggested model: ${stageModel} (Note: actual model is determined by your active chat model)`);
  }
  console.log('[Orchestrator] Stage brief: .pipeline/stage-handoff.json');
  if (status.dashboardUrl) {
    console.log(`[Orchestrator] Live dashboard: ${status.dashboardUrl}\n`);
  }
  haltAndExit(0);
}

// Optional human gate: pause after the Planner so the developer can read
// specs.md before any code is written. Approval = `orchestrate.sh --continue`;
// queueing a planner follow-up note first triggers one re-plan instead.
function requestPlanApproval() {
  status.overall = 'awaiting_plan_approval';
  status.awaitingStage = 'planner';
  status.resumePoint = { step: 'plan_approval', context: {} };
  setStage('planner', { detail: 'Awaiting human plan approval' });
  finalize();
  console.log('\n[Orchestrator] Plan approval gate — review .pipeline/specs.md.');
  console.log('  Approve & continue:  bash .pipeline/orchestrate.sh --continue');
  console.log('  Request changes:     queue a note in .pipeline/followups/planner.txt (or the dashboard follow-up box), then run --continue to re-plan.');
  if (dashboardUrl) console.log(`  Dashboard: ${dashboardUrl}`);
  haltAndExit(0);
}

async function runCoderOnward() {
  if (!(await runCoderStage())) return;
  if (!(await runTesterStage())) return;
  await runReviewerStage();
}

// Everything after the Planner. Single funnel shared by fresh runs, chat
// continues, and interrupted resumes so the approval gate cannot be bypassed
// by any one path. (Task 7 inserts the Designer stage here.)
async function continueAfterPlanner() {
  if (status.flags?.approvePlan && !status.planApproved) requestPlanApproval(); // exits the process
  await runDesignerStage();
  await runCoderOnward();
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
  setStage(name, { model: stageModel });
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

// Git's canonical empty-tree object; diffing against it renders every tracked
// file as an addition, so a repo with no commits yet still yields a real diff.
const GIT_EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function resolveDiffBaseRef(git) {
  // 1. Prefer the commit the run started from (captures committed + uncommitted work).
  const captured = status?.baseRef;
  if (captured && git(['cat-file', '-e', `${captured}^{commit}`]).status === 0) return captured;
  // 2. Fall back to the merge-base with a default branch (for legacy runs missing baseRef).
  for (const branch of ['main', 'master']) {
    const mb = git(['merge-base', 'HEAD', branch]);
    if (mb.status === 0 && mb.stdout.trim()) return mb.stdout.trim();
  }
  // 3. If there is at least one commit, diff the working tree against HEAD.
  if (git(['rev-parse', '--verify', 'HEAD']).status === 0) return 'HEAD';
  // 4. No commit available (fresh repo): diff against the empty tree so all
  //    tracked/staged content is still shown to the reviewer.
  return GIT_EMPTY_TREE;
}

function writeDiffArtifact() {
  const git = (gitArgs) => spawnSync('git', gitArgs, { cwd: workCwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  // No git context at all: don't block the review — point the reviewer at the
  // implementation artifacts and source files instead of a git diff.
  if (git(['rev-parse', '--is-inside-work-tree']).status !== 0) {
    const note = '# diff unavailable (no git repository)\n\nReview the implementation directly from .pipeline/changes.md and the source files it references.\n';
    try { fs.writeFileSync(paths.diff, note); } catch {}
    return;
  }
  const baseRef = resolveDiffBaseRef(git);
  let patch = git(['diff', baseRef]).stdout || '';
  const untracked = (git(['ls-files', '--others', '--exclude-standard']).stdout || '').split('\n').filter(Boolean);
  for (const f of untracked) {
    if (f.startsWith('.pipeline')) continue;
    patch += git(['diff', '--no-index', '/dev/null', f]).stdout || '';
  }
  let shortRef;
  if (baseRef === 'HEAD') shortRef = 'HEAD (working tree)';
  else if (baseRef === GIT_EMPTY_TREE) shortRef = 'empty tree (no commits yet)';
  else shortRef = baseRef.slice(0, 12);
  const body = patch
    ? `# diff vs ${shortRef}\n\n${patch}`
    : '# no changes detected\n\nNo diff against the run baseline. Review the implementation directly from .pipeline/changes.md and the source files it references.\n';
  try { fs.writeFileSync(paths.diff, body); } catch {}
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

function reviewFixCoderTask(pass) {
  return `The Reviewer requested changes (review fix pass ${pass}). Read .pipeline/review_report.md and implement EVERY item listed under "Final Recommendations / Action Items" for the task "${status.task}". Fix the root causes — do NOT weaken, skip, mock, or remove existing tests. Append a "## Review Fix Pass ${pass}" section to .pipeline/changes.md describing each fix and the file paths touched.`;
}

function reviewTesterTask(pass) {
  return `The Reviewer requested changes (review fix pass ${pass}). Read .pipeline/review_report.md and add regression tests that specifically reproduce each reported bug / action item, plus any coverage gaps you notice. Read .pipeline/specs.md and .pipeline/changes.md first. Do NOT weaken existing tests. Append the new coverage to .pipeline/test_suite.md.`;
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

// Design-It-Twice: one read-only Designer invocation explores three design
// postures and locks the public contracts in design.md before any code is
// written. No-op when the stage is skipped (flag off) or already passed.
async function runDesignerStage() {
  const st = stage('designer');
  if (!st || st.status === 'skipped' || st.status === 'passed') return;
  status.resumePoint = { step: 'designer', context: {} };
  setStage('designer', { status: 'running', startedAt: st.startedAt || new Date().toISOString(), cycle: 1 });
  console.log('[Stage] Designer (Design-It-Twice, read-only)...');
  await runStageAgent('designer', `Explore design alternatives and synthesize the final public contracts for this feature:\n\n${status.task}\n\nRead .pipeline/specs.md first. Write your synthesis to .pipeline/design.md.`, {
    readOnly: true,
    chatResume: { step: 'after_designer', context: {} },
  });
  status.resumePoint = { step: 'after_designer', context: {} };
  writeStatus(paths, status);
  requireArtifact('designer', paths.design);
  setStage('designer', { status: 'passed', endedAt: new Date().toISOString(), artifact: 'design.md' });
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

async function runTesterStage(taskOverride = null, chatContext = {}) {
  status.resumePoint = { step: 'tester', context: chatContext };
  setStage('tester', { status: 'running', startedAt: new Date().toISOString(), cycle: 1 });
  console.log(`[Stage] Tester${chatContext.reviewPass ? ` (review fix pass ${chatContext.reviewPass})` : ''}...`);
  const testerTask = taskOverride || `Write rigorous tests for the implementation of: ${status.task}\n\nRead .pipeline/specs.md and .pipeline/changes.md first. Summarize coverage in .pipeline/test_suite.md.`;
  await runStageAgent('tester', testerTask, {
    chatResume: { step: 'after_tester', context: chatContext },
  });
  status.resumePoint = { step: 'after_tester', context: chatContext };
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

// Runs the reviewer agent (read-only audit) then decides what to do with the
// verdict. On APPROVED the run completes; on REQUEST_CHANGES/BLOCK it drops back
// into an automatic Coder + Tester fix pass and re-audits, repeating up to
// status.limits.reviewMax passes before halting as MAX_CYCLES (extendable).
async function runReviewerStage() {
  await runReviewerAudit();
  await afterReviewerAudit();
}

async function runReviewerAudit() {
  // Snapshot the working-tree diff so the dashboard can render the audit
  // surface alongside the review, refreshed for every re-audit.
  writeDiffArtifact();
  const auditCycle = (stage('reviewer').cycle || 0) + 1;
  const pass = status.reviewPass || 0;
  status.resumePoint = { step: 'reviewer', context: { reviewPass: pass } };
  setStage('reviewer', {
    status: 'running',
    startedAt: stage('reviewer').startedAt || new Date().toISOString(),
    cycle: auditCycle,
    maxCycles: status.limits.reviewMax + 1,
  });
  console.log(`[Stage] Reviewer (read-only audit${pass > 0 ? `, after fix pass ${pass}` : ''})...`);
  await runStageAgent('reviewer', `Audit the completed implementation of: ${status.task}\n\nRead .pipeline/specs.md, .pipeline/changes.md and .pipeline/test_suite.md, read .pipeline/diff.patch (or audit the source files directly if no diff is available), and write your verdict to .pipeline/review_report.md.`, {
    readOnly: true,
    chatResume: { step: 'after_reviewer', context: { reviewPass: pass } },
  });
  status.resumePoint = { step: 'after_reviewer', context: { reviewPass: pass } };
  writeStatus(paths, status);
}

// Parse the verdict, update the reviewer badge, and either finish (APPROVED) or
// drive the next automatic fix pass. In chat mode the fix-pass agents hand off,
// so the tail of this function is only reached in CLI/cli-resume execution.
async function afterReviewerAudit() {
  requireArtifact('reviewer', paths.reviewReport);
  const report = fs.readFileSync(paths.reviewReport, 'utf8');
  const verdictMatch = report.match(/##\s*Verdict:\s*\[?\s*(APPROVED|REQUEST_CHANGES|BLOCK)/i);
  status.verdict = verdictMatch ? verdictMatch[1].toUpperCase() : 'UNKNOWN';
  const approved = status.verdict === 'APPROVED';
  setStage('reviewer', { status: approved ? 'passed' : 'failed', endedAt: new Date().toISOString(), artifact: 'review_report.md', detail: `Verdict: ${status.verdict}` });

  if (approved) return finishApproved();

  if ((status.reviewPass || 0) >= status.limits.reviewMax) {
    haltMaxCycles('review', 'reviewer', status.limits.reviewMax);
    return;
  }

  status.reviewPass = (status.reviewPass || 0) + 1;
  const prevVerdict = status.verdict;
  status.verdict = null; // Clear the verdict for the new pass

  // Reset the tester and reviewer stages so they are not shown as stale passed/failed in the UI/status
  setStage('tester', { status: 'pending', cycle: 0, startedAt: null, endedAt: null, artifact: null, detail: null, checks: null });
  setStage('reviewer', { status: 'pending', cycle: 0, startedAt: null, endedAt: null, artifact: null, detail: null });

  writeStatus(paths, status);
  appendEvent(paths, { stage: 'reviewer', type: 'review_fix_start', pass: status.reviewPass, verdict: prevVerdict });
  console.log(`[Orchestrator] Verdict ${prevVerdict} — starting automatic review fix pass ${status.reviewPass}/${status.limits.reviewMax}.`);
  await runReviewFixPass(status.reviewPass);
}

function finishApproved() {
  status.overall = 'done';
  status.chatResume = null;
  status.resumePoint = null;
  finalize();
  console.log(`\n[Orchestrator] Pipeline complete. Verdict: ${status.verdict}`);
  console.log(`Review: ${path.relative(repoRoot, paths.reviewReport)}`);
  haltAndExit(0);
}

// One automatic fix pass: Coder applies the reviewer's action items, then the
// Tester adds regression tests and the checker/post-tester loop validates the
// fix, then the Reviewer re-audits. Each composed call hands off in chat mode,
// so control naturally returns to the --continue chain there.
async function invokeReviewCoderCycle(pass) {
  status.resumePoint = { step: 'coder', context: { loop: 'review', reviewPass: pass } };
  setStage('coder', { status: 'running', startedAt: new Date().toISOString(), cycle: 1, maxCycles: 1, detail: `Review fix pass ${pass}` });
  console.log(`[Stage] Coder (review fix pass ${pass}/${status.limits.reviewMax})...`);
  await runStageAgent('coder', reviewFixCoderTask(pass), {
    cycle: 1,
    chatResume: { step: 'after_coder', context: { loop: 'review', reviewPass: pass } },
  });
  status.resumePoint = { step: 'after_coder', context: { loop: 'review', reviewPass: pass } };
  writeStatus(paths, status);
}

async function runReviewFixPass(pass) {
  await invokeReviewCoderCycle(pass);
  setStage('coder', { status: 'passed', endedAt: new Date().toISOString(), artifact: 'changes.md' });
  if (!(await runTesterStage(reviewTesterTask(pass), { reviewPass: pass }))) return;
  await runReviewerStage();
}

async function planApprovalContinueRun() {
  requireArtifact('planner', paths.specs); // spec deleted/emptied while gated → MISSING_ARTIFACT
  const followupFile = path.join(paths.dir, 'followups', 'planner.txt');
  let hasFollowup = false;
  try { hasFollowup = fs.readFileSync(followupFile, 'utf8').trim().length > 0; } catch {}
  appendEvent(paths, { stage: 'orchestrator', type: hasFollowup ? 'plan_revision_start' : 'plan_approved' });
  if (hasFollowup) {
    console.log('[Orchestrator] Plan revision requested — re-running Planner with the queued follow-up note.');
    status.planApproved = false;
    await runPlannerStage(); // consumeFollowups injects & clears the note; hands off in chat mode
    await continueAfterPlanner(); // CLI mode: gate re-arms here
    return;
  }
  console.log('[Orchestrator] Plan approved — continuing pipeline.');
  status.planApproved = true;
  writeStatus(paths, status);
  await continueAfterPlanner();
}

async function chatContinueRun() {
  const resume = status.chatResume;
  status.chatResume = null;

  let actualModel = null;
  try {
    const handoff = JSON.parse(fs.readFileSync(paths.stageHandoff, 'utf8'));
    if (handoff.actualModel) actualModel = handoff.actualModel;
  } catch {}

  try { fs.unlinkSync(paths.stageHandoff); } catch {}

  const step = resume.step;
  const context = resume.context || {};

  const completedStage = step === 'after_planner' ? 'planner' :
                        step === 'after_coder' ? 'coder' :
                        step === 'after_tester' ? 'tester' :
                        step === 'after_reviewer' ? 'reviewer' : null;
  if (completedStage && actualModel) {
    setStage(completedStage, { model: actualModel });
  }

  if (step === 'after_planner') {
    requireArtifact('planner', paths.specs);
    setStage('planner', { status: 'passed', endedAt: new Date().toISOString(), artifact: 'specs.md' });
    await continueAfterPlanner();
    return;
  }

  if (step === 'after_designer') {
    requireArtifact('designer', paths.design);
    setStage('designer', { status: 'passed', endedAt: new Date().toISOString(), artifact: 'design.md' });
    await runCoderOnward();
    return;
  }

  if (step === 'after_coder') {
    // Review fix pass: the Coder just applied the reviewer's action items. Skip
    // the coder's own checker gate (the Tester stage's post-tester loop validates
    // the fix) and hand off to the Tester for regression coverage.
    if (context.loop === 'review') {
      const pass = context.reviewPass ?? status.reviewPass;
      setStage('coder', { status: 'passed', endedAt: new Date().toISOString(), artifact: 'changes.md' });
      if (!(await runTesterStage(reviewTesterTask(pass), { reviewPass: pass }))) return;
      await runReviewerStage();
      return;
    }
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
    await afterReviewerAudit();
    return;
  }

  halt('orchestrator', 'AGENT_ERROR', `Unknown chat resume step "${step}".`);
}

async function freshRun() {
  await runPlannerStage();
  await continueAfterPlanner();
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
  const designer = stage('designer');
  if (designer && designer.status !== 'passed' && designer.status !== 'skipped') {
    return { step: 'designer', context: {} };
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
  status.limits = status.limits || { coderMax: config.maxCoderCycles, postTesterMax: config.maxPostTesterCycles, reviewMax: config.maxReviewCycles };
  if (status.limits.reviewMax == null) status.limits.reviewMax = config.maxReviewCycles;
  if (status.reviewPass == null) status.reviewPass = 0;
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
    await continueAfterPlanner();
    return;
  }

  if (step === 'after_planner') {
    requireArtifact('planner', paths.specs);
    setStage('planner', { status: 'passed', endedAt: new Date().toISOString(), artifact: 'specs.md' });
    await continueAfterPlanner();
    return;
  }

  if (step === 'designer') {
    await runDesignerStage();
    await runCoderOnward();
    return;
  }

  if (step === 'after_designer') {
    requireArtifact('designer', paths.design);
    setStage('designer', { status: 'passed', endedAt: new Date().toISOString(), artifact: 'design.md' });
    await runCoderOnward();
    return;
  }

  if (step === 'plan_approval') { requestPlanApproval(); return; }

  if (step === 'coder') {
    if (loop === 'review') {
      await runReviewFixPass(context.reviewPass ?? status.reviewPass);
      return;
    }
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
    if (loop === 'review') {
      const pass = context.reviewPass ?? status.reviewPass;
      setStage('coder', { status: 'passed', endedAt: new Date().toISOString(), artifact: 'changes.md' });
      if (!(await runTesterStage(reviewTesterTask(pass), { reviewPass: pass }))) return;
      await runReviewerStage();
      return;
    }
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
    await afterReviewerAudit();
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
  } else if (phase === 'review') {
    // Extend the automatic review-fix budget and drive another fix pass from the
    // last (still non-APPROVED) audit, then keep looping until APPROVED/exhausted.
    status.limits.reviewMax += args.extend;
    setStage('reviewer', { status: 'running', detail: null });
    await afterReviewerAudit();
  } else {
    console.error(`[Orchestrator] Cannot resume: unknown halted phase "${phase}".`);
    haltAndExit(1);
  }
}

(args.continue ? (planApprovalPending ? planApprovalContinueRun() : chatContinueRun()) : args.resume ? (args.extend !== null ? resumeRun() : resumeInterruptedRun()) : freshRun()).catch((err) => {
  console.error('[Orchestrator] Uncaught error:', err);
  if (status) { status.overall = 'halted'; status.haltReason = 'AGENT_ERROR'; finalize(); }
  haltAndExit(1);
});
