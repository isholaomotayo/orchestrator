// The doctor: for any run, say what state it is in, why, who or what it is
// waiting on, and which remedies exist. A run is never allowed to be merely
// "stuck": it is progressing, waiting on a named party, or carrying a diagnosis
// with remedies — and when none of those fit, it says `unknown` and shows its
// evidence instead of staying silent.
//
// Pure: no IO, no clock (the caller passes `now`), no dependency on api-v1.mjs
// (which embeds this). Remedies come from recoverability.mjs and nowhere else,
// so the doctor can never offer what the engine would refuse.
//
// A diagnosis holds no durations ("waiting 12 min"): those change every tick
// and would make an unchanged situation look like news. It carries `since` as
// a timestamp and lets the client do the arithmetic.

import { recoveryFor, HALT_REASONS, hintFor } from './recoverability.mjs';
import { DEFAULT_THRESHOLDS } from './attention.mjs';

export const DOCTOR_STATES = [
  'finished', 'healthy', 'waiting', 'stalled', 'dead-engine', 'parked-no-host', 'held',
  'halted-recoverable', 'halted-terminal', 'pool-stopped', 'pool-paused', 'supervisor-dead', 'unknown',
];

const START_SUPERVISOR = 'bash .pipeline/orchestrate.sh pool start';

// States that need the pool supervisor to move on. A running engine or a run
// waiting on a person does not.
const NEEDS_SUPERVISOR = new Set(['dead-engine', 'halted-recoverable', 'parked-no-host', 'held']);

const remedy = (verb, fields) => ({ verb, safe: false, auto: false, ...fields });

function haltEvidence(status) {
  const out = [`status.json: haltReason=${status.haltReason}`];
  const row = (status.stages || []).find((s) => s.name === status.haltedStage);
  if (row?.detail) out.push(`${status.haltedStage}: ${String(row.detail).slice(0, 300)}`);
  return out;
}

function diagnoseRun({ status, engineAlive, driver, waitingSince, lastEventAt, held, now }) {
  const base = { waitingOn: null, since: null, evidence: [], remedies: [] };
  if (!status?.overall) {
    return { ...base, state: 'unknown', cause: 'no-status', explanation: 'This run has no readable status.json, so its state cannot be determined.', evidence: ['status.json missing or unreadable'] };
  }
  if (status.dismissed || status.overall === 'done') {
    return { ...base, state: 'finished', cause: status.dismissed ? 'dismissed' : 'done', explanation: status.dismissed ? 'An operator dismissed this run; nothing is wrong with it.' : 'This run finished.' };
  }
  if (held) {
    return { ...base, state: 'held', cause: 'ticket-held', waitingOn: 'you', explanation: `This ticket is held: ${held}`, evidence: [`held: ${held}`],
      remedies: [remedy('retry-ticket', { command: 'ticket.retry', safe: true, reason: 'reruns just this ticket; committed tickets are kept' })] };
  }

  switch (status.overall) {
    case 'running': {
      if (!engineAlive) {
        const table = recoveryFor(status, { engineAlive: false });
        return { ...base, state: 'dead-engine', cause: 'engine-gone',
          explanation: 'The run is marked running but its engine process is gone, so nothing is working on it.',
          evidence: ['status.overall=running', 'engine pid is not alive'],
          remedies: [remedy('resume', { command: 'run.resume', safe: true, auto: table.autoResume, reason: 'restarts the engine at the step it was on' })] };
      }
      const quietMs = lastEventAt ? now - Date.parse(lastEventAt) : null;
      if (quietMs != null && quietMs >= DEFAULT_THRESHOLDS.staleAfterMs) {
        return { ...base, state: 'stalled', cause: 'no-output', since: lastEventAt,
          explanation: 'The engine is alive but has produced no output for over 10 minutes.',
          evidence: ['engine pid is alive', `last output at ${lastEventAt}`],
          remedies: [remedy('stop', { command: 'run.cancel', safe: false, reason: 'stops the engine; resume afterwards if it is hung' })] };
      }
      return { ...base, state: 'healthy', cause: 'progressing', explanation: 'The engine is running and producing output.' };
    }

    case 'awaiting_chat': {
      const stage = status.awaitingStage || 'a stage';
      const blocked = status.completionBlocked;
      const evidence = [`status.overall=awaiting_chat (${stage})`, ...(blocked ? [`status.completionBlocked: ${blocked}`] : [])];
      const note = blocked ? ` The agent's last completion did not commit: ${blocked}.` : '';
      if (driver?.kind === 'host-session') {
        const host = driver.host || 'a chat agent';
        return { ...base, state: 'waiting', cause: 'host-working', waitingOn: host, since: waitingSince,
          explanation: `${host} holds the lease and is working on ${stage}.${note}`, evidence };
      }
      const lastHost = status.hostClient ? ` (last host: ${status.hostClient})` : '';
      return { ...base, state: 'parked-no-host', cause: blocked ? 'completion-blocked' : 'no-host', waitingOn: 'a chat agent', since: waitingSince,
        explanation: `Stage ${stage} is waiting for a chat agent${lastHost} and no session holds it.${note}`,
        evidence: [...evidence, 'no live lease on the handoff'] };
    }

    case 'awaiting_plan_approval':
      return { ...base, state: 'waiting', cause: 'plan-approval', waitingOn: 'you', since: waitingSince,
        explanation: 'The plan is ready and waiting for your approval before the build starts.',
        evidence: ['status.overall=awaiting_plan_approval'],
        remedies: [
          remedy('approve-plan', { command: 'plan.approve', reason: 'approving starts the build; a person decides' }),
          remedy('request-plan-changes', { command: 'plan.reject', reason: 'needs a written note for the planner' }),
        ] };

    case 'halted': return diagnoseHalt(status, base);
    default:
      return { ...base, state: 'unknown', cause: 'unmapped-state', explanation: `The run is in a state the doctor does not recognise ("${status.overall}").`, evidence: [`status.overall=${status.overall}`] };
  }
}

function diagnoseHalt(status, base) {
  const reason = status.haltReason;
  const entry = HALT_REASONS[reason];
  const evidence = haltEvidence(status);
  if (!entry) {
    return { ...base, state: 'unknown', cause: `halt:${reason}`, waitingOn: 'you', evidence,
      explanation: `Halted with ${reason || 'no reason recorded'}. ${hintFor(reason)}` };
  }
  if (entry.kind === 'hidden') return { ...base, state: 'finished', cause: 'dismissed', explanation: hintFor(reason), evidence };
  if (reason === 'POOL_STOPPED') {
    return { ...base, state: 'pool-stopped', cause: 'supervisor-not-running', waitingOn: 'the supervisor', evidence, explanation: hintFor(reason),
      remedies: [remedy('start-supervisor', { shell: START_SUPERVISOR, safe: true, reason: 'starts the roadmap supervisor; it resumes driving the pool' })] };
  }
  if (reason === 'POOL_PAUSED') {
    return { ...base, state: 'pool-paused', cause: 'paused', waitingOn: 'you', evidence, explanation: hintFor(reason),
      remedies: [remedy('resume-pool', { command: 'pool.resume', safe: true, reason: 'lets the pool start new work again' })] };
  }

  const table = recoveryFor(status, { engineAlive: false });
  const remedies = [];
  if (table.resume) {
    remedies.push(remedy('resume', {
      command: 'run.resume', safe: true, auto: table.autoResume,
      reason: table.needsValidArtifact ? 'fix the artifact named above first; resume then re-validates it' : 'continues from the step that failed',
    }));
  }
  if (table.extend) {
    remedies.push(remedy('extend', { command: 'run.extend', safe: true, auto: true, reason: 'adds cycle budget to the loop that ran out (once automatically)' }));
  }
  const explanation = `Halted with ${reason}. ${hintFor(reason)}`;
  if (remedies.length) return { ...base, state: 'halted-recoverable', cause: `halt:${reason}`, evidence, explanation, remedies };
  return { ...base, state: 'halted-terminal', cause: `halt:${reason}`, waitingOn: 'you', evidence, explanation };
}

/**
 * @param {object} ctx
 * @param {object|null} ctx.status           the run's status.json
 * @param {boolean} [ctx.engineAlive]
 * @param {object|null} [ctx.driver]         api-v1 driverOf() result
 * @param {string|null} [ctx.waitingSince]   when the run was handed off, ISO
 * @param {string|null} [ctx.lastEventAt]    events.jsonl mtime, ISO
 * @param {object|null} [ctx.supervisor]     pool supervisorState() ({alive, paused, heartbeatAt})
 * @param {string|null} [ctx.held]           why a pool ticket is held, if it is
 * @param {number} [ctx.now]
 * @returns {{state:string, cause:string, explanation:string, waitingOn:string|null, since:string|null, evidence:string[], remedies:object[], underlying?:object}}
 */
export function diagnose({ status, engineAlive = false, driver = null, waitingSince = null, lastEventAt = null, supervisor = null, held = null, now = Date.now() }) {
  const base = diagnoseRun({ status, engineAlive, driver, waitingSince, lastEventAt, held, now });
  const pooled = !!status?.featureId;
  if (pooled && supervisor && supervisor.alive === false && NEEDS_SUPERVISOR.has(base.state)) {
    return {
      state: 'supervisor-dead', cause: 'supervisor-not-running', waitingOn: 'the supervisor', since: supervisor.heartbeatAt || null,
      explanation: `The roadmap supervisor is not running, so nothing will recover this run on its own. ${base.explanation}`,
      evidence: ['supervisor.pid is not alive', ...(supervisor.heartbeatAt ? [`last supervisor heartbeat at ${supervisor.heartbeatAt}`] : []), ...base.evidence],
      remedies: [remedy('start-supervisor', { shell: START_SUPERVISOR, safe: true, reason: 'starts the roadmap supervisor; it then handles this run' }), ...base.remedies],
      underlying: base,
    };
  }
  return base;
}
