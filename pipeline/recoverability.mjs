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

// Every halt reason anything can write, with the words a person needs. One
// registry, so a new reason cannot ship without an explanation (a test scans
// the sources for reason literals) and a hint can never tell someone to
// resume what recoveryFor() refuses. Commands are in backticks because
// handoff.mjs rewrites them for pool runs.
//
//   kind: recoverable — a verb in recoveryFor() can move it on
//         human       — needs a person's decision; no resume or extend
//         mirror      — synthetic, shown on the pool's mirror run only
//         hidden      — an operator hid the run; nothing is wrong
export const HALT_REASONS = {
  INTERRUPTED: { kind: 'recoverable', hint: 'The run was interrupted. Resume it: `node pipeline/orchestrator.mjs --resume`.' },
  ENGINE_ERROR: { kind: 'recoverable', hint: 'The orchestrator itself hit an unexpected error (see the stage detail above). Report it, then `node pipeline/orchestrator.mjs --resume` to re-enter the failed step.' },
  AGENT_ERROR: { kind: 'recoverable', hint: 'The agent CLI failed. Check authentication and the stage log under `.pipeline/logs/`, then `node pipeline/orchestrator.mjs --resume`.' },
  MISSING_ARTIFACT: { kind: 'recoverable', hint: 'A stage\'s artifact is missing or lacks a required section (named in the halt detail above). Fix that file in place, then `node pipeline/orchestrator.mjs --resume` — it re-validates the artifact and continues from the same step; no fresh run needed.' },
  INVALID_VERDICT: { kind: 'recoverable', hint: 'The reviewer produced a report with no parseable verdict line. Read `.pipeline/review_report.md`; if the audit is sound, add "## Verdict: APPROVED|REQUEST_CHANGES|BLOCK" and `node pipeline/orchestrator.mjs --resume`.' },
  MAX_CYCLES: { kind: 'recoverable', hint: 'Extend the same fix loop: `node pipeline/orchestrator.mjs --resume --extend <n>` (or the dashboard "Extend" button).' },
  REGRESSION_BLOCKED: { kind: 'human', hint: 'Tests that passed before this change now fail (details in `.pipeline/checker_report.md`). This halt is not extendable and cannot be resumed. Inspect the diff and the report, fix the regression, then start a new run for the same task.' },
  INTEGRITY_VIOLATION: { kind: 'human', hint: 'A stage wrote pipeline control-plane files it does not own, or a read-only stage changed the working tree, so its output is untrusted. This halt cannot be resumed. Review the listed files and `git status`, remove what should not be there, then start a new run. Prefer a runner that hard-enforces read-only (claude, codex) for audit stages.' },
  INTEGRITY_ERROR: { kind: 'human', hint: 'The roadmap validation run could not be prepared (the cause is in the halt detail). It cannot be resumed: fix that cause, then start the validation again.' },
  RUNNER_UNAVAILABLE: { kind: 'human', hint: 'The runner chosen for this run is not installed or not authenticated (see the halt detail). Fix that, or choose another runner in `.pipeline/config.json`, then retry the ticket: `bash .pipeline/orchestrate.sh pool retry-ticket <featureId> <ticketId>`.' },
  DISMISSED: { kind: 'hidden', hint: 'An operator dismissed this run to hide it from the inbox; nothing is wrong with it. To work on the task again, start a new run or retry the feature.' },
  POOL_STOPPED: { kind: 'mirror', hint: 'The roadmap supervisor is not running, so nothing is driving these runs. Start it: `bash .pipeline/orchestrate.sh pool start`.' },
  POOL_PAUSED: { kind: 'mirror', hint: 'The pool is paused, so no new work starts and running workers finish their current stage. Continue it: `bash .pipeline/orchestrate.sh pool resume`.' },
};

const FALLBACK_HINT = 'Inspect `.pipeline/status.json` and the stage logs; this halt reason is not recognised, so no recovery step is known.';

/** The words for a halt reason. Never promises a resume the table would refuse. */
export function hintFor(reason) {
  return HALT_REASONS[reason]?.hint || FALLBACK_HINT;
}

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
