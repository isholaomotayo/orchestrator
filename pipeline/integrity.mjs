// Runner-independent integrity checks.
//
// buildInvocation can only constrain runners whose CLI exposes a permission
// model (claude, codex). cursor-agent and agy (Antigravity) get a best-effort constraint at
// most, and a custom runner gets none. These checks close that gap after the
// fact: hash what a stage was not supposed to touch, compare once it exits, and
// invalidate the stage if the bytes moved. That covers every runner, including
// ones added later, because it observes the filesystem rather than the CLI.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { CONTROL_PLANE_FILES } from './adapters.mjs';
import { STAGE_ARTIFACT_FILES, resolvePipelineRel } from './state.mjs';

export function hashFile(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null; // absent — a later appearance is itself a change
  }
}

/**
 * Hash every control-plane file plus the stage prompts.
 * @returns {Record<string, string|null>} relative path -> content hash
 */
export function snapshotControlPlane(paths) {
  const snap = {};
  for (const rel of CONTROL_PLANE_FILES) {
    // Resolve against THIS run, not the repo root: in a pooled run the control
    // plane lives in .pipeline/runs/<runId>/, and hashing the repo-root copy
    // would compare a file the stage never had access to.
    snap[rel] = hashFile(resolvePipelineRel(paths, rel));
  }
  let prompts = [];
  try { prompts = fs.readdirSync(paths.prompts).filter((f) => f.endsWith('.txt')); } catch {}
  for (const name of prompts.sort()) {
    snap[`.pipeline/prompts/${name}`] = hashFile(path.join(paths.prompts, name));
  }
  return snap;
}

/**
 * Files the ORCHESTRATOR itself writes while a stage is in flight, plus the one
 * a chat host is explicitly asked to annotate with `actualModel`.
 *
 * These can never be compared by hash. The engine persists the integrity
 * baseline INTO status.json and updates stage state during the stage, so
 * status.json always differs between the baseline and the check — by the
 * engine's own hand, not the agent's. Comparing them anyway made every CLI-mode
 * run halt with INTEGRITY_VIOLATION on its first stage; chat mode escaped only
 * because it passed this exclusion list and CLI mode did not.
 *
 * These two files are still protected, just by a different mechanism:
 * `pipelineWriteDeny` denies every stage `Write`/`Edit` access to them, and a
 * read-only stage's allowlist never includes them.
 */
export const ORCHESTRATOR_OWNED_FILES = ['.pipeline/status.json', '.pipeline/stage-handoff.json'];

// Back-compat alias for the name this list had when it was used only on the
// chat-handoff path.
export const HANDOFF_OWNED_FILES = ORCHESTRATOR_OWNED_FILES;

/**
 * Which control-plane files changed while `stage` was running, excluding the
 * one artifact that stage is legitimately allowed to author.
 * @param {string[]} exclude additional paths to ignore (see HANDOFF_OWNED_FILES)
 * @returns {string[]} relative paths, sorted
 */
export function controlPlaneViolations(before, after, stage, exclude = []) {
  const own = `.pipeline/${STAGE_ARTIFACT_FILES[stage] || ''}`;
  const ignored = new Set([own, ...exclude]);
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed = [];
  for (const key of keys) {
    if (ignored.has(key)) continue;
    if (before[key] !== after[key]) changed.push(key);
  }
  return changed.sort();
}

/**
 * Fingerprint of the working tree, used to prove a read-only stage stayed
 * read-only. Falls back to null outside a git repo, where there is nothing
 * cheap and reliable to compare against.
 * @returns {string|null}
 */
export function workingTreeFingerprint(cwd) {
  const res = spawnSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (res.status !== 0) return null;
  // .pipeline/ churns constantly by design (events, status, artifacts) and is
  // covered by the control-plane snapshot instead.
  const lines = (res.stdout || '')
    .split('\n')
    .filter((l) => l.trim() && !l.slice(3).startsWith('.pipeline'))
    .sort();
  return crypto.createHash('sha256').update(lines.join('\n')).digest('hex');
}

/**
 * Did a stage declared read-only actually mutate the working tree?
 * Unknown fingerprints (no git) return false — absence of proof is not proof.
 */
export function readOnlyViolated(before, after) {
  if (before === null || after === null) return false;
  return before !== after;
}
