#!/usr/bin/env node
// `orchestrate.sh doctor [--json] [--all]`: say, for every run in this
// project, what state it is in, why, who it waits on and what would fix it.
// Needs no dashboard server and no desktop app.
//
// Exit codes: 0 nothing needs attention, 1 something does, 2 not a project.
import fs from 'node:fs';
import path from 'node:path';
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
  const args = { repo: process.cwd(), json: false, all: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repo') args.repo = path.resolve(argv[++i] || '.');
    else if (argv[i] === '--json') args.json = true;
    else if (argv[i] === '--all') args.all = true;
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

export function main(argv = process.argv.slice(2)) {
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
    runs.push({ runId: summary.runId, title: summary.title, bucket: summary.bucket, diagnosis: summary.diagnosis });
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

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) process.exit(main());
