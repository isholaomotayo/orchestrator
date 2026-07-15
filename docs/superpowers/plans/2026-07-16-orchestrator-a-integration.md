# Orchestrator A Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate the Orchestrator A architecture into the pipeline: a self-interrogating Planner, an optional `--approve-plan` human gate, a flag-gated read-only Designer stage (Design-It-Twice), a dual-axis Reviewer prompt, and a Handoff phase (deterministic doc on every halt; agent-compiled doc on `--handoff` after an approved run), with a six-stage status schema (`skipped` support) and a reference-don't-inline rule in every prompt.

**Architecture:** The proven 4-stage engine (`pipeline/orchestrator.mjs` state machine with chat/CLI dual mode, resume points, and mutex lock) is extended, not replaced. `STAGES` grows to six with optional stages marked `skipped`. Planner and Reviewer changes are prompt-only. Two new engine paths: an `awaiting_plan_approval` pause state, and a soft-failure Handoff stage plus a pure deterministic handoff compiler (`pipeline/handoff.mjs`) invoked from `halt()`.

**Tech Stack:** Node.js ≥18 ES modules, `node --test` + `node:assert/strict` for tests, zero runtime dependencies. Bash entrypoint `.pipeline/orchestrate.sh`. Single-file vanilla-JS dashboard `pipeline/dashboard.html`.

**Spec:** `docs/superpowers/specs/2026-07-16-orchestrator-a-integration-design.md`

## Global Constraints

- Node ≥18, ESM (`.mjs`), no new runtime dependencies.
- The Reviewer verdict contract is load-bearing: `review_report.md` MUST contain a line matching `/##\s*Verdict:\s*\[?\s*(APPROVED|REQUEST_CHANGES|BLOCK)/i` and a numbered, self-contained `## 4. Final Recommendations / Action Items` section (consumed verbatim by the automatic fix pass).
- Coder behavior stays implement-then-checker. The ONLY two Coder-prompt changes allowed: (1) read `design.md` Final Contracts when present, (2) drop the raw-diff requirement from `changes.md`.
- Reference-don't-inline in every prompt: cite `path:line`; never paste file bodies; quote at most the minimal relevant snippet.
- New flags default OFF: `--approve-plan` / `approvePlan`, `--design` / `designStage`, `--handoff` / `handoffStage`.
- Stage status values: `pending | running | passed | failed | blocked | skipped` (+ transient `interrupted`, `awaiting_host`). Overall values: `running | awaiting_chat | awaiting_plan_approval | done | halted`.
- Deterministic halt handoff must never mask the original halt (wrap in try/catch, best-effort).
- Handoff-agent failure after an APPROVED verdict must NOT un-approve the run.
- Legacy 4-stage `status.json` files must resume without crashing (backfill missing stages as `skipped`).
- In this repository, `.pipeline/prompts/*.txt`, `.pipeline/config.json`, `.pipeline/orchestrate.sh`, and `.pipeline/skill.json` are git-tracked product source — editing them here is in scope (the CLAUDE.md "read-only .pipeline" rule protects *runtime artifacts* in consumer repos, and there is no active run: `.pipeline/.lock` is absent).
- Run the full suite with `npm test` (runs `node --test pipeline/*.test.mjs`) and `npm run typecheck` (runs `node --check` per file).

### Zero-LLM smoke-test harness (used by several tasks)

Chat-mode + host runner exercises the real state machine without any agent CLI: each stage writes `stage-handoff.json` and exits `awaiting_chat`; you fake the stage artifact by hand and `--continue`. Template:

```bash
REPO=/Users/omotayoishola/dev/orchestrator
TMP=$(mktemp -d) && cd "$TMP" && git init -q && git commit --allow-empty -m init -q
run() { PIPELINE_INVOCATION=chat PIPELINE_UI_PORT=disabled node "$REPO/pipeline/orchestrator.mjs" "$@"; }
overall() { node -e "console.log(JSON.parse(require('fs').readFileSync('.pipeline/status.json','utf8')).overall)"; }
handoff_stage() { node -e "console.log(JSON.parse(require('fs').readFileSync('.pipeline/stage-handoff.json','utf8')).stage)"; }
```

---

### Task 1: Six-stage state schema with `skipped` support (state.mjs)

**Files:**
- Modify: `pipeline/state.mjs`
- Test: `pipeline/state.test.mjs`
- Modify: `pipeline/regression.test.mjs` (shape guards at lines 60–69 and 99–107)

**Interfaces:**
- Produces: `STAGES = ['planner','designer','coder','tester','reviewer','handoff']`, `CORE_STAGES = ['planner','coder','tester','reviewer']`, `OPTIONAL_STAGES = ['designer','handoff']`, `newStatus(task, { design = false, handoff = false } = {})`, `ensureStageEntries(status)`, `pipelinePaths(...).design` (→ `.pipeline/design.md`), `pipelinePaths(...).handoffDoc` (→ `.pipeline/handoff.md`), `STAGE_ARTIFACT_FILES.designer === 'design.md'`, `STAGE_ARTIFACT_FILES.handoff === 'handoff.md'`, `loadConfig` defaults `approvePlan: false, designStage: false, handoffStage: false`.
- Consumes: nothing new.

- [ ] **Step 1: Write the failing tests**

Append to `pipeline/state.test.mjs` (extend the existing import line to also import `newStatus`, `ensureStageEntries`, `STAGES`, `pipelinePaths`, `STAGE_ARTIFACT_FILES`):

```js
test('newStatus builds six stages and marks optional ones skipped by default', () => {
  const s = newStatus('t');
  assert.deepEqual(s.stages.map((x) => x.name), ['planner', 'designer', 'coder', 'tester', 'reviewer', 'handoff']);
  assert.equal(s.stages.find((x) => x.name === 'designer').status, 'skipped');
  assert.equal(s.stages.find((x) => x.name === 'handoff').status, 'skipped');
  assert.equal(s.stages.find((x) => x.name === 'planner').status, 'pending');
});

test('newStatus enables optional stages via flags', () => {
  const s = newStatus('t', { design: true, handoff: true });
  assert.equal(s.stages.find((x) => x.name === 'designer').status, 'pending');
  assert.equal(s.stages.find((x) => x.name === 'handoff').status, 'pending');
});

test('ensureStageEntries backfills a legacy 4-stage status as skipped, in canonical order', () => {
  const legacy = {
    stages: ['planner', 'coder', 'tester', 'reviewer'].map((name) => ({ name, status: 'passed' })),
  };
  ensureStageEntries(legacy);
  assert.deepEqual(legacy.stages.map((x) => x.name), STAGES);
  assert.equal(legacy.stages.find((x) => x.name === 'designer').status, 'skipped');
  assert.equal(legacy.stages.find((x) => x.name === 'handoff').status, 'skipped');
  assert.equal(legacy.stages.find((x) => x.name === 'planner').status, 'passed');
});

test('ensureStageEntries is a no-op on a current six-stage status', () => {
  const s = newStatus('t');
  const before = JSON.stringify(s.stages);
  ensureStageEntries(s);
  assert.equal(JSON.stringify(s.stages), before);
});

test('pipelinePaths exposes design and handoffDoc artifacts', () => {
  const p = pipelinePaths('/repo');
  assert.equal(p.design, '/repo/.pipeline/design.md');
  assert.equal(p.handoffDoc, '/repo/.pipeline/handoff.md');
  assert.equal(STAGE_ARTIFACT_FILES.designer, 'design.md');
  assert.equal(STAGE_ARTIFACT_FILES.handoff, 'handoff.md');
});

test('loadConfig defaults new stage toggles to false', () => {
  const cfg = loadConfig({ config: '/nonexistent/path/config.json' });
  assert.equal(cfg.approvePlan, false);
  assert.equal(cfg.designStage, false);
  assert.equal(cfg.handoffStage, false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test pipeline/state.test.mjs`
Expected: FAIL — `ensureStageEntries` is not exported; six-stage assertions fail against the 4-stage list.

- [ ] **Step 3: Implement in `pipeline/state.mjs`**

Replace line 6:

```js
export const STAGES = ['planner', 'designer', 'coder', 'tester', 'reviewer', 'handoff'];
// The four always-on stages; designer/handoff are opt-in and default to 'skipped'.
export const CORE_STAGES = ['planner', 'coder', 'tester', 'reviewer'];
export const OPTIONAL_STAGES = ['designer', 'handoff'];
```

In `pipelinePaths`, after the `reviewReport` entry add:

```js
    design: path.join(dir, 'design.md'),
    handoffDoc: path.join(dir, 'handoff.md'),
```

Extend `STAGE_ARTIFACT_FILES`:

```js
export const STAGE_ARTIFACT_FILES = {
  planner: 'specs.md',
  designer: 'design.md',
  coder: 'changes.md',
  tester: 'test_suite.md',
  reviewer: 'review_report.md',
  handoff: 'handoff.md',
};
```

In `loadConfig` defaults (after `agentTimeoutMs: 1800000,`):

```js
    approvePlan: false,
    designStage: false,
    handoffStage: false,
```

Replace `newStatus` (keep every existing field; only the signature, `overall` comment, and `stages` mapper change):

```js
export function newStatus(task, { design = false, handoff = false } = {}) {
  return {
    task,
    startedAt: new Date().toISOString(),
    endedAt: null,
    overall: 'running', // running | awaiting_chat | awaiting_plan_approval | done | halted
    invocationMode: 'cli', // chat | cli — how agent stages are executed
    runner: 'auto',
    models: null,
    baseRef: null,      // commit SHA the run started from; diff is scoped against it
    awaitingStage: null,
    chatResume: null,   // { step, context } — set when handing off to IDE chat
    resumePoint: null,  // { step, context } — tracks last saved checkpoint for resuming
    verdict: null,      // APPROVED | REQUEST_CHANGES | BLOCK
    reviewPass: 0,      // auto review-fix passes completed after a non-APPROVED verdict
    haltReason: null,   // REGRESSION_BLOCKED | MAX_CYCLES | MISSING_ARTIFACT | AGENT_ERROR
    stages: STAGES.map((name) => ({
      name,
      // pending | running | passed | failed | blocked | skipped
      status: (name === 'designer' && !design) || (name === 'handoff' && !handoff) ? 'skipped' : 'pending',
      cycle: 0,
      maxCycles: name === 'coder' ? 5 : 1,
      startedAt: null,
      endedAt: null,
      artifact: null,
      detail: null,
      model: null,
      checks: null, // { passedCount, failedCount } from last checker run
    })),
  };
}

// Backfill stage entries missing from a legacy (4-stage) status.json so stage
// lookups and the dashboard keep working when resuming an old run. A missing
// optional stage was never enabled, so it resumes as 'skipped'.
export function ensureStageEntries(status) {
  if (!status?.stages) return status;
  const have = new Set(status.stages.map((s) => s.name));
  STAGES.forEach((name, i) => {
    if (have.has(name)) return;
    status.stages.splice(i, 0, {
      name, status: 'skipped', cycle: 0, maxCycles: 1,
      startedAt: null, endedAt: null, artifact: null, detail: null, model: null, checks: null,
    });
  });
  return status;
}
```

- [ ] **Step 4: Update the two stale shape guards in `pipeline/regression.test.mjs`**

Line 67: change `assert.equal(readBack.stages.length, 4);` → `assert.equal(readBack.stages.length, 6);`

Replace the final test (lines 101–107):

```js
test('newStatus initializes a 6-stage running pipeline with coder budget and skipped optionals', () => {
  const s = newStatus('do a thing');
  assert.equal(s.task, 'do a thing');
  assert.equal(s.overall, 'running');
  assert.deepEqual(s.stages.map((x) => x.name), ['planner', 'designer', 'coder', 'tester', 'reviewer', 'handoff']);
  assert.equal(s.stages.find((x) => x.name === 'coder').maxCycles, 5);
  assert.equal(s.stages.find((x) => x.name === 'designer').status, 'skipped');
});
```

- [ ] **Step 5: Run the full suite; verify pass**

Run: `npm test`
Expected: PASS (note: `models.mjs` imports `STAGES` but its `validateStageMap` loop over six stages would now demand designer/handoff in manual maps — if `models.test.mjs` fails here, that is expected and fixed in Task 2; in that case run only `node --test pipeline/state.test.mjs pipeline/regression.test.mjs` for this task's gate and note it).

- [ ] **Step 6: Commit**

```bash
git add pipeline/state.mjs pipeline/state.test.mjs pipeline/regression.test.mjs
git commit -m "feat(state): six-stage schema with skipped optional stages, legacy backfill, new artifact paths"
```

---

### Task 2: Designer/handoff model profiles + core-only manual validation (models.mjs)

**Files:**
- Modify: `pipeline/models.mjs`
- Test: `pipeline/models.test.mjs`

**Interfaces:**
- Consumes: `CORE_STAGES`, `OPTIONAL_STAGES` from Task 1.
- Produces: every auto profile includes `designer` and `handoff` models; `resolveModelProfile(...).stages` always contains all six keys; manual `--models` JSON requires only the four core stages (designer defaults to the planner model, handoff to the reviewer model).

- [ ] **Step 1: Write the failing tests**

Append to `pipeline/models.test.mjs` (reuse its existing imports of `resolveModelProfile`; add any missing):

```js
test('auto profiles include designer and handoff for every runner', () => {
  for (const runner of ['host', 'claude', 'cursor', 'codex', 'gemini']) {
    const m = resolveModelProfile({ config: {}, runner, profile: 'auto' });
    assert.ok(m.stages.designer, `${runner} missing designer`);
    assert.ok(m.stages.handoff, `${runner} missing handoff`);
  }
});

test('manual models accepts the 4 core stages and derives optional ones', () => {
  const m = resolveModelProfile({
    config: {}, runner: 'claude', profile: 'manual',
    manualStages: { planner: 'p-model', coder: 'c-model', tester: 't-model', reviewer: 'r-model' },
  });
  assert.equal(m.stages.designer, 'p-model'); // planner tier: architecture work
  assert.equal(m.stages.handoff, 'r-model');  // reviewer tier: summarisation
});

test('manual models honors explicit designer/handoff entries', () => {
  const m = resolveModelProfile({
    config: {}, runner: 'claude', profile: 'manual',
    manualStages: { planner: 'p', coder: 'c', tester: 't', reviewer: 'r', designer: 'd', handoff: 'h' },
  });
  assert.equal(m.stages.designer, 'd');
  assert.equal(m.stages.handoff, 'h');
});

test('manual models still rejects a missing core stage', () => {
  assert.throws(() => resolveModelProfile({
    config: {}, runner: 'claude', profile: 'manual',
    manualStages: { planner: 'p', coder: 'c', tester: 't' },
  }), /reviewer/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test pipeline/models.test.mjs`
Expected: FAIL — auto profiles lack designer/handoff; 4-key manual map now throws (since `STAGES` is six).

- [ ] **Step 3: Implement in `pipeline/models.mjs`**

Change the import (line 2):

```js
import { CORE_STAGES, OPTIONAL_STAGES } from './state.mjs';
```

Extend `DEFAULT_MODEL_PROFILES.auto` — each runner map gains two keys:

```js
    host:   { planner: 'opus-4.8', designer: 'opus-4.8', coder: 'sonnet-5', tester: 'sonnet-5', reviewer: 'sonnet-5', handoff: 'sonnet-5' },
    claude: { planner: 'opus-4.8', designer: 'opus-4.8', coder: 'sonnet-5', tester: 'sonnet-5', reviewer: 'sonnet-5', handoff: 'sonnet-5' },
    cursor: { planner: 'opus-4.8', designer: 'opus-4.8', coder: 'sonnet-5', tester: 'sonnet-5', reviewer: 'sonnet-5', handoff: 'sonnet-5' },
    codex:  { planner: 'gpt-5.5', designer: 'gpt-5.5', coder: 'gpt-5.5', tester: 'gpt-5.5', reviewer: 'gpt-5.5', handoff: 'gpt-5.5' },
    gemini: { planner: 'gemini-3.1-pro', designer: 'gemini-3.1-pro', coder: 'gemini-3.5-flash', tester: 'gemini-3.5-flash', reviewer: 'gemini-3.5-flash', handoff: 'gemini-3.1-flash-lite' },
```

Replace `validateStageMap`:

```js
function validateStageMap(stages, label = 'models') {
  if (!stages || typeof stages !== 'object') {
    throw new Error(`Invalid ${label}: expected an object with keys ${CORE_STAGES.join(', ')} (optional: ${OPTIONAL_STAGES.join(', ')}).`);
  }
  const out = {};
  for (const name of CORE_STAGES) {
    const val = stages[name];
    if (typeof val !== 'string' || !val.trim()) {
      throw new Error(`Invalid ${label}: missing or empty model for stage "${name}".`);
    }
    out[name] = val.trim();
  }
  // Optional stages default to a sensible sibling when omitted: the designer is
  // architecture work (planner tier); the handoff doc is summarisation (reviewer tier).
  out.designer = typeof stages.designer === 'string' && stages.designer.trim() ? stages.designer.trim() : out.planner;
  out.handoff = typeof stages.handoff === 'string' && stages.handoff.trim() ? stages.handoff.trim() : out.reviewer;
  return out;
}
```

The `STAGES.join` inside the old error message is the only other `STAGES` use in this file — after this change nothing imports `STAGES` here; remove it from the import.

- [ ] **Step 4: Run tests to verify pass**

Run: `node --test pipeline/models.test.mjs pipeline/state.test.mjs pipeline/regression.test.mjs`
Expected: PASS (including the Task-1 deferred failures, if any).

- [ ] **Step 5: Commit**

```bash
git add pipeline/models.mjs pipeline/models.test.mjs
git commit -m "feat(models): designer/handoff stage models in profiles; manual --models requires core stages only"
```

---

### Task 3: Stage-aware read-only write allowlist (adapters.mjs)

**Files:**
- Modify: `pipeline/adapters.mjs:53-72` (`buildInvocation`) and `pipeline/adapters.mjs:196` (`runAgent` call site)
- Test: `pipeline/regression.test.mjs`

**Interfaces:**
- Consumes: `STAGE_ARTIFACT_FILES` (already imported in adapters.mjs).
- Produces: `buildInvocation({ runner, stage, systemPrompt, task, readOnly, config, model })` — `stage` optional; claude read-only allowlist writes only `.pipeline/<stage artifact>` (fallback `review_report.md` when stage omitted, preserving old call sites).

- [ ] **Step 1: Write the failing test**

Append to the P0-2 block in `pipeline/regression.test.mjs`:

```js
test('[P0-2] read-only write allowlist targets the invoking stage artifact', () => {
  const designer = buildInvocation({ ...base, runner: 'claude', stage: 'designer', readOnly: true });
  assert.ok(designer.args.join(' ').includes('Write(.pipeline/design.md)'));
  const handoff = buildInvocation({ ...base, runner: 'claude', stage: 'handoff', readOnly: true });
  assert.ok(handoff.args.join(' ').includes('Write(.pipeline/handoff.md)'));
  const legacy = buildInvocation({ ...base, runner: 'claude', readOnly: true }); // no stage → reviewer fallback
  assert.ok(legacy.args.join(' ').includes('Write(.pipeline/review_report.md)'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test pipeline/regression.test.mjs`
Expected: FAIL — allowlist is hard-coded to `review_report.md`.

- [ ] **Step 3: Implement**

In `buildInvocation` change the signature and the claude read-only branch:

```js
export function buildInvocation({ runner, stage, systemPrompt, task, readOnly, config, model }) {
```

```js
      if (readOnly) {
        // Headless mode denies anything not allowlisted: a read-only stage may
        // read, run git diff/log, and write ONLY its own artifact file.
        const artifact = `.pipeline/${STAGE_ARTIFACT_FILES[stage] || 'review_report.md'}`;
        args.push('--allowedTools', `Read,Glob,Grep,Bash(git diff:*),Bash(git log:*),Bash(git status:*),Write(${artifact})`);
        return { bin: 'claude', args, parse: 'claude-stream-json', readOnlyEnforced: true };
      }
```

In `runAgent` (line ~196) pass the stage through:

```js
  const { bin, args, parse, readOnlyEnforced } = buildInvocation({ runner, stage, systemPrompt, task, readOnly, config, model });
```

- [ ] **Step 4: Run tests to verify pass**

Run: `node --test pipeline/regression.test.mjs pipeline/adapters.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pipeline/adapters.mjs pipeline/regression.test.mjs
git commit -m "feat(adapters): read-only allowlist writes the invoking stage's own artifact"
```

---

### Task 4: Deterministic halt-handoff compiler (new pipeline/handoff.mjs)

**Files:**
- Create: `pipeline/handoff.mjs`
- Test: `pipeline/handoff.test.mjs`

**Interfaces:**
- Produces: `compileHaltHandoff({ status, history = null, git = null })` → markdown string (pure); `collectGitInfo(cwd)` → `{ branch, dirty } | null`; `writeHaltHandoff({ paths, status, history = null, cwd = paths.root })` → boolean (best-effort, never throws).
- Consumes: `status` shape from Task 1 (`newStatus`), `paths.handoffDoc` from Task 1, `history` shape `{ coder: [{passedCount,failedCount,isPassed,at}], postTester: [...] }`.

- [ ] **Step 1: Write the failing tests** — create `pipeline/handoff.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compileHaltHandoff, collectGitInfo, writeHaltHandoff } from './handoff.mjs';
import { newStatus } from './state.mjs';

function haltedStatus(reason, patch = {}) {
  const s = newStatus('add rate limiting');
  s.overall = 'halted';
  s.haltReason = reason;
  Object.assign(s, patch);
  return s;
}

test('compileHaltHandoff renders MAX_CYCLES with extend resume hint', () => {
  const s = haltedStatus('MAX_CYCLES', { haltedPhase: 'coder' });
  s.stages.find((x) => x.name === 'coder').status = 'failed';
  const doc = compileHaltHandoff({ status: s, history: { coder: [{ passedCount: 3, failedCount: 2, isPassed: false, at: 't' }], postTester: [] } });
  assert.match(doc, /# Pipeline Handoff/);
  assert.match(doc, /halted — MAX_CYCLES/);
  assert.match(doc, /Phase at freeze:\*\* coder/);
  assert.match(doc, /--resume --extend/);
  assert.match(doc, /3 passed \/ 2 failed/);
});

test('compileHaltHandoff renders REGRESSION_BLOCKED as not extendable', () => {
  const doc = compileHaltHandoff({ status: haltedStatus('REGRESSION_BLOCKED') });
  assert.match(doc, /not extendable/i);
});

test('compileHaltHandoff tolerates missing history and git info', () => {
  const doc = compileHaltHandoff({ status: haltedStatus('AGENT_ERROR') });
  assert.match(doc, /No checker runs recorded/);
  assert.match(doc, /Not a git repository/);
});

test('compileHaltHandoff includes the stage table and git state', () => {
  const s = haltedStatus('INTERRUPTED', { baseRef: 'abc123' });
  const doc = compileHaltHandoff({ status: s, git: { branch: 'feat/x', dirty: true } });
  assert.match(doc, /\| planner \| pending \|/);
  assert.match(doc, /Branch: feat\/x/);
  assert.match(doc, /DIRTY/);
  assert.match(doc, /abc123/);
});

test('collectGitInfo returns branch/dirty inside a repo and null outside', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ho-git-'));
  assert.equal(collectGitInfo(dir), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeHaltHandoff writes the doc and never throws', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ho-write-'));
  const paths = { root: dir, handoffDoc: path.join(dir, 'handoff.md') };
  const ok = writeHaltHandoff({ paths, status: haltedStatus('MISSING_ARTIFACT') });
  assert.equal(ok, true);
  assert.match(fs.readFileSync(paths.handoffDoc, 'utf8'), /MISSING_ARTIFACT/);
  // Unwritable target: returns false instead of throwing (never mask the original halt).
  assert.equal(writeHaltHandoff({ paths: { root: dir, handoffDoc: path.join(dir, 'nope', 'x.md') }, status: haltedStatus('AGENT_ERROR') }), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test pipeline/handoff.test.mjs`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Create `pipeline/handoff.mjs`**

```js
// Deterministic handoff-document compiler. On any halt the orchestrator writes
// .pipeline/handoff.md from run state alone — no LLM call — so the next session
// (human or agent) can resume without archaeology, even when the halt cause is
// the agent CLI itself. compileHaltHandoff is pure so it can be unit-tested
// without running a pipeline.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const RESUME_HINTS = {
  MAX_CYCLES: 'Extend the same fix loop: `node pipeline/orchestrator.mjs --resume --extend <n>` (or the dashboard "Extend" button).',
  REGRESSION_BLOCKED: 'A change broke previously passing tests. Inspect the diff and `.pipeline/checker_report.md` BEFORE any resume — regression halts are intentionally not extendable.',
  MISSING_ARTIFACT: 'A stage exited without producing its artifact. Inspect that stage\'s log under `.pipeline/logs/`, then start a fresh run (or `node pipeline/orchestrator.mjs --resume` if the run is stale/interrupted).',
  AGENT_ERROR: 'The agent CLI failed. Check authentication and the stage log under `.pipeline/logs/`, then `node pipeline/orchestrator.mjs --resume`.',
  INTERRUPTED: 'The run was interrupted. Resume it: `node pipeline/orchestrator.mjs --resume`.',
};

export function collectGitInfo(cwd) {
  const git = (args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (git(['rev-parse', '--is-inside-work-tree']).status !== 0) return null;
  const branch = (git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout || '').trim() || null;
  const dirty = (git(['status', '--porcelain']).stdout || '').trim().length > 0;
  return { branch, dirty };
}

export function compileHaltHandoff({ status, history = null, git = null }) {
  const reason = status.haltReason || 'UNKNOWN';
  const phase = status.haltedPhase || status.resumePoint?.step || '(unknown)';
  const failing = (status.stages || []).find((s) => s.status === 'failed' || s.status === 'blocked' || s.status === 'interrupted');
  const lines = [
    '# Pipeline Handoff (auto-generated on halt)',
    '',
    '> **CRITICAL RESUME DIRECTION:** Do not start planning from scratch. Read `.pipeline/status.json` for the machine state, skim the artifacts below, then follow the resume command at the end.',
    '',
    '## 1. Summary of Blocked State',
    `- **Goal:** ${status.task || '(unknown)'}`,
    `- **Outcome:** halted — ${reason}`,
    `- **Phase at freeze:** ${phase}`,
  ];
  if (failing?.detail) lines.push(`- **Detail:** ${failing.detail}`);
  lines.push('', '## 2. Stage Status', '| Stage | Status | Cycle | Artifact |', '|---|---|---|---|');
  for (const s of status.stages || []) {
    lines.push(`| ${s.name} | ${s.status} | ${s.cycle || 0}${s.maxCycles > 1 ? `/${s.maxCycles}` : ''} | ${s.artifact || '—'} |`);
  }
  lines.push('', '## 3. Verification Trend');
  const runs = [...(history?.coder || []), ...(history?.postTester || [])];
  if (runs.length) {
    const last = runs[runs.length - 1];
    lines.push(`- Last checker run: ${last.passedCount} passed / ${last.failedCount} failed (${last.isPassed ? 'GREEN' : 'RED'})`);
    lines.push(`- Trend (passed counts): ${runs.map((r) => r.passedCount).join(' → ')}`);
  } else {
    lines.push('- No checker runs recorded for this run.');
  }
  lines.push('', '## 4. Artifacts to Read (in order)');
  for (const [p, why] of [
    ['`.pipeline/checker_report.md`', 'latest verification failures'],
    ['`.pipeline/changes.md`', 'what the Coder implemented, fix cycle by fix cycle'],
    ['`.pipeline/specs.md`', 'the specification being implemented'],
    ['`.pipeline/design.md`', 'finalized design contracts (if the design stage ran)'],
    ['`.pipeline/review_report.md`', 'last review verdict (if the reviewer ran)'],
    ['`.pipeline/logs/`', 'raw per-stage agent logs'],
  ]) lines.push(`- ${p} — ${why}`);
  lines.push('', '## 5. Git State');
  if (git) {
    lines.push(`- Branch: ${git.branch || '(detached)'}`);
    lines.push(`- Base commit for this run: ${status.baseRef || '(none captured)'}`);
    lines.push(`- Working tree: ${git.dirty ? 'DIRTY (uncommitted changes present)' : 'clean'}`);
  } else {
    lines.push('- Not a git repository (or git unavailable).');
  }
  lines.push('', '## 6. How to Resume');
  lines.push(`- ${RESUME_HINTS[reason] || 'Inspect `.pipeline/status.json` and the stage logs, then `node pipeline/orchestrator.mjs --resume`.'}`);
  lines.push('- Chat mode: `bash .pipeline/orchestrate.sh --continue` when a stage handoff is pending.', '');
  return lines.join('\n');
}

export function writeHaltHandoff({ paths, status, history = null, cwd = paths.root }) {
  try {
    fs.writeFileSync(paths.handoffDoc, compileHaltHandoff({ status, history, git: collectGitInfo(cwd) }));
    return true;
  } catch {
    return false; // best-effort; never mask the original halt
  }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `node --test pipeline/handoff.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pipeline/handoff.mjs pipeline/handoff.test.mjs
git commit -m "feat(handoff): deterministic zero-token halt handoff compiler"
```

---

### Task 5: New flags, status.flags, archival, legacy backfill (orchestrator.mjs wiring)

**Files:**
- Modify: `pipeline/orchestrator.mjs` (parseArgs ~20-43, USAGE ~45, imports ~14, continue/resume/fresh setup ~154-285)

**Interfaces:**
- Consumes: `newStatus(task, {design, handoff})`, `ensureStageEntries` (Task 1).
- Produces: `args.approvePlan|design|handoff` booleans; `status.flags = { design, handoff, approvePlan }` and `status.planApproved` persisted; `design.md`/`handoff.md` archived per run; every continue/resume load path backfills legacy statuses.

- [ ] **Step 1: parseArgs + USAGE**

In `parseArgs` defaults add `approvePlan: false, design: false, handoff: false,` and in the loop add:

```js
    else if (a === '--approve-plan') args.approvePlan = true;
    else if (a === '--design') args.design = true;
    else if (a === '--handoff') args.handoff = true;
```

Replace USAGE:

```js
const USAGE = 'Usage: node pipeline/orchestrator.mjs --task "description" [--runner claude|cursor|codex|gemini|host] [--mode chat|cli] [--model-profile auto|manual] [--models \'{"planner":"...","coder":"..."}\'] [--approve-plan] [--design] [--handoff] [--sandbox] [--max-cycles n] [--max-post-tester-cycles n] [--max-review-cycles n]\n   or: node pipeline/orchestrator.mjs --continue\n   or: node pipeline/orchestrator.mjs --resume [--extend <n>] [--runner ...]';
```

- [ ] **Step 2: Import + fresh-run wiring**

Extend the state.mjs import (line 14) with `ensureStageEntries`.

In the fresh-run branch, replace `status = newStatus(args.task);` with:

```js
  const runFlags = {
    design: args.design || config.designStage === true,
    handoff: args.handoff || config.handoffStage === true,
    approvePlan: args.approvePlan || config.approvePlan === true,
  };
  status = newStatus(args.task, { design: runFlags.design, handoff: runFlags.handoff });
  status.flags = runFlags;
  status.planApproved = false;
```

Add both new artifacts to RUN_FILES (line ~239):

```js
  const RUN_FILES = [paths.status, paths.events, paths.vagueRequest, paths.specs, paths.design, paths.changes, paths.checkerReport, paths.testSuite, paths.reviewReport, paths.handoffDoc, paths.testHistory, paths.diff, paths.stageHandoff];
```

In the `pipeline_start` appendEvent add `flags: runFlags`, and extend the startup console.log with `, design=${runFlags.design}, approvePlan=${runFlags.approvePlan}, handoff=${runFlags.handoff}`.

- [ ] **Step 3: Backfill on every load of an on-disk status**

In all three `status = onDisk;` assignments (the `--continue` branch, the `--resume --extend` branch, and the plain `--resume` branch), immediately after the assignment add:

```js
  ensureStageEntries(status);
  status.flags = status.flags || { design: false, handoff: false, approvePlan: false };
  if (status.planApproved == null) status.planApproved = true; // legacy runs never gated
```

- [ ] **Step 4: Verify**

```bash
npm run typecheck && npm test
node pipeline/orchestrator.mjs 2>&1 | grep -- --approve-plan   # USAGE mentions new flags
```

Zero-LLM smoke (template from Global Constraints): `run --task "demo" --runner host` → planner chat handoff; then check `node -e "const s=require('./.pipeline/status.json'); console.log(s.stages.length, s.flags.design)"` prints `6 false`.

- [ ] **Step 5: Commit**

```bash
git add pipeline/orchestrator.mjs
git commit -m "feat(orchestrator): --approve-plan/--design/--handoff flags, status.flags, six-stage wiring, legacy backfill"
```

---

### Task 6: Plan approval gate (orchestrator.mjs)

**Files:**
- Modify: `pipeline/orchestrator.mjs` (continue entry ~155-176, freshRun ~798-803, chatContinueRun after_planner ~721-728, resumeInterruptedRun planner branches ~848-863, dispatch line ~1024)

**Interfaces:**
- Consumes: `status.flags.approvePlan`, `status.planApproved` (Task 5).
- Produces: `requestPlanApproval()` (sets `overall='awaiting_plan_approval'`, `resumePoint={step:'plan_approval'}`, exits 0); `continueAfterPlanner()` — the single post-planner funnel (gate → Coder → Tester → Reviewer; Task 7 inserts Designer); `runCoderOnward()`; `planApprovalContinueRun()` — `--continue` route for the approval state with a planner-followup revision loop.

- [ ] **Step 1: Add the gate + funnel functions** (place after `requestChatHandoff`):

```js
// Optional human gate: pause after the Planner so the developer can read
// specs.md before any code is written. Approval = `orchestrate.sh --continue`;
// queueing a planner follow-up note first triggers one re-plan instead.
function requestPlanApproval() {
  status.overall = 'awaiting_plan_approval';
  status.awaitingStage = 'planner';
  status.resumePoint = { step: 'plan_approval', context: {} };
  setStage('planner', { detail: 'Awaiting human plan approval' });
  finalize();
  console.log('\n[Orchestrator] Plan approval gate — review .pipeline/specs.md.');
  console.log('  Approve & continue:  bash .pipeline/orchestrate.sh --continue');
  console.log('  Request changes:     queue a note in .pipeline/followups/planner.txt (or the dashboard follow-up box), then run --continue to re-plan.');
  if (dashboardUrl) console.log(`  Dashboard: ${dashboardUrl}`);
  haltAndExit(0);
}

async function runCoderOnward() {
  if (!(await runCoderStage())) return;
  if (!(await runTesterStage())) return;
  await runReviewerStage();
}

// Everything after the Planner. Single funnel shared by fresh runs, chat
// continues, and interrupted resumes so the approval gate cannot be bypassed
// by any one path. (Task 7 inserts the Designer stage here.)
async function continueAfterPlanner() {
  if (status.flags?.approvePlan && !status.planApproved) requestPlanApproval(); // exits the process
  await runCoderOnward();
}
```

- [ ] **Step 2: Route every post-planner site through the funnel**

`freshRun` becomes:

```js
async function freshRun() {
  await runPlannerStage();
  await continueAfterPlanner();
}
```

`chatContinueRun` `after_planner` branch becomes:

```js
  if (step === 'after_planner') {
    requireArtifact('planner', paths.specs);
    setStage('planner', { status: 'passed', endedAt: new Date().toISOString(), artifact: 'specs.md' });
    await continueAfterPlanner();
    return;
  }
```

`resumeInterruptedRun` `planner` branch becomes `await runPlannerStage(); await continueAfterPlanner(); return;`, its `after_planner` branch becomes `requireArtifact(...); setStage('planner', {...passed...}); await continueAfterPlanner(); return;`, and add a new branch:

```js
  if (step === 'plan_approval') { requestPlanApproval(); return; }
```

- [ ] **Step 3: Accept the approval state at the `--continue` entry**

At the top of the module add `let planApprovalPending = false;`. In the `args.continue` setup branch, replace the state check with:

```js
  if (onDisk.overall === 'awaiting_plan_approval' && onDisk.resumePoint?.step === 'plan_approval') {
    planApprovalPending = true;
  } else if (onDisk.overall !== 'awaiting_chat' || !onDisk.chatResume?.step) {
    console.error('[Orchestrator] Nothing to continue: pipeline is not awaiting an IDE chat handoff or plan approval.');
    haltAndExit(1);
  }
```

(The rest of that branch — `status = onDisk; status.overall = 'running'; ...` — runs unchanged for both cases; the `pipeline_continue_chat` appendEvent and log line should guard on `!planApprovalPending`.)

Add the route function:

```js
async function planApprovalContinueRun() {
  requireArtifact('planner', paths.specs); // spec deleted/emptied while gated → MISSING_ARTIFACT
  const followupFile = path.join(paths.dir, 'followups', 'planner.txt');
  let hasFollowup = false;
  try { hasFollowup = fs.readFileSync(followupFile, 'utf8').trim().length > 0; } catch {}
  appendEvent(paths, { stage: 'orchestrator', type: hasFollowup ? 'plan_revision_start' : 'plan_approved' });
  if (hasFollowup) {
    console.log('[Orchestrator] Plan revision requested — re-running Planner with the queued follow-up note.');
    status.planApproved = false;
    await runPlannerStage(); // consumeFollowups injects & clears the note; hands off in chat mode
    await continueAfterPlanner(); // CLI mode: gate re-arms here
    return;
  }
  console.log('[Orchestrator] Plan approved — continuing pipeline.');
  status.planApproved = true;
  writeStatus(paths, status);
  await continueAfterPlanner();
}
```

Change the dispatch (last line):

```js
(args.continue ? (planApprovalPending ? planApprovalContinueRun() : chatContinueRun()) : args.resume ? (args.extend !== null ? resumeRun() : resumeInterruptedRun()) : freshRun()).catch((err) => {
```

- [ ] **Step 4: Smoke-test the gate end-to-end (zero-LLM harness)**

```bash
REPO=/Users/omotayoishola/dev/orchestrator
TMP=$(mktemp -d) && cd "$TMP" && git init -q && git commit --allow-empty -m init -q
run() { PIPELINE_INVOCATION=chat PIPELINE_UI_PORT=disabled node "$REPO/pipeline/orchestrator.mjs" "$@"; }
overall() { node -e "console.log(JSON.parse(require('fs').readFileSync('.pipeline/status.json','utf8')).overall)"; }
run --task "demo" --runner host --approve-plan     # → planner chat handoff, exit 0
echo "# spec" > .pipeline/specs.md
run --continue                                     # → gate fires
[ "$(overall)" = awaiting_plan_approval ] && echo GATE-OK
run --continue                                     # → approved; coder handoff
node -e "const h=require('./.pipeline/stage-handoff.json'); if(h.stage!=='coder')process.exit(1)" && echo APPROVE-OK
# Revision loop:
mkdir -p .pipeline/followups && rm -f .pipeline/stage-handoff.json
run --task "demo2" --runner host --approve-plan && echo "# spec" > .pipeline/specs.md && run --continue
echo "tighten the scope" > .pipeline/followups/planner.txt
run --continue                                     # → re-plans (planner handoff again)
node -e "const h=require('./.pipeline/stage-handoff.json'); if(h.stage!=='planner')process.exit(1)" && echo REVISION-OK
```

Expected: `GATE-OK`, `APPROVE-OK`, `REVISION-OK`. Also run `npm test` in the repo — PASS.

- [ ] **Step 5: Commit**

```bash
git add pipeline/orchestrator.mjs
git commit -m "feat(orchestrator): optional --approve-plan gate with follow-up revision loop"
```

---

### Task 7: Designer stage (orchestrator.mjs)

**Files:**
- Modify: `pipeline/orchestrator.mjs` (`continueAfterPlanner`, `chatContinueRun`, `resumeInterruptedRun`, `getResumePoint` ~805-829)

**Interfaces:**
- Consumes: `paths.design`, `stage('designer')` (Task 1), `runStageAgent(..., { readOnly })` with stage-artifact allowlist (Task 3), `runCoderOnward()` (Task 6).
- Produces: `runDesignerStage()` — no-op when skipped/passed, otherwise a read-only agent run producing `design.md`, with `designer`/`after_designer` resume+chat steps.

- [ ] **Step 1: Add the stage runner** (place next to `runPlannerStage`):

```js
// Design-It-Twice: one read-only Designer invocation explores three design
// postures and locks the public contracts in design.md before any code is
// written. No-op when the stage is skipped (flag off) or already passed.
async function runDesignerStage() {
  const st = stage('designer');
  if (!st || st.status === 'skipped' || st.status === 'passed') return;
  status.resumePoint = { step: 'designer', context: {} };
  setStage('designer', { status: 'running', startedAt: st.startedAt || new Date().toISOString(), cycle: 1 });
  console.log('[Stage] Designer (Design-It-Twice, read-only)...');
  await runStageAgent('designer', `Explore design alternatives and synthesize the final public contracts for this feature:\n\n${status.task}\n\nRead .pipeline/specs.md first. Write your synthesis to .pipeline/design.md.`, {
    readOnly: true,
    chatResume: { step: 'after_designer', context: {} },
  });
  status.resumePoint = { step: 'after_designer', context: {} };
  writeStatus(paths, status);
  requireArtifact('designer', paths.design);
  setStage('designer', { status: 'passed', endedAt: new Date().toISOString(), artifact: 'design.md' });
}
```

- [ ] **Step 2: Insert into the funnel and the resume paths**

`continueAfterPlanner` gains one line between the gate and `runCoderOnward`:

```js
  await runDesignerStage();
```

`chatContinueRun` gains a branch (after `after_planner`):

```js
  if (step === 'after_designer') {
    requireArtifact('designer', paths.design);
    setStage('designer', { status: 'passed', endedAt: new Date().toISOString(), artifact: 'design.md' });
    await runCoderOnward();
    return;
  }
```

`resumeInterruptedRun` gains two branches (after the `after_planner` branch):

```js
  if (step === 'designer') {
    await runDesignerStage();
    await runCoderOnward();
    return;
  }
  if (step === 'after_designer') {
    requireArtifact('designer', paths.design);
    setStage('designer', { status: 'passed', endedAt: new Date().toISOString(), artifact: 'design.md' });
    await runCoderOnward();
    return;
  }
```

`getResumePoint()` fallback: after the planner check insert:

```js
  const designer = stage('designer');
  if (designer && designer.status !== 'passed' && designer.status !== 'skipped') {
    return { step: 'designer', context: {} };
  }
```

- [ ] **Step 3: Smoke-test (zero-LLM harness)**

```bash
# fresh TMP repo as in Task 6
run --task "demo" --runner host --design
echo "# spec" > .pipeline/specs.md
run --continue
node -e "const h=require('./.pipeline/stage-handoff.json'); if(h.stage!=='designer'||h.readOnly!==true)process.exit(1)" && echo DESIGNER-HANDOFF-OK
echo "# design" > .pipeline/design.md
run --continue
node -e "const h=require('./.pipeline/stage-handoff.json'); if(h.stage!=='coder')process.exit(1)" && echo DESIGNER-PASS-OK
# Flag off ⇒ stage skipped straight to coder:
TMP2=$(mktemp -d) && cd "$TMP2" && git init -q && git commit --allow-empty -m init -q
run --task "demo" --runner host && echo "# spec" > .pipeline/specs.md && run --continue
node -e "const h=require('./.pipeline/stage-handoff.json'); if(h.stage!=='coder')process.exit(1)" && echo SKIP-OK
```

Expected: `DESIGNER-HANDOFF-OK`, `DESIGNER-PASS-OK`, `SKIP-OK`. `npm test` stays green.

- [ ] **Step 4: Commit**

```bash
git add pipeline/orchestrator.mjs
git commit -m "feat(orchestrator): flag-gated read-only Designer stage producing design.md"
```

---

### Task 8: Handoff integration — deterministic on halt, agent on flag (orchestrator.mjs)

**Files:**
- Modify: `pipeline/orchestrator.mjs` (imports, `halt()` ~298-305, `interrupted()` ~136-149, `runStageAgent` ~376-400, `afterReviewerAudit` ~636-663, `chatContinueRun`, `resumeInterruptedRun`, `getResumePoint`)

**Interfaces:**
- Consumes: `writeHaltHandoff` (Task 4), `paths.handoffDoc`, `stage('handoff')`, `status.flags.handoff`.
- Produces: `runStageAgent(..., { soft: true })` returns the failed result instead of halting; `runHandoffStage()` / `finishHandoffStage(agentOk)` with deterministic fallback; every `halt()` and SIGINT/SIGTERM interruption writes `handoff.md`.

- [ ] **Step 1: Deterministic handoff on halt**

Add to imports: `import { writeHaltHandoff } from './handoff.mjs';`

In `halt()` insert before `finalize();`:

```js
  if (writeHaltHandoff({ paths, status, history: history || null, cwd: workCwd || repoRoot })) {
    console.error(`[HALT] Handoff document written: ${path.relative(repoRoot, paths.handoffDoc)}`);
  }
```

In `interrupted()` insert the same `writeHaltHandoff(...)` call (without the log) immediately before its `finalize();`.

- [ ] **Step 2: Soft-failure option in `runStageAgent`**

Change the signature to `{ cycle = 1, readOnly = false, chatResume = null, soft = false } = {}` and make the failure block start with:

```js
  if (!res.ok) {
    if (soft) return res; // caller degrades gracefully (handoff stage)
    ...existing halt logic unchanged...
```

- [ ] **Step 3: Handoff stage runner + wiring**

Add next to `runReviewerStage`:

```js
// Optional post-approval handoff: a read-only agent compiles handoff.md. A
// failure here must NOT un-approve the run — fall back to the deterministic
// document, mark the stage failed, and still finish as done.
async function runHandoffStage() {
  const st = stage('handoff');
  if (!st || st.status === 'skipped' || st.status === 'passed') return;
  status.resumePoint = { step: 'handoff', context: {} };
  setStage('handoff', { status: 'running', startedAt: st.startedAt || new Date().toISOString(), cycle: 1 });
  console.log('[Stage] Handoff (continuation document, read-only)...');
  const res = await runStageAgent('handoff', `Compile the continuation handoff document for the completed task: ${status.task}\n\nRead .pipeline/specs.md, .pipeline/design.md (if present), .pipeline/changes.md, .pipeline/test_suite.md and .pipeline/review_report.md. Reference artifacts by path — do not duplicate their content. Write the document to .pipeline/handoff.md.`, {
    readOnly: true,
    soft: true,
    chatResume: { step: 'after_handoff', context: {} },
  });
  status.resumePoint = { step: 'after_handoff', context: {} };
  writeStatus(paths, status);
  finishHandoffStage(res.ok);
}

function finishHandoffStage(agentOk) {
  if (agentOk && artifactOk(paths.handoffDoc)) {
    setStage('handoff', { status: 'passed', endedAt: new Date().toISOString(), artifact: 'handoff.md' });
    return;
  }
  writeHaltHandoff({ paths, status, history: history || null, cwd: workCwd || repoRoot });
  setStage('handoff', { status: 'failed', endedAt: new Date().toISOString(), artifact: 'handoff.md', detail: 'Handoff agent failed — deterministic handoff document written instead' });
}
```

In `afterReviewerAudit`, change `if (approved) return finishApproved();` to:

```js
  if (approved) {
    await runHandoffStage(); // no-op unless --handoff; hands off & exits in chat mode
    return finishApproved();
  }
```

`chatContinueRun` gains:

```js
  if (step === 'after_handoff') {
    finishHandoffStage(true);
    finishApproved();
    return;
  }
```

`resumeInterruptedRun` gains:

```js
  if (step === 'handoff') { await runHandoffStage(); finishApproved(); return; }
  if (step === 'after_handoff') { finishHandoffStage(true); finishApproved(); return; }
```

`getResumePoint()` fallback: before the final `return { step: 'reviewer', context: {} };` add:

```js
  const hoStage = stage('handoff');
  if (status.verdict === 'APPROVED' && hoStage && !['skipped', 'passed', 'failed'].includes(hoStage.status)) {
    return { step: 'handoff', context: {} };
  }
```

- [ ] **Step 4: Smoke-test halt handoff (zero-LLM harness)**

```bash
# fresh TMP repo as in Task 6
run --task "demo" --runner host           # planner handoff
run --continue                            # NO specs.md written → MISSING_ARTIFACT halt
[ -s .pipeline/handoff.md ] && grep -q MISSING_ARTIFACT .pipeline/handoff.md && echo HALT-HANDOFF-OK
```

Expected: `HALT-HANDOFF-OK`, and `npm test` in the repo stays green. The approved-path handoff flow (reviewer APPROVED → handoff stage → done) is exercised end-to-end in Task 12's full walk, where the temp repo's checks are configured to pass — do not attempt it here in a bare repo whose checker fails.

- [ ] **Step 5: Commit**

```bash
git add pipeline/orchestrator.mjs
git commit -m "feat(orchestrator): handoff.md on every halt; soft-failing agent handoff stage on --handoff"
```

---

### Task 9: Dashboard + ui-server six-stage support

**Files:**
- Modify: `pipeline/ui-server.mjs:25` (`AGENT_STAGES`) and the followup error message (~line 338)
- Modify: `pipeline/dashboard.html` (CSS vars ~28/55, `.agent-ico` ~323, model-select rows ~814-817, ICONS ~852, AGENTS ~875, `STEP_LABELS`/`ORDER` ~880-881, `MODEL_STAGES` (grep for it), status pill ~1155, `getNextAgent` step map ~1170, awaiting banner ~1254-1263, stepper/`renderSidebar` skipped styling)

**Interfaces:**
- Consumes: six-stage `status.stages` with `skipped`, `overall === 'awaiting_plan_approval'`.
- Produces: Designer/Handoff cards, labels, icons, model selects; greyed skipped stages; plan-approval banner and pill.

- [ ] **Step 1: ui-server.mjs**

```js
const AGENT_STAGES = ['planner', 'designer', 'coder', 'tester', 'reviewer', 'handoff'];
```

and update the followup 400 message to `'expected { stage: planner|designer|coder|tester|reviewer|handoff, text }'`.

- [ ] **Step 2: dashboard.html — stage registry**

`ORDER`/`STEP_LABELS`/`MODEL_STAGES`:

```js
const STEP_LABELS = { planner: 'Plan', designer: 'Design', coder: 'Code', tester: 'Test', reviewer: 'Review', handoff: 'Handoff' };
const ORDER = ['planner', 'designer', 'coder', 'tester', 'reviewer', 'handoff'];
```

(set `MODEL_STAGES` to the same six-name list wherever it is defined).

`AGENTS` map — add:

```js
  designer: { icon: 'designer', sub: 'Architecture',     desc: 'Design-It-Twice: explores alternatives, locks contracts', artifacts: ['design.md'] },
  handoff:  { icon: 'handoff',  sub: 'Continuation doc', desc: 'Compiles the handoff document for the next session',      artifacts: ['handoff.md'] },
```

`ICONS` — add:

```js
  designer: I('<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="12" y1="3" x2="12" y2="12"/>'),
  handoff:  I('<path d="M4 12h11"/><polyline points="11,6 17,12 11,18"/><line x1="20" y1="5" x2="20" y2="19"/>'),
```

CSS variables — light block (near line 28): `--agent-designer-bg: #dbeafe; --agent-designer-fg: #1d4ed8; --agent-handoff-bg: #d1fae5; --agent-handoff-fg: #047857;`; dark block (near line 55): `--agent-designer-bg: #172554; --agent-designer-fg: #93c5fd; --agent-handoff-bg: #064e3b; --agent-handoff-fg: #6ee7b7;`. Next to line 323 add:

```css
  .agent-ico.designer { background: var(--agent-designer-bg); color: var(--agent-designer-fg); }
  .agent-ico.handoff  { background: var(--agent-handoff-bg); color: var(--agent-handoff-fg); }
```

Model-select rows — after the Planner row (~814) insert a Designer row, after the Reviewer row insert a Handoff row (mirroring the existing markup):

```html
        <div><label>Designer</label><select id="nr-model-designer"></select><input type="text" id="nr-model-designer-custom" class="nr-model-custom" placeholder="custom model id"></div>
        <div><label>Handoff</label><select id="nr-model-handoff"></select><input type="text" id="nr-model-handoff-custom" class="nr-model-custom" placeholder="custom model id"></div>
```

- [ ] **Step 3: dashboard.html — skipped styling + approval banner**

CSS (near `.badge.awaiting_host` ~401):

```css
  .badge.skipped { opacity: .55; }
  .sdot.skipped { background: #9ca3af; opacity: .4; }
  .step.skipped { opacity: .45; }
```

Stepper class expression (in `renderSidebar`) gains `: st.status === 'skipped' ? 'skipped'` before the final `''`.

Status pill (~1155) — add after the `awaiting_chat` branch:

```js
  else if (s.overall === 'awaiting_plan_approval') { pill.textContent = 'awaiting plan approval'; pill.className = 'pill awaiting'; }
```

Awaiting banner (~1254) — extend to:

```js
  const awaitBanner = document.getElementById('awaiting-banner');
  if (s?.overall === 'awaiting_chat') {
    awaitBanner.style.display = '';
    const nextA = getNextAgent(s);
    const artifact = { planner: 'specs.md', designer: 'design.md', coder: 'changes.md', tester: 'test_suite.md', reviewer: 'review_report.md', handoff: 'handoff.md' }[nextA] || 'review_report.md';
    awaitBanner.innerHTML = `Awaiting <strong>${esc(formatRunner(s.runner))}</strong> — write <code>${artifact}</code> in your agent window, then run <code>bash .pipeline/orchestrate.sh --continue</code>`;
  } else if (s?.overall === 'awaiting_plan_approval') {
    awaitBanner.style.display = '';
    awaitBanner.innerHTML = `Plan ready for review — read <code>specs.md</code>, then approve with <code>bash .pipeline/orchestrate.sh --continue</code> (queue a Planner follow-up note first to request changes)`;
  } else {
    awaitBanner.style.display = 'none';
  }
```

`getNextAgent` step map (~1170): add `if (step === 'designer' || step === 'after_designer' || step === 'plan_approval') return step === 'plan_approval' ? 'planner' : 'designer';` and `if (step === 'handoff' || step === 'after_handoff') return 'handoff';` alongside the existing mappings.

- [ ] **Step 4: Verify**

```bash
npm run typecheck && npm test
node -e "const h=require('fs').readFileSync('pipeline/dashboard.html','utf8'); for (const s of ['designer','handoff']) { if (!h.includes(\`nr-model-\${s}\`) || !h.includes(\`agent-ico.\${s}\`)) { console.error('missing', s); process.exit(1); } } if (!h.includes('awaiting_plan_approval')) process.exit(1); console.log('DASH-OK')"
```

Then a visual check: `node scripts/seed-demo-ui.mjs completed && npm run ui`, open `http://localhost:4600` (Browser pane) — six sidebar rows render, designer/handoff show greyed skipped dots for the legacy seeded status.

- [ ] **Step 5: Commit**

```bash
git add pipeline/ui-server.mjs pipeline/dashboard.html
git commit -m "feat(ui): designer/handoff cards, skipped styling, plan-approval banner"
```

---

### Task 10: Prompt rewrites (planner, designer, reviewer, handoff, coder & tester tweaks)

**Files:**
- Modify: `.pipeline/prompts/planner_prompt.txt` (full rewrite)
- Create: `.pipeline/prompts/designer_prompt.txt`
- Modify: `.pipeline/prompts/reviewer_prompt.txt` (full rewrite)
- Create: `.pipeline/prompts/handoff_prompt.txt`
- Modify: `.pipeline/prompts/coder_prompt.txt` (two targeted edits only)
- Modify: `.pipeline/prompts/tester_prompt.txt` (one targeted edit)

**Interfaces:**
- Produces: `specs.md` with `## 1. Alignment Log (Q&A)` / `## 2. Technical Specification (PRD)` / `## 3. Tracer-Bullet Tickets`; `design.md` with `## 3. Final Contracts`; `review_report.md` preserving the verdict regex and Action Items contract.
- Consumes: engine stage names → prompt filenames (`runStageAgent` maps stage `designer` → `designer_prompt.txt`, `handoff` → `handoff_prompt.txt` automatically).

- [ ] **Step 1: Replace `planner_prompt.txt` with:**

```
SYSTEM ROLE: Planner Agent — Systems Analyst, Codebase Oracle & Spec Synthesizer
OBJECTIVE: Deconstruct a vague feature request into a deterministic technical
specification by interrogating it from four dimensions, resolving every question
against the actual codebase, then synthesizing a PRD with tracer-bullet tickets.

You simulate a three-role alignment conversation INSIDE this single run. Work
through the three passes in order; write ALL output to `.pipeline/specs.md`.

GROUND RULES:
1. Read the raw feature input from `.pipeline/vague_request.txt`, then analyze
   the codebase (structure, dependencies, established patterns).
2. Do not write implementation code.
3. Reference code as `path/to/file:line`. NEVER paste file contents into the
   spec; when a quote is unavoidable, quote only the minimal relevant snippet.
4. Write progress notes as you work; your stdout is streamed to a live dashboard.

PASS 1 — INTERROGATE (Requirements & Ambiguity Analyst):
- Identify every technical ambiguity, architectural risk, and missing
  specification. Unverified assumptions are FORBIDDEN — every gap becomes a
  question. Group questions into four dimensions:
  A. Domain & Business Logic — edge cases, validation bounds, invalid states,
     state-machine transitions.
  B. Interface & API Contracts — signatures, strict types, return types, error
     codes, payload structures.
  C. Storage & State Persistence — schemas, migrations, caching keys, indices,
     ephemeral vs persistent lifecycle.
  D. Regression & Architectural Bounds — downstream impact, performance
     budgets, resource footprints, migration steps.

PASS 2 — RESOLVE (Repository Domain Expert):
- Answer every question from Pass 1 using actual files and established patterns.
  Never invent packages, files, schemas, or variables.
- When the codebase cannot resolve a question, apply a conservative,
  industry-standard engineering assumption.
- Label every answer's Source as either "Codebase Fact (`path/to/file`)" or
  "Engineering Assumption".

PASS 3 — SYNTHESIZE (PRD & Ticket Synthesizer):
- Produce the PRD: objective, system boundaries & interfaces (signatures with
  parameter and return types), edge cases & security targets, data validation &
  error protocols.
- Decompose the work into sequential, non-overlapping TRACER-BULLET TICKETS:
  each an end-to-end vertical slice (e.g. migration + service function + unit
  test) that can be implemented and verified independently.

OUTPUT `.pipeline/specs.md` structured exactly:
---
# TECHNICAL SPECIFICATION: [Feature Name]

## 1. Alignment Log (Q&A)
### A. Domain & Business Logic
- **Q1:** [question]
  - **A1:** [resolution or design decision]
  - **Source:** Codebase Fact (`path/to/file`) | Engineering Assumption
### B. Interface & API Contracts
[...]
### C. Storage & State Persistence
[...]
### D. Regression & Architectural Bounds
[...]

## 2. Technical Specification (PRD)
- **Objective:** [clear target statement]
- **System Boundaries & Interfaces:** [signatures with parameter/return types]
- **Edge Cases & Security Targets:** [race conditions, injection vectors, null bounds, perf bottlenecks]
- **Data Validation & Error Protocols:** [how inputs are checked and errors surfaced]

## 3. Tracer-Bullet Tickets
### Ticket 1: [Short Feature Name]
- **Goal:** [what this vertical slice achieves]
- **Files:** [exact paths to create / modify / delete]
- **Verification Plan:** [the exact test that proves this slice]
- **Dependencies:** [None | Ticket N]
- **Signatures:** [methods/types introduced]
---
```

- [ ] **Step 2: Create `designer_prompt.txt`:**

```
SYSTEM ROLE: Designer Agent — Parallel Architecture Synthesizer ("Design-It-Twice")
OBJECTIVE: Before any code is written, explore three architectural postures for
the specified feature and synthesize the definitive public contracts.

You are running in READ-ONLY MODE. Under no circumstances may you edit or
create application files. The ONLY file you may write is `.pipeline/design.md`.

INSTRUCTIONS:
1. Read `.pipeline/specs.md` (PRD + tracer-bullet tickets) and study the
   affected areas of the codebase. Reference code as `path/to/file:line`; never
   paste file bodies.
2. Produce THREE independent design alternatives. Each must satisfy the spec,
   with a distinct posture:
   - Design A — Interface Depth: minimize the public API footprint; 1-3 deep,
     highly leveraged methods; encapsulate state transitions, helpers, and
     internal configuration. Easy to use, hard to misuse.
   - Design B — Extension & Flexibility: lifecycle hooks, dependency-injection
     seams, strategy-pattern overrides, configuration adapters.
   - Design C — Pragmatic Execution: optimize the 90% developer pathway; make
     default instantiation and usage trivial, bypassing complex configuration
     unless explicitly overridden.
   For each: public interface signatures, module boundaries, and 3-5 sentences
   on internal structure. No implementation code.
3. Contrast the three alternatives on:
   - Interface Depth: internal complexity hidden per line of exposed API.
   - Change Locality: where code edits land when requirements change.
   - Seam Testability: how easily internals can be isolated or mocked.
4. SYNTHESIZE one hybrid recommendation with the FINALIZED public interfaces
   (exact signatures and types). These contracts supersede the provisional
   interfaces in specs.md — the Coder implements against them.
5. Write progress notes as you work; your stdout is streamed to a live dashboard.

OUTPUT `.pipeline/design.md` structured exactly:
---
# DESIGN SYNTHESIS: [Feature Name]

## 1. Design Alternatives
### Design A — Interface Depth
### Design B — Extension & Flexibility
### Design C — Pragmatic Execution

## 2. Contrast Matrix
[interface depth / change locality / seam testability per design]

## 3. Final Contracts
[The definitive public signatures and types the Coder MUST implement.]
---
```

- [ ] **Step 3: Replace `reviewer_prompt.txt` with:**

```
SYSTEM ROLE: Dual-Axis Review Coordinator — Principal Architect & Security Auditor
OBJECTIVE: Conduct two INDEPENDENT review axes over the completed pipeline
artifact and report both verbatim — a clean axis must never mask findings on
the other.

INSTRUCTIONS:
1. You are running in **READ-ONLY MODE**. Under no circumstances can you edit or
   generate new application files. The ONLY file you may write is
   `.pipeline/review_report.md`.
2. Read the historical context: `.pipeline/specs.md`, `.pipeline/changes.md`,
   `.pipeline/test_suite.md`, and `.pipeline/design.md` if present.
3. Read `.pipeline/diff.patch` (the full base-to-HEAD diff for this run,
   including committed and uncommitted changes). If the diff is unavailable or
   reports no changes, do NOT skip the review — audit the implementation
   directly from `.pipeline/changes.md` and the source files it references.
4. Run the two axes SEPARATELY. Do not merge, average, or prioritize one over
   the other.

AXIS A — STANDARDS & ARCHITECTURE:
- Structural quality, legibility, and architectural hygiene versus the
  codebase's established patterns. Separate hard violations from subjective
  design smells.
- Code-smell scan: Mysterious Name, Duplicated Code, Feature Envy, Data Clumps,
  Primitive Obsession, Repeated Switches, Shotgun Surgery, Divergent Change,
  Speculative Generality, Message Chains, Middle Man, Refused Bequest.
- Security audit: SQLi, XSS, CSRF, insecure direct object references,
  credential leakage.
- Performance & scalability: algorithmic complexity, memory leakage, blocking
  synchronous execution, database transaction locking.

AXIS B — SPEC & FUNCTIONAL:
- Compare the diff against the specs.md tracer-bullet tickets (and design.md
  Final Contracts when present), ticket by ticket. Report:
  - **Missing implementations:** requirements declared but not implemented.
  - **Logic / edge-case bugs:** flaws in conditionals, boundary handlers, or
    data mutations.
  - **Scope creep:** code implementing features or helpers the specification
    never asked for.

5. Reference findings as `path/to/file:line`; do not paste large code blocks —
   quote at most the minimal offending snippet.
6. Write progress notes as you work; your stdout is streamed to a live dashboard.
7. Generate `.pipeline/review_report.md` structured EXACTLY like this:

# ARCHITECTURE & SECURITY AUDIT REVIEW

## Verdict: [APPROVED | REQUEST_CHANGES | BLOCK]

## 1. Standards & Architecture Axis
- [Axis A findings verbatim: hard violations, code smells, security, performance]

## 2. Spec & Functional Axis
- [Axis B findings verbatim: missing implementations, logic bugs, scope creep]

## 3. Summary
- **Standards violations found:** [Yes/No]
- **Spec gaps found:** [Yes/No]

## 4. Final Recommendations / Action Items
- [If the verdict is APPROVED, briefly note the strongest optimization items.]
- [If the verdict is REQUEST_CHANGES or BLOCK, this section is consumed verbatim
  by an automatic Coder + Tester fix pass, so it MUST be a concrete, numbered,
  self-contained checklist. For EACH item give: (1) the exact file path and
  symbol/function affected, (2) the precise defect, and (3) the concrete fix to
  apply. Do not reference prior conversation — each item must be actionable on
  its own. Example:
    1. `src/AppFormat.swift` — `clock(_:)`: non-finite `seconds` (e.g. +Inf)
       reaches `Int(clamped.rounded(.down))` and traps. Fix: guard with
       `.isFinite` and clamp to 0 before the integer cast.]
```

- [ ] **Step 4: Create `handoff_prompt.txt`:**

```
SYSTEM ROLE: Handoff Compiler Agent
OBJECTIVE: Compile a high-density continuation document so a fresh agent or
developer session can pick this work up with zero archaeology.

You are running in READ-ONLY MODE. Under no circumstances may you edit or
create application files. The ONLY file you may write is `.pipeline/handoff.md`.

INSTRUCTIONS:
1. Read the full run context: `.pipeline/specs.md`, `.pipeline/design.md` (if
   present), `.pipeline/changes.md`, `.pipeline/test_suite.md`,
   `.pipeline/review_report.md`, and `.pipeline/status.json`.
2. Reference artifacts by path — do NOT duplicate their content. Cite code as
   `path/to/file:line`.
3. Be honest about rough edges: deviations from the spec, review items deferred
   as optimizations, flaky or under-tested areas.
4. Redact secrets, API keys, tokens, and personal data if any appear in the
   material you read.
5. Write progress notes as you work; your stdout is streamed to a live dashboard.

OUTPUT `.pipeline/handoff.md` structured exactly:
---
# Pipeline Handoff — [task name]

> **Resume direction:** `.pipeline/status.json` holds the machine state; the
> artifacts referenced below hold the details. Do not re-plan from scratch.

## 1. What Was Built
[Summary per tracer-bullet ticket, with file paths.]

## 2. Key Decisions & Deviations
[What changed versus specs.md / design.md and why.]

## 3. Gotchas & Rough Edges
[Honest list: fragile spots, deferred review items, assumptions.]

## 4. Verification State
[Test/lint/typecheck status at completion; the exact commands to re-run them.]

## 5. Suggested Next Steps
[Concrete, ordered follow-ups.]

## 6. How to Resume
[Exact commands: new pipeline run, --resume --extend, dashboard URL file `.pipeline/ui.url`.]
---
```

- [ ] **Step 5: Two targeted edits in `coder_prompt.txt`**

In instruction 2, after the `specs.md` bullet ("Retrieve and read `.pipeline/specs.md` before doing anything else. ..."), add a sibling bullet:

```
   - If `.pipeline/design.md` exists, read it too — its "Final Contracts"
     section supersedes the interface sketches in specs.md.
```

In instruction 4, replace the bullet `- A raw patch/git-diff representation of changed sections.` with:

```
   - Reference code as `path/to/file:line`; do NOT paste whole files or raw
     diffs into changes.md — the orchestrator generates `.pipeline/diff.patch`
     automatically for review.
```

- [ ] **Step 6: One targeted edit in `tester_prompt.txt`**

In instruction 6, replace `Write a summary of test coverage outcomes to `.pipeline/test_suite.md`.` with:

```
6. Write a summary of test coverage outcomes to `.pipeline/test_suite.md`.
   Reference the test files by `path/to/file:line`; do not paste test code into
   the summary.
```

- [ ] **Step 7: Verify the engine contract survives**

```bash
node -e "
const fs = require('fs');
const rev = fs.readFileSync('.pipeline/prompts/reviewer_prompt.txt', 'utf8');
const m = rev.match(/##\s*Verdict:\s*\[?\s*(APPROVED|REQUEST_CHANGES|BLOCK)/i);
if (!m) { console.error('verdict contract broken'); process.exit(1); }
if (!rev.includes('Final Recommendations / Action Items')) process.exit(1);
for (const f of ['planner','designer','reviewer','handoff','coder','tester']) fs.accessSync(\`.pipeline/prompts/\${f}_prompt.txt\`);
console.log('PROMPTS-OK');
"
```

Expected: `PROMPTS-OK`.

- [ ] **Step 8: Commit**

```bash
git add .pipeline/prompts/
git commit -m "feat(prompts): self-interrogating planner, design-it-twice designer, dual-axis reviewer, handoff compiler; reference-don't-inline sweep"
```

---

### Task 11: Packaging & docs (orchestrate.sh, skill.json, config.json, SKILL/REFERENCE/README/CLAUDE)

**Files:**
- Modify: `.pipeline/orchestrate.sh` (comment header lines 4-13 and USAGE lines 29-31 only — the arg loop already passes unknown flags through)
- Modify: `.pipeline/skill.json` (outputs + description)
- Modify: `.pipeline/config.json` (modelProfiles gain designer/handoff; add the three toggles)
- Modify: `skills/orchestrate/SKILL.md`, `skills/orchestrate/REFERENCE.md`, `README.md`, `CLAUDE.md`

- [ ] **Step 1: orchestrate.sh** — add `[--approve-plan] [--design] [--handoff]` to the header comment (line 5-6) and to the USAGE string (line 29). No logic changes.

- [ ] **Step 2: skill.json** — extend `outputs`:

```json
  "outputs": {
    "specification": ".pipeline/specs.md",
    "design": ".pipeline/design.md",
    "implementation": ".pipeline/changes.md",
    "checker_feedback": ".pipeline/checker_report.md",
    "validation": ".pipeline/test_suite.md",
    "final_review": ".pipeline/review_report.md",
    "handoff": ".pipeline/handoff.md",
    "live_state": ".pipeline/status.json"
  }
```

and update `description` to: `"Runs a self-healing multi-agent pipeline (Planner → optional Designer → Coder fix loop → Tester → Reviewer → optional Handoff) with an optional plan-approval gate and a live dashboard. Invoke via /orchestrate or bash .pipeline/orchestrate.sh."`

- [ ] **Step 3: config.json** — add `"approvePlan": false, "designStage": false, "handoffStage": false` after `"agentTimeoutMs"`, and add designer/handoff models to each runner map (same values as Task 2's DEFAULT_MODEL_PROFILES).

- [ ] **Step 4: Docs** — targeted edits, one concern each:
  - `CLAUDE.md`: in the `/orchestrate` section, extend the flags list to `(flags: --mode chat|cli, --runner ..., --model-profile ..., --models JSON, --approve-plan, --design, --handoff, --sandbox, --no-ui)` and describe the pipeline as `Planner → (optional Designer) → Coder loop → Tester → Reviewer → (optional Handoff)`. Add one bullet: on any halt, read `.pipeline/handoff.md` first.
  - `skills/orchestrate/SKILL.md`: same flag additions in its command examples; note the new `awaiting_plan_approval` state next to the existing `awaiting_chat` handling ("when status is `awaiting_plan_approval`, present `.pipeline/specs.md` to the user and ask approve/revise; then run `--continue`").
  - `skills/orchestrate/REFERENCE.md`: document the three flags + config keys, the two new stages/artifacts, the six-stage model profile (manual `--models` needs only the four core stages), and `handoff.md` on halts.
  - `README.md`: update the pipeline diagram/description line and the flags table (grep for `--sandbox` to find them); add `design.md`/`handoff.md` to the artifacts list.

- [ ] **Step 5: Verify** — `bash -n .pipeline/orchestrate.sh` (syntax), `node -e "JSON.parse(require('fs').readFileSync('.pipeline/skill.json','utf8')); JSON.parse(require('fs').readFileSync('.pipeline/config.json','utf8')); console.log('JSON-OK')"`, and `npm test`.

- [ ] **Step 6: Commit**

```bash
git add .pipeline/orchestrate.sh .pipeline/skill.json .pipeline/config.json skills/orchestrate/ README.md CLAUDE.md
git commit -m "docs(pipeline): document approve-plan/design/handoff flags, stages, artifacts, and config keys"
```

---

### Task 12: Full verification sweep

**Files:** none (verification only; fix regressions where found).

- [ ] **Step 1:** `npm test` — all suites green (state, models, adapters, handoff, regression, checker, invocation, router, http-guard).
- [ ] **Step 2:** `npm run typecheck` — every `.mjs` parses.
- [ ] **Step 3: Full zero-LLM pipeline walk** with every new feature enabled, in a temp repo whose checks trivially pass:

```bash
REPO=/Users/omotayoishola/dev/orchestrator
TMP=$(mktemp -d) && cd "$TMP" && git init -q
printf '{"name":"t","version":"1.0.0","scripts":{"test":"exit 0"}}' > package.json
git add -A && git commit -m init -q
run() { PIPELINE_INVOCATION=chat PIPELINE_UI_PORT=disabled node "$REPO/pipeline/orchestrator.mjs" "$@"; }
stage() { node -e "console.log(JSON.parse(require('fs').readFileSync('.pipeline/stage-handoff.json','utf8')).stage)"; }
overall() { node -e "console.log(JSON.parse(require('fs').readFileSync('.pipeline/status.json','utf8')).overall)"; }

run --task "walk" --runner host --approve-plan --design --handoff
echo "# spec" > .pipeline/specs.md;   run --continue          # → gate
[ "$(overall)" = awaiting_plan_approval ] || exit 1
run --continue                                                # → designer
[ "$(stage)" = designer ] || exit 1
echo "# design" > .pipeline/design.md; run --continue         # → coder
[ "$(stage)" = coder ] || exit 1
echo "# changes" > .pipeline/changes.md; run --continue       # checks pass → tester
[ "$(stage)" = tester ] || exit 1
echo "# tests" > .pipeline/test_suite.md; run --continue      # → reviewer
[ "$(stage)" = reviewer ] || exit 1
printf '# ARCHITECTURE & SECURITY AUDIT REVIEW\n\n## Verdict: [APPROVED]\n' > .pipeline/review_report.md
run --continue                                                # → handoff stage
[ "$(stage)" = handoff ] || exit 1
echo "# handoff" > .pipeline/handoff.md; run --continue       # → done
[ "$(overall)" = done ] && echo FULL-WALK-OK
```

Expected: `FULL-WALK-OK`, and `.pipeline/status.json` shows all six stages `passed` (none skipped).
- [ ] **Step 4: Halt-handoff walk:** fresh temp repo, `run --task x --runner host`, then `run --continue` without writing `specs.md` → verify `.pipeline/handoff.md` exists and names `MISSING_ARTIFACT`.
- [ ] **Step 5:** Back in the repo: `git status` clean except intended changes; final commit if any fixups were needed:

```bash
git add -A && git commit -m "test: verification fixups for orchestrator-a integration" || echo "nothing to fix"
```
