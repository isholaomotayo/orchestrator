// Which verbs can recover a run — the single source of truth for the engine's
// --resume guard, the supervisor's auto-resume, and the dashboard's buttons.
// They used to each keep their own list and disagreed: the supervisor
// auto-resumed transient AGENT_ERROR with --resume, which the engine always
// refused, so every "automatic retry" failed.
//
//   resume      — `--resume` may re-enter the halted step (manual).
//   autoResume  — the supervisor may do that unattended.
//   extend      — `--resume --extend N` may add cycle budget.
//   needsValidArtifact — resume is allowed only once the halted stage's
//                 artifact validates (a human or host agent fixed it).

import path from 'node:path';
import { validateArtifactFile } from './artifacts.mjs';
import { STAGE_ARTIFACT_FILES } from './stages.mjs';

const NONE = { resume: false, autoResume: false, extend: false, needsValidArtifact: false };

export function recoveryFor(status, { engineAlive = false } = {}) {
  if (!status) return { ...NONE, reason: 'no previous run found' };
  if (status.overall === 'running') {
    return engineAlive
      ? { ...NONE, reason: 'the run is still active' }
      : { ...NONE, resume: true, autoResume: false, reason: null, stale: true };
  }
  if (status.overall !== 'halted') return { ...NONE, reason: `the run is ${status.overall}` };
  switch (status.haltReason) {
    case 'INTERRUPTED':
    case 'ENGINE_ERROR':
      return { ...NONE, resume: true, reason: null };
    case 'AGENT_ERROR':
      // A non-transient error (e.g. CLI not authenticated) can be resumed by a
      // human once they fixed the cause; only transient ones retry unattended.
      return { ...NONE, resume: true, autoResume: status.haltTransient === true, reason: null };
    case 'MISSING_ARTIFACT':
    case 'INVALID_VERDICT':
      return { ...NONE, resume: true, needsValidArtifact: true, reason: null };
    case 'MAX_CYCLES':
      return status.haltedPhase
        ? { ...NONE, extend: true, reason: null }
        : { ...NONE, reason: 'MAX_CYCLES halt has no recorded phase' };
    default:
      return { ...NONE, reason: `halt reason "${status.haltReason}" needs a human decision, not a resume` };
  }
}

/**
 * For a halt that needs a fixed artifact: does the halted stage's artifact in
 * `dir` validate now? Returns { ok, file, reason }.
 */
export function haltedArtifactCheck(status, dir) {
  const stage = status?.haltedStage || (status?.stages || []).find((s) => s.status === 'failed')?.name;
  const name = stage && STAGE_ARTIFACT_FILES[stage];
  if (!name) return { ok: false, file: null, reason: 'the halted stage is unknown' };
  const file = path.join(dir, name);
  const check = validateArtifactFile(stage, file);
  return { ok: check.ok, file, reason: check.reason || null };
}
