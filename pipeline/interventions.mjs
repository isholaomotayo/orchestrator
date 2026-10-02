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
