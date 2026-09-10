// Why a run-lifecycle action is unavailable right now, in the operator's own
// terms — the same conditions ui-server.mjs's readState() gates on
// (canContinue/canResume/canExtend/canCancel), stated as a reason rather than
// just leaving the button off the page. An action a person cannot even see is
// indistinguishable from one that doesn't exist; showing it disabled with a
// reason is what actually explains the state.
export function unavailableReason(action, data) {
  const overall = data.status?.overall;
  const halt = data.status?.haltReason;
  // data.canCancel doubles as "a process is currently alive" (that IS its
  // server-side definition — see ui-server.mjs's readState). data.live means
  // something else entirely: "some action is available", true whenever ANY
  // of canCancel/canExtend/canResume/canContinue/canApprovePlan is — so it is
  // useless for "is this specific run active" and must not be used as that.
  const alive = data.canCancel;
  if (action === 'continue') {
    if (alive) return 'Available once this run is parked at a chat handoff — it is currently active.';
    if (overall !== 'awaiting_chat') return `Available only while awaiting a chat handoff (currently: ${(overall || 'unknown').replace(/_/g, ' ')}).`;
    if (data.stageReady && !data.stageReady.ok) return `The completed stage's artifact is not ready: ${data.stageReady.reason}`;
    return null;
  }
  if (action === 'resume') {
    if (alive) return 'The run is active; resume is not needed.';
    if (overall === 'done') return 'This run already finished.';
    if (overall === 'halted' && halt !== 'INTERRUPTED') return `Available only for an interrupted or stale run (this halted with ${halt}).`;
    if (overall !== 'halted' && !data.stale) return 'Available only for an interrupted or a stale (stuck) run.';
    return null;
  }
  if (action === 'extend') {
    if (overall !== 'halted') return 'Available only once a run halts at its cycle limit.';
    if (halt !== 'MAX_CYCLES') return `Available only when halted with MAX_CYCLES (this halted with ${halt}).`;
    return null;
  }
  if (action === 'cancel') {
    return 'Nothing is currently running to stop.';
  }
  return null;
}
