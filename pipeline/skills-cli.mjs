#!/usr/bin/env node
// Managing third-party skills: pin, verify, list.
//
// Pinning is a deliberate human act. It records the exact bytes of a skill
// package that someone reviewed, and nothing runs or is injected until those
// bytes match — so a skill that updates itself under you stops being used
// rather than quietly changing what your agents are told.
import fs from 'node:fs';
import path from 'node:path';
import { pipelinePaths, loadConfig } from './state.mjs';
import { runInProgress } from './installer.mjs';
import {
  normalizeSkillsConfig, resolveSkillDir, verifySkill, writePin, readPin, skillStatuses,
} from './skills.mjs';

const USAGE = `Usage: node pipeline/skills.mjs <command>

  list [--json]        every declared skill and whether it is usable
  verify [name]        check declared skills against their pins
  pin <name>           record the current bytes of a skill as reviewed and trusted

A skill is only injected into a prompt, and its commands only offered to an
agent, when its pin matches. Review a skill before pinning it: its text becomes
part of your agents' instructions.`;

export async function main(argv, { cwd = process.cwd() } = {}) {
  const json = argv.includes('--json');
  const args = argv.filter((a) => a !== '--json');
  const command = args[0];
  const paths = pipelinePaths(cwd);
  const config = loadConfig(paths);
  const declared = normalizeSkillsConfig(config.skills);

  if (!command || command === '--help' || command === '-h') { console.log(USAGE); return 2; }

  if (command === 'list' || command === 'verify') {
    const only = command === 'verify' ? args[1] : null;
    const rows = skillStatuses(config, { repoRoot: cwd, paths })
      .filter((r) => !only || r.name === only);
    if (!rows.length) {
      console.error(only ? `No skill named "${only}" is declared in .pipeline/config.json.` : 'No skills are declared in .pipeline/config.json.');
      return only ? 1 : 0;
    }
    if (json) { console.log(JSON.stringify(rows, null, 2)); }
    else {
      for (const row of rows) {
        const mark = row.status === 'verified' ? 'ok  ' : 'NOT USED';
        console.log(`${mark} ${row.name}${row.status === 'verified' ? '' : ` — ${row.status}: ${row.detail}`}`);
      }
    }
    return rows.every((r) => r.status === 'verified') ? 0 : 1;
  }

  if (command === 'pin') {
    const name = args[1];
    const skill = declared.find((s) => s.name === name);
    if (!skill) { console.error(`No skill named "${name}" is declared in .pipeline/config.json.`); return 2; }
    // Pinning while agents are running would change their instructions mid-run.
    if (runInProgress(cwd)) { console.error('A run is in progress; pin skills when the pipeline is idle.'); return 1; }
    const dir = resolveSkillDir(skill, { repoRoot: cwd });
    if (!dir) { console.error(`The skill directory for "${name}" does not exist.`); return 1; }

    const previous = readPin(paths, name);
    const { file, pin, sha256 } = writePin(paths, skill, dir);
    const count = Object.keys(pin.files).length;
    console.log(`Pinned ${name}: ${count} file(s) from ${dir}`);
    console.log(`  ${path.relative(cwd, file)}`);
    if (skill.source.type === 'git') console.log(`  Record this in config.json as source.sha256: ${sha256}`);
    if (previous) {
      const changed = Object.keys(pin.files).filter((f) => previous.files?.[f] !== pin.files[f]).length;
      const removed = Object.keys(previous.files || {}).filter((f) => !(f in pin.files)).length;
      if (changed || removed) console.log(`  Replaces an earlier pin (${changed} changed, ${removed} removed) — review those changes if you have not.`);
    }
    const check = verifySkill(skill, { repoRoot: cwd, paths });
    console.log(check.ok ? '  Verified.' : `  Still not usable: ${check.reason} — ${check.detail}`);
    return check.ok ? 0 : 1;
  }

  console.error(USAGE);
  return 2;
}

const invokedDirectly = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname);
if (invokedDirectly) main(process.argv.slice(2)).then((code) => process.exit(code));
