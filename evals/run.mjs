#!/usr/bin/env node
// Eval driver: run the pipeline against fixture repos and score the outcome.
//
// Every task runs in a throwaway copy of its fixture, with the pipeline
// installed into it, so evals never touch the working tree and one task's mess
// cannot leak into the next. Real agents are invoked — this costs tokens.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scoreRun, aggregate } from './score.mjs';
import { parseTestCounts } from '../pipeline/checker.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const args = { task: null, runner: null, modelProfile: 'auto', models: null, repeat: 1, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--task') args.task = argv[++i];
    else if (a === '--runner') args.runner = argv[++i];
    else if (a === '--model-profile') args.modelProfile = argv[++i];
    else if (a === '--models') args.models = argv[++i];
    else if (a === '--repeat') args.repeat = parseInt(argv[++i], 10) || 1;
    else if (a === '--keep') args.keep = true;
    else if (a === '--help' || a === '-h') { console.log(USAGE); process.exit(0); }
  }
  return args;
}

const USAGE = `Usage: node evals/run.mjs [--task <id>] [--runner claude|cursor|codex|gemini]
                         [--model-profile auto|manual] [--models JSON]
                         [--repeat n] [--keep]

Runs real agents against fixture repos and scores the results. Costs tokens.`;

function loadTasks(filter) {
  const dir = path.join(__dirname, 'tasks');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  const tasks = files.map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  return filter ? tasks.filter((t) => t.id === filter) : tasks;
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

const git = (args, cwd) => spawnSync('git', args, { cwd, encoding: 'utf8' });

// A fixture becomes a real git repo with one commit so the orchestrator's
// baseRef diff scoping — and our changed-files assertion — both work.
function prepareWorkspace(task) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), `eval-${task.id}-`));
  copyDir(path.join(__dirname, 'fixtures', task.fixture), ws);
  // The engine is NOT copied in: it is run from the source repo with cwd set to
  // the workspace. Copying pipeline/ here would put the orchestrator's own
  // *.test.mjs inside the fixture, where `node --test` discovers them and every
  // test count the regression and weakening guards compare becomes meaningless.
  fs.mkdirSync(path.join(ws, '.pipeline'), { recursive: true });
  copyDir(path.join(repoRoot, '.pipeline', 'prompts'), path.join(ws, '.pipeline', 'prompts'));
  fs.copyFileSync(path.join(repoRoot, '.pipeline', 'config.json'), path.join(ws, '.pipeline', 'config.json'));

  git(['init', '-q'], ws);
  git(['add', '-A'], ws);
  git(['-c', 'user.email=eval@local', '-c', 'user.name=eval', 'commit', '-q', '-m', 'fixture'], ws);
  return ws;
}

function baselineTestCount(ws) {
  const res = spawnSync('npm', ['test', '--silent'], { cwd: ws, encoding: 'utf8', timeout: 120000 });
  const out = `${res.stdout || ''}\n${res.stderr || ''}`;
  const counts = parseTestCounts(out);
  return counts.passedCount === null ? null : counts.passedCount + counts.failedCount;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function changedFiles(ws) {
  const res = git(['diff', '--name-only', 'HEAD'], ws);
  const tracked = (res.stdout || '').split('\n').filter(Boolean);
  const untracked = (git(['ls-files', '--others', '--exclude-standard'], ws).stdout || '').split('\n').filter(Boolean);
  // Pipeline scaffolding is not part of what the task was asked to change.
  return [...tracked, ...untracked].filter((f) => !f.startsWith('.pipeline'));
}

function runPipeline(ws, task, args) {
  const nodeArgs = [
    path.join(repoRoot, 'pipeline', 'orchestrator.mjs'),
    '--task', task.task,
    '--mode', 'cli',
    '--model-profile', args.modelProfile,
  ];
  if (args.models) nodeArgs.push('--models', args.models);
  if (args.runner) nodeArgs.push('--runner', args.runner);
  const started = Date.now();
  const res = spawnSync(process.execPath, nodeArgs, {
    cwd: ws,
    encoding: 'utf8',
    // Evals must never open a dashboard or fight over its port.
    env: { ...process.env, PIPELINE_UI_PORT: 'disabled', ORCH_ALLOW_SELF: '1' },
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60 * 60 * 1000,
  });
  return { exitCode: res.status, durationMs: Date.now() - started, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function costOf(ws) {
  const raw = readText(path.join(ws, '.pipeline', 'events.jsonl'));
  let total = 0;
  for (const line of raw.split('\n')) {
    if (!line.includes('costUsd')) continue;
    try { const ev = JSON.parse(line); if (typeof ev.costUsd === 'number') total += ev.costUsd; } catch {}
  }
  return total;
}

async function runOne(task, args, attempt) {
  const ws = prepareWorkspace(task);
  const before = baselineTestCount(ws);
  process.stdout.write(`  ${task.id} (run ${attempt})… `);
  const proc = runPipeline(ws, task, args);

  const status = readJson(path.join(ws, '.pipeline', 'status.json'));
  const after = baselineTestCount(ws);
  const coder = status?.stages?.find((s) => s.name === 'coder');
  const outcome = {
    status,
    reviewReport: readText(path.join(ws, '.pipeline', 'review_report.md')),
    changedFiles: changedFiles(ws),
    checks: coder?.checks ? { ...coder.checks } : null,
    testCounts: { before, after },
  };
  const scored = scoreRun(task.assertions, outcome);
  const record = {
    task: task.id, attempt, ...scored,
    costUsd: costOf(ws),
    durationMs: proc.durationMs,
    exitCode: proc.exitCode,
    haltReason: status?.haltReason ?? null,
    verdict: status?.verdict ?? null,
    workspace: args.keep ? ws : undefined,
  };
  console.log(`${scored.passed ? 'PASS' : 'FAIL'} (${(scored.score * 100).toFixed(0)}%, ${Math.round(proc.durationMs / 1000)}s${record.costUsd ? `, $${record.costUsd.toFixed(2)}` : ''})`);
  if (!scored.passed) {
    for (const r of scored.results.filter((x) => !x.ok)) console.log(`      ✗ ${r.name}: ${r.detail}`);
  }
  if (!args.keep) fs.rmSync(ws, { recursive: true, force: true });
  return record;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tasks = loadTasks(args.task);
  if (!tasks.length) {
    console.error(args.task ? `No task with id "${args.task}".` : 'No tasks found under evals/tasks/.');
    process.exit(2);
  }
  console.log(`Running ${tasks.length} task(s) × ${args.repeat} — real agents, real tokens.\n`);

  const all = [];
  for (const task of tasks) {
    console.log(`▸ ${task.id}: ${task.task}`);
    const runs = [];
    for (let i = 1; i <= args.repeat; i++) runs.push(await runOne(task, args, i));
    all.push({ task: task.id, runs, summary: aggregate(runs) });
    console.log('');
  }

  const resultsDir = path.join(__dirname, 'results');
  fs.mkdirSync(resultsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(resultsDir, `${stamp}.json`);
  const config = { runner: args.runner || 'auto', modelProfile: args.modelProfile, models: args.models, repeat: args.repeat };
  fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), config, tasks: all }, null, 2));

  console.log('─'.repeat(64));
  console.log('task'.padEnd(28) + 'pass'.padEnd(8) + 'score'.padEnd(8) + 'cost');
  for (const t of all) {
    const s = t.summary;
    console.log(
      t.task.slice(0, 27).padEnd(28) +
      `${(s.passRate * 100).toFixed(0)}%`.padEnd(8) +
      `${(s.meanScore * 100).toFixed(0)}%`.padEnd(8) +
      (s.meanCostUsd ? `$${s.meanCostUsd.toFixed(2)}` : '—'));
  }
  const overall = all.reduce((a, t) => a + t.summary.passRate, 0) / all.length;
  console.log('─'.repeat(64));
  console.log(`overall pass rate: ${(overall * 100).toFixed(0)}%`);
  console.log(`results: ${path.relative(repoRoot, file)}`);
  process.exit(overall === 1 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
