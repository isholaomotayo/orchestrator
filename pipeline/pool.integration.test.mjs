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
