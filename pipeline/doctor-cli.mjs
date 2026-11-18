#!/usr/bin/env node
// `orchestrate.sh doctor [--json] [--all]`: say, for every run in this
// project, what state it is in, why, who it waits on and what would fix it.
// Needs no dashboard server and no desktop app.
//
// With --fix it also applies the remedies the doctor calls safe, after
// confirmation (--yes, or an interactive yes). It never approves a plan, stops a
// run, or does anything that needs a person's call.
//
// Exit codes: 0 nothing needs attention (or the fixes ran), 1 something does,
// 2 not a project.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pipelinePaths, loadConfig } from './state.mjs';
import { listRunIdsOf, readRunSummary } from './run-reader.mjs';

export function needsAttention(diagnosis) {
  if (['finished', 'healthy'].includes(diagnosis.state)) return false;
  // Waiting on a live chat session is somebody else's move, not yours.
  if (diagnosis.state === 'waiting' && diagnosis.waitingOn !== 'you') return false;
  return true;
}

function parse(argv) {
  const args = { repo: process.cwd(), json: false, all: false, fix: false, yes: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repo') args.repo = path.resolve(argv[++i] || '.');
    else if (argv[i] === '--json') args.json = true;
    else if (argv[i] === '--all') args.all = true;
    else if (argv[i] === '--fix') args.fix = true;
    else if (argv[i] === '--yes' || argv[i] === '-y') args.yes = true;
  }
  return args;
}

function render(entry) {
  const d = entry.diagnosis;
  const lines = [`${entry.runId}  [${d.state}]  ${entry.title || ''}`.trimEnd(), `  ${d.explanation}`];
  if (d.waitingOn) lines.push(`  Waiting on: ${d.waitingOn}${d.since ? ` (since ${d.since})` : ''}`);
  for (const e of d.evidence) lines.push(`  · ${e}`);
  for (const r of d.remedies) {
    lines.push(`  → ${r.verb}${r.safe ? '' : ' (needs your call)'}: ${r.reason}${r.shell ? `\n      ${r.shell}` : ''}${r.command ? `\n      command: ${r.command}` : ''}`);
  }
  return lines.join('\n');
}

const flagsFor = (runId) => (runId === 'root' ? [] : ['--run-id', runId]);

/**
 * The commands that would apply every safe remedy, as a person would type them.
 * Only remedies the doctor marks `safe` are considered; anything that needs a
 * person's call (approving a plan, stopping a run, a ticket retry) is left out.
 * The supervisor comes first, and a command shared by several runs appears once.
 */
export function fixPlan(entries, { maxCycles = 5 } = {}) {
  const plan = [];
  const seen = new Set();
  const add = (runId, verb, argv, reason) => {
    const key = argv.join('\0');
    if (seen.has(key)) return;
    seen.add(key);
    plan.push({ runId, verb, argv, reason });
  };
  const bootstrap = [];
  const perRun = [];
  for (const e of entries) {
    for (const r of e.diagnosis.remedies) {
      if (!r.safe) continue;
      const pooled = !!e.featureId;
      if (r.verb === 'start-supervisor') bootstrap.push([e.runId, r.verb, ['pool', 'start'], r.reason]);
      else if (r.verb === 'resume-pool') bootstrap.push([e.runId, r.verb, ['pool', 'resume'], r.reason]);
      else if (r.verb === 'resume') {
        perRun.push([e.runId, r.verb, pooled ? ['pool', 'resume-run', e.runId] : ['--resume', ...flagsFor(e.runId)], r.reason]);
      } else if (r.verb === 'extend') {
        perRun.push([e.runId, r.verb, pooled ? ['pool', 'extend', e.runId, String(maxCycles)] : ['--resume', '--extend', String(maxCycles), ...flagsFor(e.runId)], r.reason]);
      }
    }
  }
  for (const item of [...bootstrap, ...perRun]) add(...item);
  return plan;
}

// Engine resumes run the whole pipeline in the foreground; start those detached,
// log to a file, and wait only long enough to catch an immediate failure.
async function runOne(repo, argv) {
  const script = path.join(repo, '.pipeline', 'orchestrate.sh');
  if (argv[0] === 'pool') {
    const res = spawnSync('bash', [script, ...argv], { cwd: repo, encoding: 'utf8' });
    return { ok: res.status === 0, detail: (res.stderr || res.stdout || '').trim().split('\n').pop() };
  }
  const out = fs.openSync(path.join(repo, '.pipeline', 'doctor-fix.out'), 'a');
  const child = spawn('bash', [script, ...argv], { cwd: repo, detached: true, stdio: ['ignore', out, out] });
  const settled = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ running: true }), 2000);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code }); });
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: 1, error: err.message }); });
  });
  child.unref();
  fs.closeSync(out);
  if (settled.running) return { ok: true, detail: `started (pid ${child.pid}); output in .pipeline/doctor-fix.out` };
  return { ok: settled.code === 0, detail: settled.error || `exited ${settled.code}; see .pipeline/doctor-fix.out` };
}

function confirm(question) {
  if (!process.stdin.isTTY) return false;
  process.stderr.write(`${question} [y/N] `);
  const buf = Buffer.alloc(64);
  const n = fs.readSync(0, buf, 0, 64, null);
  return /^y(es)?$/i.test(buf.toString('utf8', 0, n).trim());
}

async function applyFixes(args, runs, config) {
  const plan = fixPlan(runs, { maxCycles: config.maxCoderCycles ?? 5 });
  if (!plan.length) { console.log('Nothing safe to fix automatically; the rest needs your call.'); return null; }
  console.log('Safe fixes:');
  for (const p of plan) console.log(`  ${p.runId}: bash .pipeline/orchestrate.sh ${p.argv.join(' ')}   (${p.reason})`);
  if (!args.yes && !confirm(`Apply ${plan.length} fix${plan.length === 1 ? '' : 'es'}?`)) {
    console.error('Not applied. Re-run with --yes to apply them.');
    return 1;
  }
  let ok = 0;
  for (const p of plan) {
    const res = await runOne(args.repo, p.argv);
    console.log(`  ${res.ok ? '✓' : '✗'} ${p.argv.join(' ')}: ${res.detail || 'done'}`);
    if (res.ok) ok += 1;
  }
  console.log(`Ran ${ok} of ${plan.length}. Run doctor again to confirm.`);
  return ok === plan.length ? 0 : 1;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parse(argv);
  if (!fs.existsSync(path.join(args.repo, '.pipeline'))) {
    console.error(`doctor: no .pipeline directory in ${args.repo}; this is not an orchestrator project.`);
    return 2;
  }
  const config = loadConfig(pipelinePaths(args.repo));
  const runs = [];
  for (const id of listRunIdsOf(args.repo)) {
    const read = readRunSummary(args.repo, id, { config });
    if (!read) continue;
    const { summary } = read;
    runs.push({ runId: summary.runId, title: summary.title, bucket: summary.bucket, featureId: summary.featureId, diagnosis: summary.diagnosis });
  }
  if (args.fix) {
    const code = await applyFixes(args, runs.filter((r) => needsAttention(r.diagnosis)), config);
    if (code !== null) return code;
  }
  const shown = runs.filter((r) => args.all || needsAttention(r.diagnosis));
  const attention = runs.filter((r) => needsAttention(r.diagnosis)).length;
  if (args.json) {
    console.log(JSON.stringify({ runs: shown, needsAttention: attention, total: runs.length }, null, 2));
  } else if (!shown.length) {
    console.log(`Nothing needs attention (${runs.length} run${runs.length === 1 ? '' : 's'} checked).`);
  } else {
    console.log(shown.map(render).join('\n\n'));
    console.log(`\n${attention} of ${runs.length} run${runs.length === 1 ? '' : 's'} need attention.`);
  }
  return attention ? 1 : 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) process.exit(await main());
