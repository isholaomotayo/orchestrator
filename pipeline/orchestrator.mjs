#!/usr/bin/env node
// Unified pipeline orchestrator:
//   Planner -> Coder (self-healing builder-checker loop) -> Tester -> Reviewer
// Guardrails: mutex lock, max fix cycles, regression halt, artifact validation,
// optional git-worktree sandbox. State is mirrored to .pipeline/status.json and
// .pipeline/events.jsonl for the live dashboard.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { pipelinePaths, loadConfig, newStatus, writeStatus, appendEvent } from './state.mjs';
import { runChecks } from './checker.mjs';
import { runAgent, detectRunner } from './adapters.mjs';

function parseArgs(argv) {
  const args = { task: null, runner: null, sandbox: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--task') args.task = argv[++i];
    else if (argv[i] === '--runner') args.runner = argv[++i];
    else if (argv[i] === '--sandbox') args.sandbox = true;
    else if (!args.task && !argv[i].startsWith('--')) args.task = argv[i];
  }
  return args;
}

const repoRoot = process.cwd();
const paths = pipelinePaths(repoRoot);
const config = loadConfig(paths);
const args = parseArgs(process.argv.slice(2));

if (!args.task) {
  console.error('Usage: node pipeline/orchestrator.mjs --task "description" [--runner claude|cursor|codex|gemini] [--sandbox]');
  process.exit(2);
}
if (args.runner) config.runner = args.runner;

// ---- Guardrail 3: mutex lock -----------------------------------------------
if (fs.existsSync(paths.lock)) {
  console.error('[Orchestrator] Pipeline execution is locked by another running agent.');
  console.error(`Remove '${paths.lock}' if this is stale.`);
  process.exit(1);
}
fs.mkdirSync(paths.dir, { recursive: true });
fs.writeFileSync(paths.lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));

let status;
function releaseLock() {
  try { fs.unlinkSync(paths.lock); } catch {}
}
function haltAndExit(code) {
  releaseLock();
  process.exit(code);
}
process.on('SIGINT', () => { if (status) { status.overall = 'halted'; status.haltReason = status.haltReason || 'INTERRUPTED'; finalize(); } haltAndExit(130); });
process.on('SIGTERM', () => haltAndExit(143));
process.on('exit', releaseLock);

// ---- Guardrail 1: sandbox worktree ------------------------------------------
let workCwd = repoRoot;
if (args.sandbox) {
  const sandbox = path.join(repoRoot, '.pipeline_sandbox');
  console.log('[Orchestrator] Isolating workspace in git worktree sandbox...');
  try { execSync(`git worktree remove "${sandbox}" --force`, { cwd: repoRoot, stdio: 'ignore' }); } catch {}
  try { execSync('git branch -D tmp-pipeline-branch', { cwd: repoRoot, stdio: 'ignore' }); } catch {}
  execSync(`git worktree add "${sandbox}" -b tmp-pipeline-branch`, { cwd: repoRoot, stdio: 'inherit' });
  // Point the sandbox's .pipeline at the main one so all artifacts/logs land in
  // a single place the UI server is watching.
  const sandboxPipeline = path.join(sandbox, '.pipeline');
  fs.rmSync(sandboxPipeline, { recursive: true, force: true });
  fs.symlinkSync(paths.dir, sandboxPipeline, 'dir');
  workCwd = sandbox;
}

// ---- Fresh-run reset ---------------------------------------------------------
for (const f of [paths.specs, paths.changes, paths.checkerReport, paths.testSuite, paths.reviewReport, paths.testHistory, paths.events]) {
  try { fs.unlinkSync(f); } catch {}
}
fs.rmSync(paths.logs, { recursive: true, force: true });
fs.writeFileSync(paths.vagueRequest, args.task);

const runner = detectRunner(config);
status = newStatus(args.task);
status.runner = runner;
status.sandbox = args.sandbox;
const coderStage = status.stages.find((s) => s.name === 'coder');
coderStage.maxCycles = config.maxCoderCycles;
writeStatus(paths, status);
appendEvent(paths, { stage: 'orchestrator', type: 'pipeline_start', task: args.task, runner });
console.log(`[Orchestrator] Pipeline started (runner=${runner}, sandbox=${args.sandbox}). Dashboard: http://localhost:${config.uiPort}`);

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
function artifactOk(file) {
  try { return fs.statSync(file).size > 0; } catch { return false; }
}
function requireArtifact(stageName, file) {
  if (!artifactOk(file)) halt(stageName, 'MISSING_ARTIFACT', `${stageName} did not produce ${path.relative(repoRoot, file)}`);
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

async function runStageAgent(name, task, { cycle = 1, readOnly = false } = {}) {
  const promptFile = path.join(paths.prompts, `${name === 'coder' ? 'coder' : name}_prompt.txt`);
  const followup = consumeFollowups(name);
  if (followup) task += `\n\nHUMAN FOLLOW-UP NOTES (address these):\n${followup}`;
  const res = await runAgent({ runner, stage: name, cycle, task, systemPromptFile: promptFile, cwd: workCwd, readOnly, paths, config });
  if (!res.ok && res.error) halt(name, 'AGENT_ERROR', `${runner} CLI failed: ${res.error}`);
  return res;
}

const history = { coder: [], postTester: [] };
function saveHistory() { fs.writeFileSync(paths.testHistory, JSON.stringify(history, null, 2)); }

// Returns 'pass' | 'continue', or halts the process on regression.
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

async function main() {
  // ---- Stage 1: PLANNER ------------------------------------------------------
  setStage('planner', { status: 'running', startedAt: new Date().toISOString(), cycle: 1 });
  console.log('[Stage] Planner...');
  await runStageAgent('planner', `Produce a technical specification for this feature request:\n\n${args.task}\n\nThe raw request is also in .pipeline/vague_request.txt. Write the spec to .pipeline/specs.md.`);
  requireArtifact('planner', paths.specs);
  setStage('planner', { status: 'passed', endedAt: new Date().toISOString(), artifact: 'specs.md' });

  // ---- Stage 2: CODER (self-healing builder-checker loop) --------------------
  setStage('coder', { status: 'running', startedAt: new Date().toISOString() });
  let green = false;
  for (let cycle = 1; cycle <= config.maxCoderCycles; cycle++) {
    setStage('coder', { cycle });
    console.log(`[Stage] Coder — fix cycle ${cycle}/${config.maxCoderCycles}...`);
    const task = cycle === 1
      ? `Implement the specification in .pipeline/specs.md for this feature request:\n\n${args.task}\n\nDocument your work in .pipeline/changes.md.`
      : `Fix cycle ${cycle}: the checker found failures. Read .pipeline/checker_report.md, fix the root causes for the task "${args.task}", and append a "## Fix Cycle ${cycle}" section to .pipeline/changes.md. Do NOT weaken or remove tests.`;
    await runStageAgent('coder', task, { cycle });
    requireArtifact('coder', paths.changes);

    console.log('[Checker] Running verification (test / lint / typecheck)...');
    appendEvent(paths, { stage: 'coder', cycle, type: 'checks_start' });
    const check = runChecks({ cwd: workCwd, config, paths });
    console.log(`[Checker] ${check.isPassed ? 'PASS' : 'FAIL'} — ${check.passedCount} passed, ${check.failedCount} failed`);
    if (evaluateChecks('coder', 'coder', check) === 'pass') { green = true; break; }
  }
  if (!green) {
    halt('coder', 'MAX_CYCLES', `Coder loop reached ${config.maxCoderCycles} cycles without passing verification. Inspect .pipeline/checker_report.md and .pipeline/changes.md.`);
  }
  setStage('coder', { status: 'passed', endedAt: new Date().toISOString(), artifact: 'changes.md' });

  // ---- Stage 3: TESTER --------------------------------------------------------
  setStage('tester', { status: 'running', startedAt: new Date().toISOString(), cycle: 1 });
  console.log('[Stage] Tester...');
  await runStageAgent('tester', `Write rigorous tests for the implementation of: ${args.task}\n\nRead .pipeline/specs.md and .pipeline/changes.md first. Summarize coverage in .pipeline/test_suite.md.`);
  requireArtifact('tester', paths.testSuite);

  console.log('[Checker] Re-running full suite with the new tests...');
  let check = runChecks({ cwd: workCwd, config, paths });
  console.log(`[Checker] ${check.isPassed ? 'PASS' : 'FAIL'} — ${check.passedCount} passed, ${check.failedCount} failed`);
  if (!check.isPassed) {
    // New tests exposed bugs — bounce back to the Coder for a bounded number of cycles.
    history.postTester.push({ passedCount: check.passedCount, failedCount: check.failedCount, isPassed: false, at: new Date().toISOString() });
    saveHistory();
    let fixed = false;
    for (let cycle = 1; cycle <= config.maxPostTesterCycles; cycle++) {
      const totalCycle = config.maxCoderCycles + cycle;
      setStage('coder', { status: 'running', cycle: totalCycle, maxCycles: config.maxCoderCycles + config.maxPostTesterCycles });
      console.log(`[Stage] Coder (post-tester fix) — cycle ${cycle}/${config.maxPostTesterCycles}...`);
      await runStageAgent('coder', `The Tester added new tests that expose failures. Read .pipeline/checker_report.md, fix the root causes for the task "${args.task}", and append a "## Post-Tester Fix Cycle ${cycle}" section to .pipeline/changes.md. Do NOT weaken or remove the new tests.`, { cycle: totalCycle });
      check = runChecks({ cwd: workCwd, config, paths });
      console.log(`[Checker] ${check.isPassed ? 'PASS' : 'FAIL'} — ${check.passedCount} passed, ${check.failedCount} failed`);
      if (evaluateChecks('postTester', 'tester', check) === 'pass') { fixed = true; break; }
    }
    if (!fixed) {
      halt('tester', 'MAX_CYCLES', `New tests still failing after ${config.maxPostTesterCycles} post-tester fix cycles. Human intervention required.`);
    }
    setStage('coder', { status: 'passed' });
  }
  setStage('tester', { status: 'passed', endedAt: new Date().toISOString(), artifact: 'test_suite.md', checks: { passedCount: check.passedCount, failedCount: check.failedCount, isPassed: true } });

  // ---- Stage 4: REVIEWER (read-only) -------------------------------------------
  setStage('reviewer', { status: 'running', startedAt: new Date().toISOString(), cycle: 1 });
  console.log('[Stage] Reviewer (read-only audit)...');
  await runStageAgent('reviewer', `Audit the completed implementation of: ${args.task}\n\nRead .pipeline/specs.md, .pipeline/changes.md and .pipeline/test_suite.md, run git diff, and write your verdict to .pipeline/review_report.md.`, { readOnly: true });
  requireArtifact('reviewer', paths.reviewReport);
  const report = fs.readFileSync(paths.reviewReport, 'utf8');
  const verdictMatch = report.match(/##\s*Verdict:\s*\[?\s*(APPROVED|REQUEST_CHANGES|BLOCK)/i);
  status.verdict = verdictMatch ? verdictMatch[1].toUpperCase() : 'UNKNOWN';
  setStage('reviewer', { status: status.verdict === 'APPROVED' ? 'passed' : 'failed', endedAt: new Date().toISOString(), artifact: 'review_report.md', detail: `Verdict: ${status.verdict}` });

  status.overall = 'done';
  finalize();
  console.log(`\n[Orchestrator] Pipeline complete. Verdict: ${status.verdict}`);
  console.log(`Review: ${path.relative(repoRoot, paths.reviewReport)}`);
  haltAndExit(status.verdict === 'APPROVED' ? 0 : 1);
}

main().catch((err) => {
  console.error('[Orchestrator] Uncaught error:', err);
  if (status) { status.overall = 'halted'; status.haltReason = 'AGENT_ERROR'; finalize(); }
  haltAndExit(1);
});
