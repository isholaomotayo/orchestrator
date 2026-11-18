// Self-heal: decide whether a stuck run may be repaired without a person, and
// say what to do. Pure — the supervisor supplies the clock, the run's counters
// and when it first saw the problem, and carries out the answer.
//
// Deliberately narrow. It acts on exactly one thing, a run whose engine
// process is gone, and its only action is to restart that same step. It
// never approves a plan or a merge, deletes anything, changes a surface, or
// runs a command: those stay with a person (the doctor lists them as remedies
// that are not `auto`). Everything it does is bounded by a budget; when the
// budget is spent it hands the run back — to guided, with a reason — instead
// of retrying forever.
import { backoffMs } from './retry.mjs';

/** How long an engine must stay dead before we believe it (a fresh spawn has no lock for a moment). */
export const DEAD_ENGINE_GRACE_MS = 30_000;

const none = (reason) => ({ action: 'none', reason });

/**
 * @param {object} ctx
 * @param {object} ctx.diagnosis       doctor.mjs diagnose() result
 * @param {'guided'|'autonomous'} ctx.autonomy
 * @param {object} ctx.meta            the run's run.json ({autoResumes, lastHealAt, spawnedAt})
 * @param {number} ctx.now
 * @param {number|null} ctx.observedSince  when this state was first seen, ms
 * @param {number} ctx.maxResumes      budget shared with the supervisor's other auto-resumes
 * @param {number} [ctx.graceMs]
 * @returns {{action:'none'|'wait'|'respawn'|'escalate', reason?:string, until?:number, kind?:string, summary?:string, flipToGuided?:boolean}}
 */
export function planHeal({ diagnosis, autonomy, meta = {}, now, observedSince, maxResumes, graceMs = DEAD_ENGINE_GRACE_MS }) {
  if (diagnosis?.state !== 'dead-engine') return none(`nothing to repair (${diagnosis?.state || 'no diagnosis'})`);
  if (autonomy !== 'autonomous') return none('the run is guided: it is left for a person, with the diagnosis');
  const resume = (diagnosis.remedies || []).find((r) => r.verb === 'resume');
  if (!resume?.safe || !resume?.auto) return none('the recoverability table does not allow an unattended restart');

  const used = Number(meta.autoResumes || 0);
  if (used >= maxResumes) {
    return {
      action: 'escalate', kind: 'self-heal-exhausted', flipToGuided: true,
      reason: `restart budget spent (${used} of ${maxResumes})`,
      summary: `The engine stopped ${used + 1} times and ${used} automatic restart${used === 1 ? '' : 's'} did not hold, so the run is back in your hands (guided). ${diagnosis.explanation}`,
    };
  }

  // Not before it has stayed dead for the grace period, and not before the
  // backoff after the previous attempt.
  const spawnedAt = Date.parse(meta.spawnedAt) || 0;
  const since = Math.max(observedSince ?? now, spawnedAt);
  const settled = (observedSince == null ? now : since) + graceMs;
  if (observedSince == null || now < settled) return { action: 'wait', reason: 'confirming the engine is really gone', until: settled };
  const last = Date.parse(meta.lastHealAt) || 0;
  const retryAt = last ? last + backoffMs(used + 1) : 0;
  if (now < retryAt) return { action: 'wait', reason: 'backing off after the last restart', until: retryAt };
  return { action: 'respawn', reason: 'the engine has been gone past the grace period' };
}

/**
 * Has the roadmap supervisor crashed? Whoever else is awake (the dashboard
 * server today, the desktop app later) asks this, because the supervisor
 * cannot report its own death.
 *
 * A clean stop removes the supervisor's pid file; a crash or SIGKILL leaves it
 * pointing at a process that is gone. So "pid recorded but not alive" means
 * crashed, and "no pid" means stopped on purpose or never started.
 *
 * @param {{state: {pid:number|null, alive:boolean, heartbeatAt:string|null}, pending: object[], now: number}} ctx
 * @returns {{raise?: object, ack: string[]}}
 */
export function planSupervisorWatch({ state, pending }) {
  const open = (pending || []).filter((a) => a.kind === 'supervisor-dead');
  const crashed = !!state?.pid && !state.alive;
  if (!crashed) return { ack: open.map((a) => a.id) };
  if (open.length) return { ack: [] };
  const seen = state.heartbeatAt ? ` It was last seen at ${state.heartbeatAt}.` : '';
  return {
    ack: [],
    raise: {
      kind: 'supervisor-dead', escalate: true, runId: null, featureId: null,
      summary: `The roadmap supervisor stopped unexpectedly, so nothing is driving the pool and no run will recover on its own.${seen} Start it again: bash .pipeline/orchestrate.sh pool start`,
    },
  };
}
