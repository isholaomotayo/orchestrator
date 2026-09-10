// End-to-end proof that a roadmap actually runs: two features, parallel tickets
// inside one of them, a fan-in merge, an integration review, an operator merge
// approval, and the next feature starting from what landed.
//
// No model is called. A fake runner script reads the task text and writes the
// artifact that stage is contracted to produce, so this exercises the real
// engine, the real worktrees and the real git merges at full speed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pipelinePaths } from './state.mjs';
import { createSupervisor } from './supervisor.mjs';
import * as pool from './pool.mjs';

const ENGINE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(ENGINE_DIR);

function git(cwd, ...args) { return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim(); }

const FAKE_RUNNER = `import fs from 'node:fs';
const task = process.argv[2] || '';
const P = '.pipeline';
const w = (f, body) => { fs.mkdirSync(P, { recursive: true }); fs.writeFileSync(\`\${P}/\${f}\`, body); };

if (/technical specification|Alignment Log|tracer-bullet/i.test(task)) {
  // Two independent tickets, deliberately touching different files so they can
  // run in parallel and merge cleanly.
  w('specs.md', [
    '# Specification', '',
    '## 1. Alignment Log (Q&A)', 'Q: scope? A: as described.', '',
    '## 2. Technical Specification (PRD)',
    '- **Objective:** deliver the feature as described.', '',
    '### Edge Cases & Failure Modes',
    '| # | Case | Trigger | Required behavior | Proven by |',
    '|---|---|---|---|---|',
    '| E1 | missing input | none supplied | throws | rejects_missing |', '',
    '## 3. Tracer-Bullet Tickets',
    '### Ticket 1: alpha slice',
    '- **Goal:** add the alpha module',
    '- **Files:** alpha.mjs',
    '- **Dependencies:** None', '---',
    '### Ticket 2: beta slice',
    '- **Goal:** add the beta module',
    '- **Files:** beta.mjs',
    '- **Dependencies:** None', '',
  ].join('\\n'));
} else if (/Audit|Reviewer|read-only audit/i.test(task)) {
  w('review_report.md', [
    '## Verdict: APPROVED', '',
    '## 1. Standards & Architecture Axis', 'Consistent with the surrounding code.', '',
    '## 3. Spec Coverage Verification',
    '| ID | Status | Evidence |', '|---|---|---|', '| E1 | covered | added.test.mjs:1 |', '',
    '## 5. Summary', 'The work matches the specification and is covered by tests.', '',
  ].join('\\n'));
} else if (/rigorous tests|Tester|coverage map/i.test(task)) {
  const name = fs.existsSync('alpha.mjs') && !fs.existsSync('added-alpha.test.mjs') ? 'alpha' : 'beta';
  fs.writeFileSync(\`added-\${name}.test.mjs\`, "import test from 'node:test';\\nimport assert from 'node:assert/strict';\\ntest('\${name}', () => { assert.equal(1, 1); });\\n");
  w('test_suite.md', [
    '# Tests', '', '## Coverage Map',
    '| ID | Test | Location |', '|---|---|---|', \`| E1 | \${name} | added-\${name}.test.mjs:1 |\`, '',
    '## Uncovered / Deferred Coverage', 'Nothing deferred.', '',
  ].join('\\n'));
} else {
  // Coder: write the module this ticket names, so two tickets touch two files.
  const which = /beta/i.test(task) ? 'beta' : 'alpha';
  fs.writeFileSync(\`\${which}.mjs\`, \`export const \${which} = true;\\n\`);
  w('changes.md', [
    '# Changes', '', \`Added \${which}.mjs as the ticket requires.\`, '',
    '## Self-Review', '', '| ID | Handled | Where |', '|---|---|---|',
    \`| E1 | yes | \${which}.mjs:1 |\`, '', 'No known gaps.', '',
  ].join('\\n'));
}
`;

const ROADMAP = `---
version: 1
title: Integration fixture
base: main
merge: local-only
---

## F1: First feature
- depends_on: none
- max_parallel: 2
### Description
Deliver the alpha and beta modules.
### Acceptance
- [ ] the suite passes

## F2: Second feature
- depends_on: F1
### Description
Deliver a follow-up that builds on the first feature.
`;

function makeProject() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pool-it-')));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');

  fs.mkdirSync(path.join(root, '.pipeline', 'prompts'), { recursive: true });
  for (const f of fs.readdirSync(path.join(REPO, '.pipeline', 'prompts'))) {
    fs.copyFileSync(path.join(REPO, '.pipeline', 'prompts', f), path.join(root, '.pipeline', 'prompts', f));
  }
  // The engine runs from the project, so give it the module tree it imports.
  fs.symlinkSync(path.join(REPO, 'pipeline'), path.join(root, 'pipeline'), 'dir');

  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'fixture', version: '1.0.0', type: 'module', scripts: { test: 'node --test *.test.mjs' },
  }, null, 2));
  fs.writeFileSync(path.join(root, 'baseline.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('baseline', () => { assert.equal(1, 1); });\n");
  fs.writeFileSync(path.join(root, 'fake-runner.mjs'), FAKE_RUNNER);
  fs.writeFileSync(path.join(root, '.pipeline', 'roadmap.md'), ROADMAP);
  fs.writeFileSync(path.join(root, '.pipeline', 'config.json'), JSON.stringify({
    runner: 'fake',
    maxCoderCycles: 2,
    customRunners: { fake: { command: 'node', args: [path.join(root, 'fake-runner.mjs'), '{task}'] } },
    checks: { test: 'npm test --silent', lint: 'true', typecheck: 'true' },
    pool: { maxParallel: 2, featurePlanApproval: false, pollMs: 50, integrationFlags: { reviewPanel: false, report: false } },
    merge: { mode: 'local-only', autoMerge: false, cleanupOnMerge: true },
  }, null, 2));
  fs.writeFileSync(path.join(root, '.gitignore'), '.pipeline/runs/\n.pipeline/worktrees/\n.pipeline/control/\nnode_modules/\npipeline\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  return root;
}

// Play the part of the human in an IDE chat: read the stage handoff a
// host-runner run is parked at, produce exactly what the CLI fake runner
// would have produced for that stage, and continue — repeating until the run
// finishes. Every `--continue` here is the same command a real coordinator
// would type after claiming the run with `pool claim`.
function driveHostTicket(root, runId, which) {
  const p = pipelinePaths(root, { runId });
  for (let i = 0; i < 10; i++) {
    const status = JSON.parse(fs.readFileSync(p.status, 'utf8'));
    if (status.overall !== 'awaiting_chat') return status;
    const handoff = JSON.parse(fs.readFileSync(p.stageHandoff, 'utf8'));
    if (handoff.stage === 'coder') {
      fs.writeFileSync(path.join(p.worktree, `${which}.mjs`), `export const ${which} = true;\n`);
      fs.writeFileSync(p.changes, [
        '# Changes', '', `Added ${which}.mjs as the ticket requires.`, '',
        '## Self-Review', '', '| ID | Handled | Where |', '|---|---|---|',
        `| E1 | yes | ${which}.mjs:1 |`, '', 'No known gaps.', '',
      ].join('\n'));
    } else if (handoff.stage === 'tester') {
      fs.writeFileSync(path.join(p.worktree, `added-${which}.test.mjs`), `import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('${which}', () => { assert.equal(1, 1); });\n`);
      fs.writeFileSync(p.testSuite, [
        '# Tests', '', '## Coverage Map',
        '| ID | Test | Location |', '|---|---|---|', `| E1 | ${which} | added-${which}.test.mjs:1 |`, '',
        '## Uncovered / Deferred Coverage', 'Nothing deferred.', '',
      ].join('\n'));
    } else if (handoff.stage === 'reviewer') {
      fs.writeFileSync(p.reviewReport, [
        '## Verdict: APPROVED', '',
        '## 1. Standards & Architecture Axis', 'Consistent with the surrounding code.', '',
        '## 3. Spec Coverage Verification',
        '| ID | Status | Evidence |', '|---|---|---|', '| E1 | covered | added.test.mjs:1 |', '',
        '## 5. Summary', 'The work matches the specification and is covered by tests.', '',
      ].join('\n'));
    } else {
      throw new Error(`driveHostTicket does not know stage "${handoff.stage}"`);
    }
    execFileSync(process.execPath, ['pipeline/orchestrator.mjs', '--continue', '--run-id', runId], { cwd: root, encoding: 'utf8' });
  }
  throw new Error(`host ticket ${runId} did not finish within the iteration cap`);
}

// Drive ticks until `predicate` holds, so the test follows real child processes
// without sleeping for a fixed guess.
async function until(sup, predicate, { limit = 400, gap = 60 } = {}) {
  for (let i = 0; i < limit; i++) {
    sup.tick();
    const roadmap = pool.readRoadmap(sup.paths);
    if (predicate(roadmap, sup)) return roadmap;
    await new Promise((r) => setTimeout(r, gap));
  }
  const roadmap = pool.readRoadmap(sup.paths);
  throw new Error(`Condition never met. Features: ${JSON.stringify(roadmap?.features?.map((f) => [f.id, f.status, f.mergeState]))}`);
}

test('a roadmap runs features in order, tickets in parallel, and lands each one', async (t) => {
  const root = makeProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const paths = pipelinePaths(root);
  const compiled = pool.compile(paths);
  assert.equal(compiled.ok, true, JSON.stringify(compiled.errors));

  const sup = createSupervisor({ repoRoot: root });
  fs.writeFileSync(paths.supervisorPid, String(process.pid));

  // --- planning: the feature is decomposed into tickets ---------------------
  await until(sup, (rm) => rm.features[0].status === 'executing' && (rm.features[0].tickets || []).length >= 2);
  const executing = pool.readRoadmap(paths);
  assert.equal(executing.features[0].tickets.length, 2, 'the planner produced two tickets');

  // --- parallel: both tickets have their own run, branch and worktree --------
  const ticketRuns = executing.features[0].tickets.map((tk) => tk.runId).filter(Boolean);
  assert.equal(ticketRuns.length, 2, 'both tickets were dispatched');
  assert.equal(new Set(ticketRuns).size, 2, 'each ticket got its own run');

  // The workers are detached, so wait for the isolation to actually exist
  // rather than assuming it appears the instant they are spawned.
  let sawBothWorktrees = false;
  await until(sup, () => {
    sawBothWorktrees = sawBothWorktrees || ticketRuns.every((runId) => fs.existsSync(pipelinePaths(root, { runId }).worktree));
    const rm = pool.readRoadmap(sup.paths);
    // Stop early if the feature moves on: the evidence is already captured.
    return sawBothWorktrees || rm.features[0].status !== 'executing';
  });
  assert.ok(sawBothWorktrees, 'each ticket worked in its own isolated worktree');
  const branches = git(root, 'branch', '--list').split('\n').map((b) => b.replace(/^[*+ ]+/, ''));
  for (const runId of ticketRuns) {
    assert.ok(branches.some((b) => b.includes(runId)), `${runId} committed on its own branch`);
  }

  // --- fan-in and review ----------------------------------------------------
  await until(sup, (rm) => ['reviewing', 'awaiting_merge_approval', 'landed'].includes(rm.features[0].status));
  const reviewed = await until(sup, (rm) => rm.features[0].status === 'awaiting_merge_approval');
  const f1 = reviewed.features[0];
  assert.ok(f1.integrationRunId, 'an integration run reviewed the whole feature');
  const integration = JSON.parse(fs.readFileSync(pipelinePaths(root, { runId: f1.integrationRunId }).status, 'utf8'));
  assert.equal(integration.verdict, 'APPROVED');

  // Both tickets' work is on the feature branch, merged, before any approval.
  const featureFiles = git(root, 'ls-tree', '-r', '--name-only', f1.branch).split('\n');
  assert.ok(featureFiles.includes('alpha.mjs'), 'ticket 1 work is on the feature branch');
  assert.ok(featureFiles.includes('beta.mjs'), 'ticket 2 work is on the feature branch');

  // --- the gate: nothing merges until the operator says so ------------------
  const baseBefore = git(root, 'rev-parse', 'main');
  sup.tick();
  assert.equal(git(root, 'rev-parse', 'main'), baseBefore, 'the base must not move before approval');
  const decisions = pool.openDecisions(paths);
  assert.ok(decisions.some((d) => d.kind === 'merge-approval' && d.featureId === 'F1'), 'the operator was asked');

  // --- approve, then it lands ----------------------------------------------
  pool.approveMerge(paths, 'F1', { by: 'test', via: 'cli' });
  const landed = await until(sup, (rm) => rm.features[0].status === 'landed');
  assert.notEqual(git(root, 'rev-parse', 'main'), baseBefore, 'the feature reached the base branch');
  const mainFiles = git(root, 'ls-tree', '-r', '--name-only', 'main').split('\n');
  assert.ok(mainFiles.includes('alpha.mjs') && mainFiles.includes('beta.mjs'), 'both tickets landed together');
  assert.ok(landed.features[0].landedSha, 'the landed commit is recorded');

  // --- the next feature starts from what actually landed --------------------
  const next = await until(sup, (rm) => rm.features[1].status !== 'queued');
  assert.equal(next.features[1].baseRef, landed.features[0].landedSha, 'F2 branches from F1 as merged');

  // --- worktrees are cleaned up, run history is kept ------------------------
  for (const runId of ticketRuns) {
    assert.ok(!fs.existsSync(pipelinePaths(root, { runId }).worktree), `${runId} worktree was cleaned up`);
    assert.ok(fs.existsSync(pipelinePaths(root, { runId }).status), `${runId} state is kept as the audit trail`);
  }

  // --- the snapshot and the v1 mirror both tell the truth -------------------
  const snap = JSON.parse(fs.readFileSync(paths.snapshot, 'utf8'));
  assert.equal(snap.contract, 'orchestrator-pool-snapshot.v1');
  assert.ok(snap.recentlyLanded.some((f) => f.featureId === 'F1'));
  const mirror = JSON.parse(fs.readFileSync(paths.status, 'utf8'));
  assert.ok(mirror.pool, 'the v1 status file reflects the pool');
  assert.equal(mirror.stages.length, 7, 'and still parses as a v1 status');
});

test('a failing review is escalated instead of being merged', async (t) => {
  const root = makeProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // Make the reviewer refuse.
  const runner = fs.readFileSync(path.join(root, 'fake-runner.mjs'), 'utf8').replace("'## Verdict: APPROVED'", "'## Verdict: REQUEST_CHANGES'");
  fs.writeFileSync(path.join(root, 'fake-runner.mjs'), runner);
  // One review fix pass, so the run ends rather than looping.
  const cfg = JSON.parse(fs.readFileSync(path.join(root, '.pipeline', 'config.json'), 'utf8'));
  cfg.maxReviewCycles = 1;
  fs.writeFileSync(path.join(root, '.pipeline', 'config.json'), JSON.stringify(cfg, null, 2));
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'refuse');

  const paths = pipelinePaths(root);
  pool.compile(paths);
  const sup = createSupervisor({ repoRoot: root });
  fs.writeFileSync(paths.supervisorPid, String(process.pid));

  const rm = await until(sup, (r) => ['failed', 'landed'].includes(r.features[0].status), { limit: 500 });
  assert.equal(rm.features[0].status, 'failed', 'an unapproved feature must not land');
  assert.equal(git(root, 'rev-parse', 'main'), git(root, 'rev-parse', 'main'));
  const mainFiles = git(root, 'ls-tree', '-r', '--name-only', 'main').split('\n');
  assert.ok(!mainFiles.includes('alpha.mjs'), 'nothing reached the base branch');
  const pending = pool.pendingAttention(paths);
  assert.ok(pending.some((a) => /not approved|halted|review/i.test(a.summary)), 'the operator was told');
});

test('a feature whose configured runner is unusable never spawns; the supervisor raises runner-unavailable instead', async (t) => {
  const root = makeProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cfgFile = path.join(root, '.pipeline', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  // Neither a known CLI name nor a declared custom runner: a misconfiguration,
  // not a missing CLI auth — deterministic regardless of what happens to be
  // authenticated on the machine running this test.
  cfg.runner = 'not-configured';
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'misconfigure runner');

  const paths = pipelinePaths(root);
  pool.compile(paths);
  const sup = createSupervisor({ repoRoot: root });
  fs.writeFileSync(paths.supervisorPid, String(process.pid));

  sup.tick();
  const rm = pool.readRoadmap(paths);
  assert.equal(rm.features[0].status, 'failed', 'an unusable runner fails the feature instead of leaving it planning');
  const specRunId = rm.features[0].specRunId;
  assert.ok(specRunId, 'a run id was still allocated');
  const runPaths = pipelinePaths(root, { runId: specRunId });
  const status = JSON.parse(fs.readFileSync(runPaths.status, 'utf8'));
  assert.equal(status.overall, 'halted');
  assert.equal(status.haltReason, 'RUNNER_UNAVAILABLE');
  assert.equal(status.haltTransient, false);
  const meta = JSON.parse(fs.readFileSync(runPaths.runMeta, 'utf8'));
  assert.equal(meta.phase, 'failed');
  const pending = pool.pendingAttention(paths);
  assert.ok(pending.some((a) => a.kind === 'runner-unavailable' && /not-configured/.test(a.summary)), 'the operator was told exactly why');
});

test('a mixed feature runs one ticket on a CLI and the other on host, landing both', async (t) => {
  const root = makeProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // The beta ticket is host-runner; the alpha ticket keeps the fake CLI.
  const runner = fs.readFileSync(path.join(root, 'fake-runner.mjs'), 'utf8').replace(
    "    '- **Dependencies:** None', '',\n  ].join('\\n'));",
    "    '- **Dependencies:** None',\n    '- **Runner:** host', '',\n  ].join('\\n'));",
  );
  assert.notEqual(runner, fs.readFileSync(path.join(root, 'fake-runner.mjs'), 'utf8'), 'the runner bullet was actually inserted');
  fs.writeFileSync(path.join(root, 'fake-runner.mjs'), runner);
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'beta ticket runs on host');

  const paths = pipelinePaths(root);
  pool.compile(paths);
  const sup = createSupervisor({ repoRoot: root });
  fs.writeFileSync(paths.supervisorPid, String(process.pid));

  const executing = await until(sup, (rm) => rm.features[0].status === 'executing' && (rm.features[0].tickets || []).length >= 2);
  const ticketMetas = executing.features[0].tickets.map((tk) => ({
    ticket: tk, meta: JSON.parse(fs.readFileSync(pipelinePaths(root, { runId: tk.runId }).runMeta, 'utf8')),
  }));
  const hostTicket = ticketMetas.find((t) => t.meta.runner === 'host');
  const cliTicket = ticketMetas.find((t) => t.meta.runner !== 'host');
  assert.ok(hostTicket && cliTicket, 'exactly one ticket resolved to host, the other to the CLI runner');
  assert.equal(hostTicket.meta.pid, null, 'a host-runner ticket never gets a process pid');

  driveHostTicket(root, hostTicket.ticket.runId, 'beta');

  await until(sup, (rm) => rm.features[0].status === 'awaiting_merge_approval');
  pool.approveMerge(paths, 'F1', { by: 'test', via: 'cli' });
  const landed = await until(sup, (rm) => ['landed', 'failed'].includes(rm.features[0].status), { limit: 500 });
  assert.equal(landed.features[0].status, 'landed', 'the mixed feature landed');
  const mainFiles = git(root, 'ls-tree', '-r', '--name-only', 'main').split('\n');
  assert.ok(mainFiles.includes('alpha.mjs') && mainFiles.includes('beta.mjs'), 'both the CLI and host ticket work landed');
  // The host ticket's process metadata never gained a pid at any point.
  const finalMeta = JSON.parse(fs.readFileSync(pipelinePaths(root, { runId: hostTicket.ticket.runId }).runMeta, 'utf8'));
  assert.equal(finalMeta.pid, null);
});

test('review: end accepts features onto a working branch and waits for a final land', async (t) => {
  const root = makeProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, '.pipeline', 'roadmap.md'), ROADMAP.replace('merge: local-only', 'merge: local-only\nreview: end'));
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'review end');

  const paths = pipelinePaths(root);
  const compiled = pool.compile(paths);
  assert.equal(compiled.ok, true, JSON.stringify(compiled.errors));
  assert.equal(compiled.roadmap.review, 'end');

  const sup = createSupervisor({ repoRoot: root });
  fs.writeFileSync(paths.supervisorPid, String(process.pid));

  // review: end distinguishes acceptance onto the working (roadmap) branch from
  // landing on the target branch — a feature's own status stops at 'accepted'
  // until the whole roadmap is approved and merged into base.
  const f1 = await until(sup, (rm) => rm.features[0].status === 'accepted', { limit: 500 });
  const init = git(root, 'rev-parse', 'HEAD');
  assert.equal(git(root, 'rev-parse', 'main'), init, 'review: end must not touch the base when F1 is accepted');
  assert.equal(f1.features[0].status, 'accepted');
  const working = f1.workingBranch;
  assert.ok(working, 'a working branch was recorded');
  const workingFiles = git(root, 'ls-tree', '-r', '--name-only', working).split('\n');
  assert.ok(workingFiles.includes('alpha.mjs') && workingFiles.includes('beta.mjs'), 'accepted work is on the working branch');

  const f2started = await until(sup, (rm) => rm.features[1].status !== 'queued');
  assert.equal(f2started.features[1].baseRef, f1.features[0].landedSha, 'F2 starts from the accepted F1 sha');

  const both = await until(sup, (rm) => rm.features[1].status === 'accepted' && rm.roadmapStatus === 'awaiting_final_review', { limit: 600 });
  assert.equal(git(root, 'rev-parse', 'main'), init, 'the base is still untouched after every feature is accepted');
  assert.equal(both.roadmapStatus, 'awaiting_final_review');
  const decisions = pool.openDecisions(paths);
  assert.ok(decisions.some((d) => d.kind === 'roadmap-merge'), 'the operator was asked to land the roadmap');

  pool.landRoadmap(paths, { by: 'test', via: 'cli' });
  await until(sup, (rm) => rm.roadmapStatus === 'landed');
  assert.notEqual(git(root, 'rev-parse', 'main'), init, 'the working branch reached the base after the final land');
  const mainFiles = git(root, 'ls-tree', '-r', '--name-only', 'main').split('\n');
  assert.ok(mainFiles.includes('alpha.mjs') && mainFiles.includes('beta.mjs'));
});

test('MAX_CYCLES auto-extends once without an operator verb, then stops asking', async (t) => {
  const root = makeProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = pipelinePaths(root);
  pool.compile(paths);

  const spawned = [];
  const sup = createSupervisor({
    repoRoot: root,
    spawn: (_cmd, args) => {
      spawned.push(args);
      return { pid: 4242, unref() {} };
    },
  });
  fs.writeFileSync(paths.supervisorPid, String(process.pid));

  const { setFeatureStatus } = await import('./roadmap.mjs');
  const runId = '20260907T000000Z-F1-T1-deadbeef';
  let rm = pool.readRoadmap(paths);
  rm = setFeatureStatus(rm, 'F1', 'executing', {
    specRunId: 'plan-1',
    tickets: [{ id: 'T1', title: 't', runId, status: 'running' }],
    baseRef: git(root, 'rev-parse', 'HEAD'),
  });
  pool.writeRoadmap(paths, rm);

  const rp = pipelinePaths(root, { runId });
  fs.mkdirSync(rp.dir, { recursive: true });
  fs.writeFileSync(rp.status, JSON.stringify({ overall: 'halted', haltReason: 'MAX_CYCLES', featureId: 'F1' }));
  fs.writeFileSync(rp.runMeta, JSON.stringify({
    runId, featureId: 'F1', ticketId: 'T1', kind: 'ticket', runner: 'fake',
  }));

  sup.tick();
  assert.ok(spawned.some((args) => args.includes('--extend')), 'the supervisor auto-extended');
  assert.equal(pool.readRoadmap(paths).features[0].status, 'executing', 'the feature was not failed on the auto-resume tick');
  const meta = JSON.parse(fs.readFileSync(rp.runMeta, 'utf8'));
  assert.equal(meta.autoCycleExtends, 1);

  spawned.length = 0;
  sup.tick();
  assert.equal(spawned.filter((args) => args.includes('--extend')).length, 0, 'MAX_CYCLES is not auto-extended a second time');
  assert.equal(pool.readRoadmap(paths).features[0].status, 'failed');
});

test('pool retry requeues a failed feature so the supervisor plans it again', async (t) => {
  const root = makeProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = pipelinePaths(root);
  pool.compile(paths);
  const { setFeatureStatus } = await import('./roadmap.mjs');
  let rm = pool.readRoadmap(paths);
  rm = setFeatureStatus(rm, 'F1', 'failed', { baseRef: git(root, 'rev-parse', 'HEAD'), specRunId: 'old-plan' });
  pool.writeRoadmap(paths, rm);

  pool.retryFeature(paths, 'F1');
  assert.equal(pool.readRoadmap(paths).features[0].status, 'queued');

  const sup = createSupervisor({ repoRoot: root });
  fs.writeFileSync(paths.supervisorPid, String(process.pid));
  await until(sup, (r) => r.features[0].status === 'planning' || r.features[0].status === 'executing');
  const after = pool.readRoadmap(paths);
  assert.notEqual(after.features[0].specRunId, 'old-plan');
  assert.ok(['planning', 'executing'].includes(after.features[0].status));
});

test('a resolved merge-conflict rerun-ticket leaves integrating', async (t) => {
  const root = makeProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = pipelinePaths(root);
  pool.compile(paths);
  const { setFeatureStatus } = await import('./roadmap.mjs');
  const { openDecision } = await import('./attention.mjs');

  const specRunId = '20260907T000000Z-F1-plan-cafe';
  const specPaths = pipelinePaths(root, { runId: specRunId });
  fs.mkdirSync(specPaths.dir, { recursive: true });
  fs.writeFileSync(specPaths.specs, '# Specification\n\n## 3. Tracer-Bullet Tickets\n### Ticket 1: alpha\n- **Files:** alpha.mjs\n');

  let rm = pool.readRoadmap(paths);
  rm = setFeatureStatus(rm, 'F1', 'integrating', {
    specRunId,
    tickets: [
      { id: 'T1', title: 'alpha', runId: 't1', status: 'committed' },
      { id: 'T2', title: 'beta', runId: 't2', status: 'committed' },
    ],
    conflict: { ticketId: 'T1' },
    integrationRunId: 'int-1',
  });
  pool.writeRoadmap(paths, rm);
  const decision = openDecision(paths, {
    runId: 'int-1', featureId: 'F1', kind: 'merge-conflict', stage: 'coder',
    question: 'resolve?', options: ['rerun-ticket', 'drop-ticket'], recommended: 'rerun-ticket',
  });
  pool.decide(paths, decision.id, 'rerun-ticket');

  const sup = createSupervisor({ repoRoot: root });
  fs.writeFileSync(paths.supervisorPid, String(process.pid));
  sup.tick();
  const after = pool.readRoadmap(paths);
  assert.notEqual(after.features[0].status, 'integrating', 'the supervisor acted on the decision');
  assert.equal(after.features[0].status, 'executing');
  assert.ok(['queued', 'running'].includes(after.features[0].tickets.find((tk) => tk.id === 'T1').status));
});

