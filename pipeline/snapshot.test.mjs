import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot, renderDigest, POOL_SNAPSHOT_CONTRACT } from './snapshot.mjs';

const roadmap = {
  title: 'Billing v2', base: 'main', merge: 'pr', currentFeatureId: 'F2',
  features: [
    { id: 'F1', title: 'Invoice model', status: 'landed', dependsOn: [], pr: { url: 'https://example.test/pr/1' }, landedSha: 'abc', landedAt: '2026-09-06T10:00:00Z', reportRel: 'runs/x/reports/work-done.html' },
    { id: 'F2', title: 'PDF export', status: 'executing', dependsOn: ['F1'], tickets: [{ id: 'T1', runId: 'r1' }, { id: 'T2', runId: 'r2' }] },
    { id: 'F3', title: 'Email delivery', status: 'queued', dependsOn: ['F2'] },
  ],
};

const runs = [
  { runId: 'r1', featureId: 'F2', ticketId: 'T1', kind: 'ticket', state: 'busy', stage: 'coder', cycle: 2, maxCycles: 5, verb: 'working', lastOutputAt: '2026-09-06T11:59:00Z', worktree: '.pipeline/worktrees/r1', costUsd: 1.25 },
  { runId: 'r2', featureId: 'F2', ticketId: 'T2', kind: 'ticket', state: 'awaiting', stage: 'planner', verb: 'needs-decision', worktree: '.pipeline/worktrees/r2', costUsd: 0.5 },
];

const decisions = [
  { decisionId: 'd1', status: 'open', runId: 'r2', featureId: 'F2', kind: 'plan-approval', question: 'Approve the plan for T2?', options: ['approve', 'revise'], recommended: 'approve', ts: '2026-09-06T11:30:00Z', artifacts: ['.pipeline/runs/r2/specs.md'] },
  { decisionId: 'd0', status: 'resolved', runId: 'r0', kind: 'blocked', question: 'old', decision: 'retry' },
];

const supervisor = { pid: 42, alive: true, startedAt: '2026-09-06T09:00:00Z', paused: false, heartbeatAt: '2026-09-06T11:59:30Z' };

const snap = () => buildSnapshot({ roadmap, runs, decisions, attention: [], supervisor, skills: [{ name: 'archify', status: 'verified' }], now: new Date('2026-09-06T12:00:00Z') });

test('the snapshot is versioned so a consumer can refuse an unknown shape', () => {
  assert.equal(snap().contract, POOL_SNAPSHOT_CONTRACT);
  assert.match(snap().contract, /\.v1$/);
});

test('the snapshot carries exactly the four operator-facing sections', () => {
  const s = snap();
  for (const key of ['needsDecision', 'recentlyLanded', 'inProgress', 'upNext']) {
    assert.ok(Array.isArray(s[key]), `${key} must be an array`);
  }
});

test('open decisions surface with their options and evidence; resolved ones do not', () => {
  const s = snap();
  assert.equal(s.needsDecision.length, 1);
  const item = s.needsDecision[0];
  assert.equal(item.decisionId, 'd1');
  assert.equal(item.kind, 'plan-approval');
  assert.deepEqual(item.options, ['approve', 'revise']);
  assert.equal(item.recommended, 'approve');
  assert.deepEqual(item.artifacts, ['.pipeline/runs/r2/specs.md']);
});

test('landed features appear newest first with their PR and report', () => {
  const s = snap();
  assert.equal(s.recentlyLanded.length, 1);
  assert.equal(s.recentlyLanded[0].featureId, 'F1');
  assert.equal(s.recentlyLanded[0].pr.url, 'https://example.test/pr/1');
  assert.equal(s.recentlyLanded[0].reportRel, 'runs/x/reports/work-done.html');
});

test('in-progress runs report stage, cycle and liveness', () => {
  const s = snap();
  assert.equal(s.inProgress.length, 2);
  const r1 = s.inProgress.find((r) => r.runId === 'r1');
  assert.equal(r1.stage, 'coder');
  assert.equal(r1.cycle, 2);
  assert.equal(r1.state, 'busy');
  assert.equal(r1.featureId, 'F2');
});

test('up next lists queued features and what blocks them', () => {
  const s = snap();
  const f3 = s.upNext.find((u) => u.featureId === 'F3');
  assert.ok(f3);
  assert.deepEqual(f3.blockedBy, ['F2']);
});

test('counts summarise the pool at a glance', () => {
  const s = snap();
  assert.equal(s.counts.inProgress, 2);
  assert.equal(s.counts.decisions, 1);
  assert.equal(s.counts.landed, 1);
  assert.equal(s.counts.queued, 1);
});

test('total cost is summed across every run', () => {
  assert.equal(snap().totals.costUsd, 1.75);
});

test('an unverified skill is surfaced rather than silently disabled', () => {
  const s = buildSnapshot({ roadmap, runs, decisions, attention: [], supervisor, skills: [{ name: 'archify', status: 'mismatch' }], now: new Date() });
  assert.equal(s.skills[0].status, 'mismatch');
});

test('a dead supervisor is reported as not alive', () => {
  const s = buildSnapshot({ roadmap, runs, decisions, attention: [], supervisor: { pid: 42, alive: false }, now: new Date() });
  assert.equal(s.supervisor.alive, false);
});

test('an empty pool produces a valid, empty snapshot rather than throwing', () => {
  const s = buildSnapshot({ roadmap: null, runs: [], decisions: [], attention: [], supervisor: null, now: new Date() });
  assert.equal(s.contract, POOL_SNAPSHOT_CONTRACT);
  assert.deepEqual(s.needsDecision, []);
  assert.equal(s.counts.inProgress, 0);
});

// ---- digest ----------------------------------------------------------------

test('the digest renders the four sections in operator language', () => {
  const text = renderDigest(snap());
  assert.match(text, /## Needs your decision/);
  assert.match(text, /## Recently landed/);
  assert.match(text, /## In progress/);
  assert.match(text, /## Up next/);
  // No nautical vocabulary anywhere in the operator-facing output.
  assert.doesNotMatch(text, /captain|crew|fleet|bearings|ahoy/i);
});

test('the digest names the decision, the run and how to answer it', () => {
  const text = renderDigest(snap());
  assert.match(text, /Approve the plan for T2\?/);
  assert.match(text, /d1/);
  assert.match(text, /F2/);
});

test('an empty section says so instead of rendering an empty heading', () => {
  const text = renderDigest(buildSnapshot({ roadmap: null, runs: [], decisions: [], attention: [], supervisor: null, now: new Date() }));
  assert.match(text, /Nothing needs your attention|Nothing needs your decision/i);
});

test('a failed feature appears as something needing the operator, not silence', () => {
  // The digest saying "nothing needs your decision" while the roadmap is stuck
  // behind a failed feature is worse than no digest at all.
  const stuck = { ...roadmap, features: [{ ...roadmap.features[1], status: 'failed' }] };
  const s = buildSnapshot({ roadmap: stuck, runs: [], decisions: [], attention: [], supervisor, now: new Date() });
  assert.equal(s.needsDecision.length, 1);
  assert.equal(s.needsDecision[0].kind, 'feature-failed');
  assert.equal(s.needsDecision[0].decisionId, null);
  const text = renderDigest(s);
  assert.match(text, /did not complete/);
  assert.doesNotMatch(text, /pool decide null/);
});

test('a failed feature tells the operator how to retry it', () => {
  const failed = { ...roadmap, features: [{ ...roadmap.features[1], status: 'failed' }] };
  const text = renderDigest(buildSnapshot({ roadmap: failed, runs: [], decisions: [], attention: [], supervisor, now: new Date() }));
  assert.match(text, /pool retry F2/);
});

test('a review:end roadmap waiting for a final land surfaces as a decision', () => {
  const done = {
    ...roadmap,
    review: 'end',
    roadmapStatus: 'awaiting_final_review',
    workingBranch: 'pipeline/roadmap/billing-v2',
    features: roadmap.features.map((f) => ({ ...f, status: 'landed' })),
  };
  const s = buildSnapshot({ roadmap: done, runs: [], decisions: [], attention: [], supervisor, now: new Date() });
  assert.ok(s.needsDecision.some((d) => d.kind === 'roadmap-merge'));
  assert.match(renderDigest(s), /pool approve-merge|pool land-roadmap/);
});
test('a held feature says how to release it', () => {
  const held = { ...roadmap, features: [{ ...roadmap.features[1], status: 'held', heldReason: 'waiting on design' }] };
  const text = renderDigest(buildSnapshot({ roadmap: held, runs: [], decisions: [], attention: [], supervisor, now: new Date() }));
  assert.match(text, /waiting on design/);
  assert.match(text, /roadmap release F2/);
});

test('a claim-run item tells the operator exactly which command picks it up', () => {
  const s = buildSnapshot({
    roadmap: null, runs: [], decisions: [], supervisor,
    attention: [{ id: 'a1', escalate: true, kind: 'claim-run', runId: 'r9', summary: 'Ready for a human to complete the "coder" stage in chat.', ts: '2026-09-06T11:00:00Z' }],
    now: new Date(),
  });
  assert.equal(s.needsDecision.length, 1);
  assert.match(renderDigest(s), /pool claim r9/);
});

test('an escalation with no decision attached still reaches the operator', () => {
  const s = buildSnapshot({
    roadmap: null, runs: [], decisions: [], supervisor,
    attention: [{ id: 'a1', escalate: true, kind: 'dead', runId: 'r9', summary: 'The worker process is gone', ts: '2026-09-06T11:00:00Z' }],
    now: new Date(),
  });
  assert.equal(s.needsDecision.length, 1);
  assert.match(renderDigest(s), /worker process is gone/);
});

test('a feature already covered by a decision is not listed twice', () => {
  const stuck = { ...roadmap, features: [{ ...roadmap.features[1], status: 'failed' }] };
  const s = buildSnapshot({
    roadmap: stuck, runs: [], supervisor, attention: [],
    decisions: [{ decisionId: 'd9', status: 'open', featureId: 'F2', kind: 'merge-conflict', question: 'resolve?', options: [] }],
    now: new Date(),
  });
  assert.equal(s.needsDecision.length, 1);
  assert.equal(s.needsDecision[0].decisionId, 'd9');
});

test('feature runIds include the plan, ticket, and integration lineage', () => {
  const withPlan = {
    ...roadmap,
    features: [
      { ...roadmap.features[1], specRunId: 'plan-1', integrationRunId: 'int-1', acceptance: '- PDF renders', tickets: [{ id: 'T1', runId: 'r1' }, { id: 'T2', runId: 'r2' }] },
    ],
  };
  const s = buildSnapshot({ roadmap: withPlan, runs, decisions: [], attention: [], supervisor, now: new Date('2026-09-06T12:00:00Z') });
  assert.deepEqual(s.roadmap.features[0].runIds, ['plan-1', 'r1', 'r2', 'int-1']);
  const r1 = s.inProgress.find((r) => r.runId === 'r1');
  assert.equal(r1.goal.featureId, 'F2');
  assert.equal(r1.goal.acceptance, '- PDF renders');
  assert.equal(r1.goal.specRunId, 'plan-1');
});

// ---- Overview's six-way breakdown -------------------------------------------

test('counts split runs into the six overview buckets: executing, awaiting-agent, disconnected, blocked, awaiting-user, queued', () => {
  const runsWithAllStates = [
    ...runs, // r1: busy (executing), r2: awaiting with no owner (awaiting-agent)
    { runId: 'r3', featureId: 'F2', ticketId: 'T3', kind: 'ticket', state: 'awaiting', owner: { capability: 'disconnected' } },
    { runId: 'r4', featureId: 'F2', ticketId: 'T4', kind: 'ticket', state: 'dead' },
    { runId: 'r5', featureId: 'F2', ticketId: 'T5', kind: 'ticket', overall: 'halted', state: 'idle' },
  ];
  const s = buildSnapshot({ roadmap, runs: runsWithAllStates, decisions, attention: [], supervisor, now: new Date('2026-09-06T12:00:00Z') });
  assert.equal(s.counts.executing, 1, 'r1 (busy) is executing');
  assert.equal(s.counts.awaitingAgent, 1, 'r2 (awaiting, no owner) is awaiting-agent');
  assert.equal(s.counts.disconnected, 1, 'r3 (awaiting, disconnected owner) is disconnected');
  assert.equal(s.counts.blocked, 2, 'r4 (dead) and r5 (halted) are both blocked');
  // awaitingUser counts every needsDecision entry, not just formal decisions:
  // d1 (the open plan-approval) plus r4 (dead) and r5 (halted) each synthesize
  // their own escalation.
  assert.equal(s.counts.awaitingUser, 3, 'd1, r4 (dead), and r5 (halted) each need a person');
  assert.equal(s.counts.queued, 1, 'F3 is the one queued feature');
});

test('runner, spawnedAt, and reportRel survive from a raw run record into inProgress', () => {
  const runsWithProvenance = [
    { runId: 'r1', featureId: 'F2', ticketId: 'T1', kind: 'ticket', state: 'busy', runner: 'claude', spawnedAt: '2026-09-06T11:00:00Z', reportRel: '.pipeline/runs/r1/reports/work-done.html' },
  ];
  const s = buildSnapshot({ roadmap, runs: runsWithProvenance, decisions: [], attention: [], supervisor, now: new Date('2026-09-06T12:00:00Z') });
  const r1 = s.inProgress.find((r) => r.runId === 'r1');
  assert.equal(r1.runner, 'claude');
  assert.equal(r1.spawnedAt, '2026-09-06T11:00:00Z');
  assert.equal(r1.reportRel, '.pipeline/runs/r1/reports/work-done.html');
});

test('hostClient, invocationMode, and runnerRequested survive into inProgress — the dashboard cannot show a run\'s mode outside its own tab without them', () => {
  const runsWithMode = [
    { runId: 'r1', featureId: 'F2', ticketId: 'T1', kind: 'ticket', state: 'awaiting', runner: 'host', hostClient: 'antigravity', invocationMode: 'chat', runnerRequested: 'cursor' },
  ];
  const s = buildSnapshot({ roadmap, runs: runsWithMode, decisions: [], attention: [], supervisor, now: new Date('2026-09-06T12:00:00Z') });
  const r1 = s.inProgress.find((r) => r.runId === 'r1');
  assert.equal(r1.hostClient, 'antigravity');
  assert.equal(r1.invocationMode, 'chat');
  assert.equal(r1.runnerRequested, 'cursor');
});

test('hostClient/invocationMode/runnerRequested default to null rather than being omitted for a run recorded before mode-tracking existed', () => {
  const legacyRun = [{ runId: 'r1', featureId: 'F2', ticketId: 'T1', kind: 'ticket', state: 'busy', runner: 'claude' }];
  const s = buildSnapshot({ roadmap, runs: legacyRun, decisions: [], attention: [], supervisor, now: new Date('2026-09-06T12:00:00Z') });
  const r1 = s.inProgress.find((r) => r.runId === 'r1');
  assert.equal(r1.hostClient, null);
  assert.equal(r1.invocationMode, null);
  assert.equal(r1.runnerRequested, null);
});

test('dismissed runs are excluded from needsDecision, inProgress, and blocked count', () => {
  const stuckRuns = [
    { runId: 'r_dead', state: 'dead', overall: 'running', dismissed: true },
    { runId: 'r_unknown', state: 'unknown', overall: null, dismissed: true },
    { runId: 'r_active', state: 'busy', overall: 'running', dismissed: false },
  ];
  const s = buildSnapshot({ roadmap, runs: stuckRuns, decisions: [], attention: [], supervisor, now: new Date('2026-09-06T12:00:00Z') });
  assert.equal(s.needsDecision.some((d) => d.runId === 'r_dead'), false);
  assert.equal(s.needsDecision.some((d) => d.runId === 'r_unknown'), false);
  assert.equal(s.inProgress.some((r) => r.runId === 'r_dead'), false);
  assert.equal(s.inProgress.some((r) => r.runId === 'r_unknown'), false);
  assert.equal(s.counts.blocked, 0);
  assert.equal(s.history.some((r) => r.runId === 'r_dead'), true);
});
