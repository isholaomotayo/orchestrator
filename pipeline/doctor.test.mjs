import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnose, DOCTOR_STATES } from './doctor.mjs';
import { recoveryFor, HALT_REASONS } from './recoverability.mjs';

const now = Date.parse('2026-10-03T12:00:00Z');
const ago = (ms) => new Date(now - ms).toISOString();
const none = { kind: 'none', host: null, presence: 'absent' };
const cli = { kind: 'cli-process', host: 'claude', presence: 'active' };

const d = (status, extra = {}) => diagnose({ status, engineAlive: false, driver: none, now, ...extra });
const verbs = (diag) => diag.remedies.map((r) => r.verb);

test('a finished or dismissed run needs nothing', () => {
  assert.equal(d({ overall: 'done' }).state, 'finished');
  assert.equal(d({ overall: 'halted', haltReason: 'DISMISSED', dismissed: true }).state, 'finished');
  assert.deepEqual(d({ overall: 'done' }).remedies, []);
});

test('a live engine with recent output is healthy; with none for 10+ minutes it is stalled and says since when', () => {
  const status = { overall: 'running', runner: 'claude', executionSurface: 'cli-agent' };
  assert.equal(d(status, { engineAlive: true, driver: cli, lastEventAt: ago(30_000) }).state, 'healthy');
  const stalled = d(status, { engineAlive: true, driver: cli, lastEventAt: ago(11 * 60_000) });
  assert.equal(stalled.state, 'stalled');
  assert.match(stalled.explanation, /no output/i);
  assert.ok(stalled.evidence.some((e) => e.includes(ago(11 * 60_000))), 'the evidence names the last output time');
});

test('a run marked running whose engine is gone is a dead engine, and resuming it is the remedy', () => {
  const diag = d({ overall: 'running' });
  assert.equal(diag.state, 'dead-engine');
  assert.deepEqual(verbs(diag), ['resume']);
  assert.equal(diag.remedies[0].command, 'run.resume');
  assert.equal(diag.remedies[0].safe, true);
  // The table does not yet allow an unattended restart of a stale run; R3 adds a grace-and-budget rule and flips this.
  assert.equal(diag.remedies[0].auto, recoveryFor({ overall: 'running' }).autoResume);
});

test('remedies for a halt come from the recoverability table, never a second opinion', () => {
  const cases = [
    { overall: 'halted', haltReason: 'AGENT_ERROR', haltTransient: true },
    { overall: 'halted', haltReason: 'AGENT_ERROR', haltTransient: false },
    { overall: 'halted', haltReason: 'MAX_CYCLES', haltedPhase: 'coder' },
    { overall: 'halted', haltReason: 'MAX_CYCLES' },
    { overall: 'halted', haltReason: 'INTERRUPTED' },
    { overall: 'halted', haltReason: 'REGRESSION_BLOCKED' },
  ];
  for (const status of cases) {
    const diag = d(status);
    const table = recoveryFor(status);
    assert.equal(verbs(diag).includes('resume'), table.resume, `${status.haltReason} resume`);
    assert.equal(verbs(diag).includes('extend'), table.extend, `${status.haltReason} extend`);
    const auto = diag.remedies.find((r) => r.verb === 'resume')?.auto ?? false;
    assert.equal(auto, table.autoResume, `${status.haltReason} auto`);
  }
});

test('a recoverable halt is recoverable; one that needs a person says so and names them', () => {
  assert.equal(d({ overall: 'halted', haltReason: 'INTERRUPTED' }).state, 'halted-recoverable');
  const regression = d({ overall: 'halted', haltReason: 'REGRESSION_BLOCKED', haltedStage: 'tester', stages: [{ name: 'tester', detail: '3 tests regressed' }] });
  assert.equal(regression.state, 'halted-terminal');
  assert.equal(regression.waitingOn, 'you');
  assert.deepEqual(regression.remedies, []);
  assert.match(regression.explanation, /not extendable/);
  assert.ok(regression.evidence.some((e) => e.includes('3 tests regressed')), 'the halted stage detail is evidence');
});

test('a missing artifact can be resumed, but only after it is fixed', () => {
  const diag = d({ overall: 'halted', haltReason: 'MISSING_ARTIFACT', haltedStage: 'planner' });
  assert.equal(diag.state, 'halted-recoverable');
  const resume = diag.remedies.find((r) => r.verb === 'resume');
  assert.equal(resume.auto, false);
  assert.match(resume.reason, /fix/i);
});

test('a halt reason nobody registered is unknown, with evidence, rather than silent', () => {
  const diag = d({ overall: 'halted', haltReason: 'SOMETHING_NEW' });
  assert.equal(diag.state, 'unknown');
  assert.ok(diag.evidence.some((e) => e.includes('SOMETHING_NEW')));
  assert.ok(diag.explanation.length > 20);
});

test('a parked host run with no session is parked-no-host and waits on a chat agent', () => {
  const status = { overall: 'awaiting_chat', awaitingStage: 'coder', hostClient: 'antigravity', stages: [{ name: 'coder', startedAt: ago(40 * 60_000) }] };
  const diag = d(status, { waitingSince: ago(40 * 60_000) });
  assert.equal(diag.state, 'parked-no-host');
  assert.equal(diag.waitingOn, 'a chat agent');
  assert.equal(diag.since, ago(40 * 60_000));
  assert.match(diag.explanation, /antigravity/);
});

test('a parked run with a live session is just waiting on that session', () => {
  const diag = d({ overall: 'awaiting_chat', awaitingStage: 'coder' }, { driver: { kind: 'host-session', host: 'claude-code', presence: 'active' } });
  assert.equal(diag.state, 'waiting');
  assert.equal(diag.waitingOn, 'claude-code');
});

test('a blocked completion is named as the cause of the parking', () => {
  const diag = d({ overall: 'awaiting_chat', awaitingStage: 'coder', completionBlocked: 'lease expired for handoff h1' }, { waitingSince: ago(60_000) });
  assert.match(diag.explanation, /lease expired for handoff h1/);
  assert.ok(diag.evidence.some((e) => e.includes('completionBlocked')));
});

test('a plan awaiting approval waits on you, and approving is not safe to automate', () => {
  const diag = d({ overall: 'awaiting_plan_approval' });
  assert.equal(diag.state, 'waiting');
  assert.equal(diag.waitingOn, 'you');
  const approve = diag.remedies.find((r) => r.verb === 'approve-plan');
  assert.equal(approve.command, 'plan.approve');
  assert.equal(approve.safe, false);
  assert.equal(approve.auto, false);
});

test('pool mirror halts name the supervisor and the command that fixes them', () => {
  const stopped = d({ overall: 'halted', haltReason: 'POOL_STOPPED' });
  assert.equal(stopped.state, 'pool-stopped');
  assert.match(stopped.remedies[0].shell, /pool start/);
  const paused = d({ overall: 'halted', haltReason: 'POOL_PAUSED' });
  assert.equal(paused.state, 'pool-paused');
  assert.equal(paused.remedies[0].command, 'pool.resume');
});

test('a dead supervisor is the diagnosis for a pool run that needs it, and keeps the underlying one', () => {
  const halted = { overall: 'halted', haltReason: 'AGENT_ERROR', haltTransient: true, featureId: 'F1' };
  const supervisor = { alive: false, paused: false, heartbeatAt: ago(30 * 60_000) };
  const diag = d(halted, { supervisor });
  assert.equal(diag.state, 'supervisor-dead');
  assert.equal(diag.underlying.state, 'halted-recoverable');
  assert.ok(diag.remedies.some((r) => r.shell?.includes('pool start')));
  // A healthy engine does not need the supervisor right now.
  const running = diagnose({ status: { overall: 'running', featureId: 'F1', executionSurface: 'cli-agent' }, engineAlive: true, driver: cli, supervisor, lastEventAt: ago(1000), now });
  assert.equal(running.state, 'healthy');
  // A run outside any pool is never blamed on the supervisor.
  assert.equal(d({ ...halted, featureId: undefined }, { supervisor }).state, 'halted-recoverable');
});

test('a diagnosis carries no durations, so an unchanged situation does not look like a change', () => {
  const status = { overall: 'awaiting_chat', awaitingStage: 'coder', hostClient: 'antigravity' };
  const at = (t) => diagnose({ status, engineAlive: false, driver: none, waitingSince: ago(60_000), now: t });
  assert.deepEqual(at(now), at(now + 5 * 60_000));
});

test('every non-finished run is waiting on a named party or has a remedy, and never an empty explanation', () => {
  const reasons = [...Object.keys(HALT_REASONS), 'NOT_REGISTERED'];
  const statuses = [
    { overall: 'running' }, { overall: 'awaiting_chat', awaitingStage: 'coder' }, { overall: 'awaiting_plan_approval' },
    ...reasons.flatMap((haltReason) => [
      { overall: 'halted', haltReason }, { overall: 'halted', haltReason, haltedPhase: 'coder', haltTransient: true, featureId: 'F1' },
    ]),
  ];
  for (const status of statuses) {
    for (const engineAlive of [false, true]) {
      for (const driver of [none, cli, { kind: 'host-session', host: 'x', presence: 'quiet' }]) {
        for (const supervisor of [null, { alive: false }, { alive: true, paused: true }]) {
          const diag = diagnose({ status, engineAlive, driver, supervisor, waitingSince: ago(1000), lastEventAt: ago(1000), now });
          const label = JSON.stringify({ status, engineAlive, driver: driver.kind, supervisor });
          assert.ok(DOCTOR_STATES.includes(diag.state), `${label} -> ${diag.state}`);
          assert.ok(diag.explanation && diag.explanation.length > 10, `${label} has no explanation`);
          if (['finished', 'healthy'].includes(diag.state)) continue;
          assert.ok(diag.waitingOn || diag.remedies.length > 0 || diag.state === 'unknown', `${label} is neither waiting on anyone nor fixable`);
          for (const r of diag.remedies) assert.ok(r.command || r.shell, `${label}: remedy ${r.verb} has nothing to run`);
        }
      }
    }
  }
});
