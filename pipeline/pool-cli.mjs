#!/usr/bin/env node
// The `pool` verbs, as a command line.
//
// Exit codes are part of the contract, because both a human and an agent read
// them: 0 ok, 1 error, 2 usage, 3 self-target guard, 4 no supervisor running.
import fs from 'node:fs';
import path from 'node:path';
import { pipelinePaths, loadConfig } from './state.mjs';
import { isOrchestratorSourceRepo, selfTargetAllowed, selfGuardMessage } from './self-guard.mjs';
import * as pool from './pool.mjs';
import { renderDigest } from './snapshot.mjs';

const USAGE = `Usage: node pipeline/pool.mjs <verb> [options]

Reading:
  status [--json]              the pool snapshot
  digest                       the four-section status digest
  attention [--pending] [--json]
  decisions [--open] [--json]

Roadmap:
  roadmap compile              compile .pipeline/roadmap.md into control state
  roadmap show [--json]
  roadmap hold <id> [why]      |  roadmap release <id>  |  roadmap skip <id> [why]

Acting:
  decide <decisionId> "<answer>"
  approve-plan <runId>
  approve-merge <featureId> [--note "..."]
  request-changes <featureId> "<text>"
  extend <runId> <cycles>
  ack <attentionId>
  notes add "<text>" [--kind learning|decision|gotcha] [--run <id>] [--feature <id>]
  pause [why] | resume`;

function out(json, value, text) {
  if (json) console.log(JSON.stringify(value, null, 2));
  else console.log(text ?? value);
}

export async function main(argv, { cwd = process.cwd() } = {}) {
  const args = argv.filter((a) => a !== '--json');
  const json = argv.includes('--json');
  const verb = args[0];
  if (!verb || verb === '--help' || verb === '-h') { console.log(USAGE); return 2; }

  const paths = pipelinePaths(cwd);
  const config = loadConfig(paths);

  // The pool must only ever run against a consumer project.
  if (isOrchestratorSourceRepo(cwd) && !selfTargetAllowed({ env: process.env, allowSelfFlag: argv.includes('--allow-self') })) {
    console.error(selfGuardMessage(cwd));
    return 3;
  }

  const flag = (name, fallback = null) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? fallback : args[i + 1];
  };

  try {
    switch (verb) {
      case 'status': {
        const snap = pool.snapshot(paths, { config });
        out(json, snap, renderDigest(snap));
        return 0;
      }
      case 'digest': {
        console.log(renderDigest(pool.snapshot(paths, { config })));
        return 0;
      }
      case 'attention': {
        const items = args.includes('--pending') ? pool.pendingAttention(paths) : pool.pendingAttention(paths);
        out(json, items, items.length
          ? items.map((i) => `- [${i.kind}] ${i.summary} (${i.runId ?? '-'}) — ack with \`pool ack ${i.id}\``).join('\n')
          : 'Nothing is waiting for you.');
        return 0;
      }
      case 'decisions': {
        const items = pool.openDecisions(paths);
        out(json, items, items.length
          ? items.map((d) => `- ${d.decisionId}: ${d.question} [${(d.options || []).join(', ')}]`).join('\n')
          : 'No open decisions.');
        return 0;
      }
      case 'roadmap': {
        const sub = args[1];
        if (sub === 'compile') {
          const res = pool.compile(paths);
          if (!res.ok) {
            console.error('Roadmap is not valid:');
            for (const e of res.errors) console.error(`  ${path.relative(cwd, paths.roadmapMd)}:${e.line}: ${e.message}`);
            return 1;
          }
          out(json, res.roadmap, `Compiled ${res.roadmap.features.length} feature(s); next up: ${res.roadmap.currentFeatureId ?? 'nothing'}.`);
          return 0;
        }
        if (sub === 'show') {
          const roadmap = pool.readRoadmap(paths);
          if (!roadmap) { console.error('No compiled roadmap. Run "roadmap compile" first.'); return 1; }
          out(json, roadmap, roadmap.features.map((f) => `${f.status.padEnd(24)} ${f.id}: ${f.title}`).join('\n'));
          return 0;
        }
        if (sub === 'hold') { out(json, pool.holdFeature(paths, args[2], args.slice(3).join(' ')), `Held ${args[2]}.`); return 0; }
        if (sub === 'release') { out(json, pool.releaseFeature(paths, args[2]), `Released ${args[2]}.`); return 0; }
        if (sub === 'skip') { out(json, pool.skipFeature(paths, args[2], args.slice(3).join(' ')), `Skipped ${args[2]}.`); return 0; }
        console.error(USAGE);
        return 2;
      }
      case 'decide': {
        if (!args[1] || !args[2]) { console.error(USAGE); return 2; }
        const res = pool.decide(paths, args[1], args.slice(2).join(' '), { via: 'cli' });
        out(json, res, `Recorded: ${res.decision}. The run has been asked to continue.`);
        return 0;
      }
      case 'approve-plan': {
        if (!args[1]) { console.error(USAGE); return 2; }
        out(json, pool.approvePlan(paths, args[1], { via: 'cli' }), `Plan approved for ${args[1]}.`);
        return 0;
      }
      case 'approve-merge': {
        if (!args[1]) { console.error(USAGE); return 2; }
        const res = pool.approveMerge(paths, args[1], { via: 'cli', note: flag('note') });
        out(json, res, `Merge approved for ${args[1]}. The supervisor will verify it is still mergeable before merging.`);
        return 0;
      }
      case 'request-changes': {
        if (!args[1] || !args[2]) { console.error(USAGE); return 2; }
        out(json, pool.requestChanges(paths, args[1], args.slice(2).join(' '), { via: 'cli' }), `Changes requested on ${args[1]}.`);
        return 0;
      }
      case 'extend': {
        if (!args[1] || !args[2]) { console.error(USAGE); return 2; }
        out(json, pool.requestExtend(paths, args[1], args[2]), `Asked the supervisor to extend ${args[1]} by ${args[2]} cycle(s).`);
        return 0;
      }
      case 'ack': {
        if (!args[1]) { console.error(USAGE); return 2; }
        pool.ackAttention(paths, args[1]);
        out(json, { acked: args[1] }, `Acknowledged ${args[1]}.`);
        return 0;
      }
      case 'notes': {
        if (args[1] !== 'add' || !args[2]) { console.error(USAGE); return 2; }
        const res = pool.addNote(paths, {
          kind: flag('kind', 'learning'), text: args[2],
          runId: flag('run'), featureId: flag('feature'),
        });
        out(json, res, `Wrote ${res.file}.`);
        return 0;
      }
      case 'pause': { out(json, pool.pause(paths, args.slice(1).join(' ')), 'Pool paused; running workers finish their current stage.'); return 0; }
      case 'resume': { out(json, pool.resume(paths), 'Pool resumed.'); return 0; }
      default:
        console.error(USAGE);
        return 2;
    }
  } catch (err) {
    console.error(`[pool] ${err.message}`);
    return 1;
  }
}

const invokedDirectly = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname);
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
