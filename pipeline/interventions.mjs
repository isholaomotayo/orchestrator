// Every human or out-of-band action on a run — dismiss, resume, retry,
// autonomy change, decision, merge approval — recorded in that run's own event
// log, so its report can show what was done to it, by whom, and from where.
// Field runs were repaired by hand-editing state with no trace at all.
import { pipelinePaths, appendEvent } from './state.mjs';
import { appendRunVerb, isValidRunId } from './run-registry.mjs';

export function recordIntervention(root, runId, { action, by = 'operator', via = 'cli', detail = null }) {
  if (runId && !isValidRunId(runId)) return null;
  const runPaths = pipelinePaths(root, runId ? { runId } : {});
  const event = { stage: 'orchestrator', type: 'intervention', action, by, via, ...(detail ? { detail } : {}) };
  try {
    appendEvent(runPaths, event);
    appendRunVerb(runPaths, 'note', `${action} (${via})${detail ? `: ${detail}` : ''}`);
  } catch { /* the action itself already happened; never fail it over the log */ }
  return event;
}

/**
 * An automatic recovery (the supervisor resuming, extending or retrying on
 * its own). Kept apart from `intervention`, which is a person's action, so a
 * report can tell "someone fixed it" from "it fixed itself".
 */
export function recordRecovery(root, runId, { action, cause = null, detail = null, via = 'self-heal' }) {
  if (runId && !isValidRunId(runId)) return null;
  const runPaths = pipelinePaths(root, runId ? { runId } : {});
  const event = {
    stage: 'orchestrator', type: 'recovered', action, via,
    ...(cause ? { cause } : {}), ...(detail ? { detail } : {}),
  };
  try {
    appendEvent(runPaths, event);
    appendRunVerb(runPaths, 'note', `${action} (${via})${cause ? ` after ${cause}` : ''}${detail ? `: ${detail}` : ''}`);
  } catch { /* the recovery itself already happened; never fail it over the log */ }
  return event;
}
