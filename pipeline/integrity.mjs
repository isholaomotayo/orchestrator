// Runner-independent integrity checks.
//
// buildInvocation can only constrain runners whose CLI exposes a permission
// model (claude, codex). cursor-agent and gemini get a best-effort constraint at
// most, and a custom runner gets none. These checks close that gap after the
// fact: hash what a stage was not supposed to touch, compare once it exits, and
// invalidate the stage if the bytes moved. That covers every runner, including
// ones added later, because it observes the filesystem rather than the CLI.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { CONTROL_PLANE_FILES } from './adapters.mjs';
import { STAGE_ARTIFACT_FILES } from './state.mjs';

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
    snap[rel] = hashFile(path.join(paths.root, rel));
  }
  let prompts = [];
  try { prompts = fs.readdirSync(paths.prompts).filter((f) => f.endsWith('.txt')); } catch {}
  for (const name of prompts.sort()) {
    snap[`.pipeline/prompts/${name}`] = hashFile(path.join(paths.prompts, name));
  }
  return snap;
}

// Files the ORCHESTRATOR itself rewrites across a chat handoff, plus the one the
// chat host is explicitly asked to annotate with `actualModel`. In chat mode the
// snapshot spans two process invocations, so these always differ and would
// otherwise flag every single continue as a violation.
export const HANDOFF_OWNED_FILES = ['.pipeline/status.json', '.pipeline/stage-handoff.json'];

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
