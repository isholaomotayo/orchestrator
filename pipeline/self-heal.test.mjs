import test from 'node:test';
import assert from 'node:assert/strict';
import { planHeal, DEAD_ENGINE_GRACE_MS } from './self-heal.mjs';
import { diagnose, DOCTOR_STATES } from './doctor.mjs';

const now = Date.parse('2026-10-03T12:00:00Z');
const dead = diagnose({ status: { overall: 'running', featureId: 'F1' }, engineAlive: false, now });
const plan = (over = {}) => planHeal({
  diagnosis: dead, autonomy: 'autonomous', meta: {}, now, observedSince: now - 60_000, maxResumes: 2, ...over,
});

test('the fixture really is a dead engine whose resume the table lets run unattended', () => {
  assert.equal(dead.state, 'dead-engine');
  const resume = dead.remedies.find((r) => r.verb === 'resume');
  assert.equal(resume.safe, true);
  assert.equal(resume.auto, true);
});

test('only an autonomous run is healed; a guided one is left to the person, with the diagnosis', () => {
  assert.equal(plan({ autonomy: 'guided' }).action, 'none');
  assert.match(plan({ autonomy: 'guided' }).reason, /guided/);
  assert.equal(plan().action, 'respawn');
});

test('a dead engine is respawned only after it has stayed dead for the grace period', () => {
  assert.equal(plan({ observedSince: null }).action, 'wait', 'first sight: start the clock');
  const early = plan({ observedSince: now - 5_000 });
  assert.equal(early.action, 'wait');
  assert.equal(early.until, now - 5_000 + DEAD_ENGINE_GRACE_MS);
  assert.equal(plan({ observedSince: now - DEAD_ENGINE_GRACE_MS }).action, 'respawn');
});

test('a run that was only just spawned is not mistaken for a dead one', () => {
  const justSpawned = new Date(now - 4_000).toISOString();
  assert.equal(plan({ meta: { spawnedAt: justSpawned } }).action, 'wait');
});

test('attempts back off, and the budget is shared with the supervisor\'s other auto-resumes', () => {
  const lastHealAt = new Date(now - 1_000).toISOString();
  assert.equal(plan({ meta: { autoResumes: 1, lastHealAt } }).action, 'wait', 'too soon after the last attempt');
  const later = new Date(now - 60_000).toISOString();
  assert.equal(plan({ meta: { autoResumes: 1, lastHealAt: later } }).action, 'respawn');
});

test('when the budget is spent the run is handed back to a person, once, with the reason', () => {
  const spent = plan({ meta: { autoResumes: 2 } });
  assert.equal(spent.action, 'escalate');
  assert.equal(spent.flipToGuided, true);
  assert.equal(spent.kind, 'self-heal-exhausted');
  assert.match(spent.summary, /2/);
  assert.match(spent.summary, /engine/i);
  assert.equal(plan({ meta: { autoResumes: 2 }, maxResumes: 3 }).action, 'respawn', 'the budget is configurable');
});

test('it never acts on anything but a dead engine', () => {
  const statuses = [
    { overall: 'awaiting_plan_approval' }, { overall: 'awaiting_chat', awaitingStage: 'coder' }, { overall: 'done' },
    { overall: 'halted', haltReason: 'REGRESSION_BLOCKED' }, { overall: 'halted', haltReason: 'MERGE' },
    { overall: 'running' }, { overall: 'halted', haltReason: 'POOL_STOPPED' },
  ];
  for (const status of statuses) {
    for (const engineAlive of [false, true]) {
      const diagnosis = diagnose({ status, engineAlive, now });
      const out = planHeal({ diagnosis, autonomy: 'autonomous', meta: {}, now, observedSince: now - 3_600_000, maxResumes: 2 });
      if (diagnosis.state === 'dead-engine') continue;
      assert.equal(out.action, 'none', `${JSON.stringify(status)} alive=${engineAlive} (${diagnosis.state})`);
    }
  }
  assert.ok(DOCTOR_STATES.includes('dead-engine'));
});

test('a plan never carries a command: self-heal only ever restarts the same step', () => {
  for (const out of [plan(), plan({ meta: { autoResumes: 2 } }), plan({ observedSince: null }), plan({ autonomy: 'guided' })]) {
    assert.ok(['none', 'wait', 'respawn', 'escalate'].includes(out.action));
    assert.equal(out.command, undefined);
  }
});

// ---- watching the supervisor itself -----------------------------------------
import { planSupervisorWatch } from './self-heal.mjs';

const crashed = { pid: 4242, alive: false, heartbeatAt: '2026-10-03T11:40:00Z', paused: false };
const running = { pid: 4242, alive: true, heartbeatAt: '2026-10-03T11:59:58Z', paused: false };
const stopped = { pid: null, alive: false, heartbeatAt: null, paused: false };
const open = (id = 'a1') => [{ id, type: 'item', kind: 'supervisor-dead', runId: null }];

test('a supervisor that left a pid behind but is not running has crashed: raise one alert', () => {
  const out = planSupervisorWatch({ state: crashed, pending: [], now });
  assert.equal(out.raise.kind, 'supervisor-dead');
  assert.equal(out.raise.escalate, true);
  assert.equal(out.raise.runId, null);
  assert.match(out.raise.summary, /pool start/);
  assert.match(out.raise.summary, /2026-10-03T11:40:00Z/, 'says when it was last seen');
  assert.deepEqual(out.ack, []);
});

test('the alert is raised once, not on every check', () => {
  assert.equal(planSupervisorWatch({ state: crashed, pending: open(), now }).raise, undefined);
});

test('a supervisor that stopped cleanly, or never started, is not an emergency', () => {
  assert.equal(planSupervisorWatch({ state: stopped, pending: [], now }).raise, undefined);
});

test('the alert clears itself once the supervisor is back, or was stopped on purpose', () => {
  assert.deepEqual(planSupervisorWatch({ state: running, pending: open('a1'), now }).ack, ['a1']);
  assert.deepEqual(planSupervisorWatch({ state: stopped, pending: open('a2'), now }).ack, ['a2']);
  assert.deepEqual(planSupervisorWatch({ state: crashed, pending: open('a3'), now }).ack, [], 'still down: keep it');
});

test('only supervisor-dead items are ever acknowledged', () => {
  const other = [{ id: 'x', type: 'item', kind: 'ticket-held' }];
  assert.deepEqual(planSupervisorWatch({ state: running, pending: other, now }).ack, []);
});
