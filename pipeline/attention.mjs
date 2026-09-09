// Supervision: deciding what is happening to a run, and what a human must see.
//
// Two principles carried over from the design:
//
//  1. Absence of proof is not proof. A run whose state we cannot read is
//     `unknown`, never `busy` and never `dead`. Guessing "busy" hides a crashed
//     worker; guessing "dead" respawns one that is quietly working.
//  2. Silence is not a status. Anything unrecognised escalates, because the
//     failure mode of waking a human unnecessarily is annoyance, and the failure
//     mode of staying quiet is a pool that has silently stopped.
//
// Everything here is pure or file-append-only, so the supervisor can be driven
// tick-by-tick in tests with an injected clock and no processes.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { appendLine } from './state.mjs';

export const DEFAULT_THRESHOLDS = {
  // Quiet for this long while nominally working: suspicious.
  staleAfterMs: 600_000,
  // Still quiet this long after that: tell someone.
  staleEscalateMs: 240_000,
  // How often a declared wait or hold is put back in front of a human.
  pauseResurfaceMs: 3_600_000,
};

// Verbs that mean the run is waiting on a person rather than on itself.
const WAITING_VERBS = ['needs-decision', 'blocked', 'paused', 'held'];

/**
 * What is this run doing right now?
 * @returns {'busy'|'stale'|'awaiting'|'idle'|'dead'|'unknown'}
 */
export function classifyRun({ status, pidAlive, lastOutputAt, lastVerb = null, meta = null, now = Date.now() }, thresholds = DEFAULT_THRESHOLDS) {
  // No readable status at all: a spawn that has not yet written status.json is
  // still a live start if the worker pid is up; a vanished pid is a crash.
  if (!status?.overall) {
    if (meta?.phase === 'spawned') {
      if (pidAlive) return 'busy';
      return 'dead';
    }
    return 'unknown';
  }

  if (status.overall === 'done' || status.overall === 'halted') return 'idle';

  // Parked at a gate: the process is meant to be gone, so a missing pid here is
  // expected rather than a crash.
  if (status.overall === 'awaiting_chat' || status.overall === 'awaiting_plan_approval') return 'awaiting';
  if (lastVerb && WAITING_VERBS.includes(lastVerb.verb)) return 'awaiting';

  if (status.overall === 'running') {
    if (!pidAlive) return 'dead';
    if (!lastOutputAt) return 'busy';
    const quietFor = now - Date.parse(lastOutputAt);
    if (Number.isNaN(quietFor)) return 'unknown';
    return quietFor > thresholds.staleAfterMs ? 'stale' : 'busy';
  }
  return 'unknown';
}

/**
 * Turn a state transition into at most one event, and decide whether a human
 * needs to see it.
 *
 * @returns {{kind:string, escalate:boolean, summary:string, runId:string, featureId:string|null, at:string}|null}
 */
export function classifyEvent({
  runId, featureId = null, previous = {}, current = {},
  staleSince = null, verbSince = null, now = Date.now(),
}, thresholds = DEFAULT_THRESHOLDS) {
  const at = new Date(now).toISOString();
  const make = (kind, escalate, summary) => ({ kind, escalate, summary, runId, featureId, at });
  const changed = previous.state !== current.state || previous.verb !== current.verb;

  // A run that finished, either way.
  if (current.state === 'idle' && changed) {
    if (current.status?.overall === 'halted' || current.verb === 'failed') {
      const reason = current.status?.haltReason || current.detail || 'halted';
      return make('halted', true, `Run halted: ${reason}`);
    }
    const verdict = current.status?.verdict || current.detail || 'finished';
    return make('done', false, `Run finished: ${verdict}`);
  }

  // The process vanished while the run still believed it was working.
  if (current.state === 'dead' && changed) {
    return make('dead', true, 'The worker process is gone while its run was still marked running');
  }

  // Waiting on a person.
  if (current.state === 'awaiting') {
    // A host-runner run parked at a stage handoff: this is not a decision to
    // answer, it is an invitation to do the stage's work directly in chat —
    // give it its own kind so the coordinator/dashboard can tell the two apart
    // and print the exact command to pick it up.
    if (current.status?.overall === 'awaiting_chat') {
      const stage = current.status.awaitingStage || '?';
      if (changed) {
        return make('claim-run', true, `Ready for a human to complete the "${stage}" stage in chat — run \`pool claim ${runId}\`.`);
      }
      if (verbSince && now - Date.parse(verbSince) > thresholds.pauseResurfaceMs) {
        return make('claim-run', true, `Still waiting to be claimed: "${stage}" — run \`pool claim ${runId}\`.`);
      }
      return null;
    }
    const verb = current.verb;
    if (changed) {
      if (verb === 'needs-decision') {
        const detail = current.detail || '';
        // A plan-approval gate is a distinct kind because it has its own verb
        // (`approve-plan`) and its own artifact to read.
        const kind = /plan-approval/i.test(detail) ? 'plan-approval' : 'needs-decision';
        return make(kind, true, detail ? `Waiting on a decision: ${detail}` : 'Waiting on a decision');
      }
      if (verb === 'blocked') return make('blocked', true, `Blocked: ${current.detail || 'reason not recorded'}`);
      if (verb === 'held') return make('held', false, `Held by the operator: ${current.detail || ''}`.trim());
      if (verb === 'paused') return make('paused', false, `Waiting: ${current.detail || 'reason not recorded'}`);
      return make('needs-decision', true, current.detail || 'Waiting on a person');
    }
    // Unchanged. Declared waits and holds resurface on a slow cadence so a
    // forgotten decision cannot sit invisible forever.
    if ((verb === 'paused' || verb === 'held') && verbSince && now - Date.parse(verbSince) > thresholds.pauseResurfaceMs) {
      return make(verb, true, `Still waiting: ${current.detail || 'reason not recorded'}`);
    }
    return null;
  }

  // Quiet but nominally working. Escalate only once it has gone on long enough
  // to be worth interrupting someone over.
  if (current.state === 'stale') {
    if (staleSince && now - Date.parse(staleSince) > thresholds.staleEscalateMs) {
      return make('stale', true, 'No output for a long time while the run is still marked working');
    }
    return null;
  }

  if (current.state === 'busy') return null;

  // Anything we could not classify: fail safe and surface it.
  if (changed) return make('unknown', true, 'The run is in a state the supervisor could not classify');
  return null;
}

// ---- attention queue -------------------------------------------------------
// Append-only, including acknowledgements: the history of what was surfaced and
// when it was cleared is itself the audit trail.

function readJsonl(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a torn or hand-edited line must not poison the read */ }
  }
  return out;
}

function newId(prefix) {
  return `${prefix}-${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)}-${crypto.randomBytes(3).toString('hex')}`;
}

export function appendAttention(paths, item) {
  const record = { id: newId('a'), ts: new Date().toISOString(), type: 'item', escalate: true, ...item };
  appendLine(paths.attention, JSON.stringify(record));
  return record;
}

export function readAttention(paths) {
  return readJsonl(paths.attention);
}

/** Items that have been raised and not yet acknowledged. */
export function pendingAttention(paths) {
  const records = readJsonl(paths.attention);
  const acked = new Set(records.filter((r) => r.type === 'ack').map((r) => r.ackOf));
  return records.filter((r) => r.type === 'item' && !acked.has(r.id));
}

export function ackAttention(paths, id, { by = 'coordinator' } = {}) {
  appendLine(paths.attention, JSON.stringify({ type: 'ack', ackOf: id, ts: new Date().toISOString(), by }));
}

// ---- decision ledger -------------------------------------------------------
// A decision is opened once and answered once. State is the last record for an
// id, so a reader that only ever appends can still reconstruct the truth.

export function openDecision(paths, decision) {
  const record = {
    decisionId: newId('d'),
    ts: new Date().toISOString(),
    status: 'open',
    options: [],
    recommended: null,
    artifacts: [],
    ...decision,
  };
  appendLine(paths.decisions, JSON.stringify(record));
  return { ...record, id: record.decisionId };
}

export function readDecisions(paths) {
  const byId = new Map();
  for (const record of readJsonl(paths.decisions)) {
    const id = record.decisionId;
    if (!id) continue;
    byId.set(id, { ...(byId.get(id) || {}), ...record });
  }
  return [...byId.values()];
}

export function openDecisions(paths) {
  return readDecisions(paths).filter((d) => d.status === 'open');
}

export function resolveDecision(paths, decisionId, { decision, note = null, by = 'operator', via = 'cli' }) {
  const existing = readDecisions(paths).find((d) => d.decisionId === decisionId);
  if (!existing) throw new Error(`Unknown decision "${decisionId}".`);
  if (existing.status === 'resolved') {
    throw new Error(`Decision "${decisionId}" is already resolved (${existing.decision}).`);
  }
  const record = { decisionId, ts: new Date().toISOString(), status: 'resolved', decision, note, by, via };
  appendLine(paths.decisions, JSON.stringify(record));
  return { ...existing, ...record };
}
