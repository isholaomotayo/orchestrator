# Orchestrator A Integration — Design

**Date:** 2026-07-16
**Status:** Approved by user (all four sections)

## Goal

Fold the "Orchestrator A" prompt architecture into the existing pipeline
(Planner → Coder self-heal loop → Tester → Reviewer) using a hybrid strategy:

- **Prompt-level** upgrades for planning (self-questioning/self-answering
  simulation) and review (dual-axis), keeping the proven 4-stage state machine.
- **Two new optional stages**: a flag-gated Designer stage (Design-It-Twice)
  and a Handoff stage (deterministic on halt, agent-generated on flag).
- A **reference-don't-inline** token-minimisation rule across all prompts.

Explicitly out of scope (user decision): strict TDD red-green-refactor in the
Coder, automatic `git reset` rollback, hard word/size caps on artifacts,
task-size-aware stage skipping, engine-level context pruning.

## Decisions log (from brainstorming)

| Decision | Choice |
|---|---|
| Integration depth | Hybrid: prompt-level planning/review, real optional Designer + Handoff stages |
| Designer execution | One agent invocation producing N postures + synthesis internally |
| Plan approval gate | Optional `--approve-plan` flag, default off |
| Handoff trigger | `--handoff` flag after APPROVED review **and** automatic on every halt |
| Handoff generation | Deterministic (no LLM) on halt; agent invocation on `--handoff` |
| Coder TDD protocol | Keep current implement-then-checker behavior |
| Token measures | Reference-don't-inline only (no hard caps, no stage skipping, no engine pruning) |
| Stage-list structure | Fixed six-stage list with `skipped` status (Approach A) |

## Architecture

New canonical stage order (`STAGES` in `pipeline/state.mjs`):

```
planner → designer → coder → tester → reviewer → handoff
```

`designer` and `handoff` are always present in `status.stages` but are marked
`status: 'skipped'` at run start when their flag/config is not enabled. All
existing consumers (dashboard, `getResumePoint()`, model maps) keep a stable
schema; the dashboard greys out skipped cards.

New stage status value: `skipped` (alongside pending/running/passed/failed/blocked).
New overall status value: `awaiting_plan_approval` (alongside running/awaiting_chat/done/halted).

## Section 1 — Planner: self-interrogation + optional approval gate

### Prompt (`.pipeline/prompts/planner_prompt.txt`, rewritten)

One Planner invocation simulates the Orchestrator A three-agent conversation
internally, in three mandatory passes, all written to the single existing
artifact `.pipeline/specs.md`:

1. **Interrogate** — after codebase analysis, generate clarifying questions
   across four dimensions: (A) Domain & Business Logic, (B) Interface & API
   Contracts, (C) Storage & State Persistence, (D) Regression & Architectural
   Bounds. Unverified assumptions are forbidden — every gap becomes a question.
2. **Resolve** — answer every question; each answer labeled either
   **Codebase Fact** (with `path/to/file` citation) or **Engineering
   Assumption** (conservative, industry-standard).
3. **Synthesize** — PRD (objective, system boundaries, interface signatures)
   plus **tracer-bullet tickets**: sequential, non-overlapping vertical slices,
   each with goal, exact files to create/modify/delete, verification plan,
   dependencies, and introduced signatures.

`specs.md` layout:

```
# TECHNICAL SPECIFICATION: <name>
## 1. Alignment Log (Q&A)
## 2. Technical Specification (PRD)
## 3. Tracer-Bullet Tickets
```

Reference-don't-inline: cite `path:line`; never paste file bodies.

Artifact stays `specs.md` → zero engine changes to artifact validation, and
downstream prompts already point at it.

### Approval gate

- New CLI flag `--approve-plan`; config key `approvePlan` (default `false`).
- When enabled: after the Planner stage passes, the orchestrator sets
  `status.overall = 'awaiting_plan_approval'`, records
  `resumePoint = { step: 'plan_approval' }`, prints where to read the spec,
  finalizes status, releases the lock, and exits 0 — same lifecycle pattern as
  `awaiting_chat`.
- `orchestrate.sh --continue` recognises `awaiting_plan_approval` and proceeds
  to the next stage (Designer if enabled, else Coder).
- Revision loop: if a follow-up note is queued for the planner (existing
  `.pipeline/followups/planner.txt` mechanism) at continue time, the Planner is
  re-run once with the note injected, then the gate re-arms. Approval with no
  queued follow-up proceeds.
- Dashboard shows an "Awaiting plan approval" banner with the continue command.
- The gate applies in both CLI and chat invocation modes; in chat mode it is an
  additional pause after the planner's own `awaiting_chat` handoff completes.

## Section 2 — Designer stage (flag-gated Design-It-Twice)

- New CLI flag `--design`; config key `designStage` (default `false`).
- Runs between Planner (after the approval gate, if any) and Coder.
- **Read-only** invocation (like the Reviewer): may write only its artifact
  `.pipeline/design.md`.
- New prompt `.pipeline/prompts/designer_prompt.txt`. A single agent:
  1. Produces **three design alternatives** with distinct postures:
     - *Interface depth*: minimal public API, 1–3 deep methods, easy to use /
       hard to misuse.
     - *Extensibility*: lifecycle hooks, DI seams, strategy overrides.
     - *Pragmatic*: trivial default path for the 90% case.
  2. Contrasts them on **interface depth, change locality, seam testability**.
  3. Emits a **synthesis**: the finalized public contracts
     (signatures/types) that supersede the spec's provisional interfaces.
- Coder prompt gains one instruction (Coder touch #1 of 2): if
  `.pipeline/design.md` exists, its synthesized contracts take precedence over
  the interface sketches in `specs.md`.
- Engine: new resume/chat-handoff steps `designer` / `after_designer`;
  `requireArtifact('designer', paths.design)`; stage marked `skipped` when the
  flag is off.
- Models: `designer` added to every model profile (planner-tier model — it is
  architecture work). Dashboard model-select gains a Designer row.

## Section 3 — Reviewer: dual-axis restructure (prompt-only)

`.pipeline/prompts/reviewer_prompt.txt` restructured. One read-only Reviewer
run produces two **independent** axis reports, output **verbatim** — the prompt
explicitly forbids merging, averaging, or letting one axis mask the other:

- **Axis A — Standards & Architecture**: structural quality, legibility,
  architectural hygiene, Fowler code-smell scan (Mysterious Name, Duplicated
  Code, Feature Envy, Data Clumps, Primitive Obsession, Repeated Switches,
  Shotgun Surgery, Divergent Change, Speculative Generality, Message Chains,
  Middle Man, Refused Bequest), **plus** the existing security audit
  (SQLi/XSS/CSRF/IDOR/credential leakage) and performance/scalability review.
  Hard violations separated from subjective smells.
- **Axis B — Spec & Functional**: diff vs. `specs.md` tickets — missing
  implementations, logic/edge-case bugs, and **scope creep** (code that
  implements things the spec never asked for).

Preserved engine contracts (unchanged, load-bearing):

- The `## Verdict: [APPROVED | REQUEST_CHANGES | BLOCK]` line parsed by
  `afterReviewerAudit()` (`pipeline/orchestrator.mjs`).
- The numbered, self-contained "Final Recommendations / Action Items"
  checklist consumed verbatim by the automatic Coder+Tester fix pass.

Report layout:

```
# ARCHITECTURE & SECURITY AUDIT REVIEW
## Verdict: [APPROVED | REQUEST_CHANGES | BLOCK]
## 1. Standards & Architecture Axis
## 2. Spec & Functional Axis
## 3. Summary  (Standards violations: Y/N · Spec gaps: Y/N)
## 4. Final Recommendations / Action Items
```

Zero engine changes for this section.

## Section 4 — Handoff stage + engine plumbing + token rule

### Handoff on halt (automatic, deterministic, zero tokens)

- New module `pipeline/handoff.mjs` exporting a pure
  `compileHaltHandoff({ status, paths, gitInfo })` → markdown string.
- `halt()` in `orchestrator.mjs` calls it to write `.pipeline/handoff.md`
  before exiting, for every halt reason (MAX_CYCLES, REGRESSION_BLOCKED,
  MISSING_ARTIFACT, AGENT_ERROR, INTERRUPTED).
- Contents (template filled from state, no LLM): goal/task, phase at freeze,
  halt reason + detail, per-stage status table, test-history trend
  (passed/failed per cycle), pointers to `checker_report.md` /
  `review_report.md` / logs, git branch + `baseRef` + dirty/clean state, and
  the exact resume command (`node pipeline/orchestrator.mjs --resume
  [--extend <n>]` / `bash .pipeline/orchestrate.sh --continue`).
- Robust by construction: runs even when the halt cause is the agent CLI
  itself. Pure function → unit-testable without running a pipeline.

### Handoff on success (`--handoff` flag, agent-generated)

- New CLI flag `--handoff`; config key `handoffStage` (default `false`).
- After an APPROVED verdict and before `finishApproved()` completes the run, a
  Handoff Compiler agent runs (read-only; writes only `.pipeline/handoff.md`).
- New prompt `.pipeline/prompts/handoff_prompt.txt`: summarize what was built,
  key decisions and deviations (drawn from specs/design/changes/review
  artifacts), gotchas discovered, suggested next steps, and how a fresh
  session resumes or extends the work. **Reference artifacts by path — do not
  duplicate their content.** Redact secrets/PII if any surfaced in logs.
- Chat mode: `handoff` / `after_handoff` resume steps, standard handoff flow.
- No separate `.orchestrator_state.json`: `status.json` already is the
  serialized machine state; duplicating it into a second file would rot.

### Engine & packaging plumbing

- `state.mjs`: `STAGES` → six entries; `newStatus()` marks designer/handoff
  `skipped` unless enabled (via new args to `newStatus` or post-construction);
  `pipelinePaths` gains `design` (`design.md`) and `handoffDoc`
  (`handoff.md`); `STAGE_ARTIFACT_FILES` gains designer/handoff entries.
- `orchestrator.mjs`: parse `--approve-plan`, `--design`, `--handoff`; extend
  USAGE; add stages to fresh-run flow, `chatContinueRun()`,
  `resumeInterruptedRun()`, `getResumePoint()`; add `design.md`/`handoff.md`
  to `RUN_FILES` archival.
- `orchestrate.sh`: pass through the three new flags.
- `models.mjs` + `config.json` defaults: `designer` and `handoff` stage models
  in every profile (handoff: cheapest tier — it is summarisation).
- `dashboard.html`: Designer + Handoff cards (icons, `STEP_LABELS`, `ORDER`,
  stage metadata, model selects), `skipped` styling, "Awaiting plan approval"
  banner.
- `skill.json`: new outputs (`design`, `handoff`) and flag docs.
- Docs: `README.md`, `CLAUDE.md`, `skills/orchestrate/SKILL.md`,
  `skills/orchestrate/REFERENCE.md` updated for new flags/stages/artifacts.

### Reference-don't-inline sweep (all prompts)

- Cite `path:line` instead of pasting file contents; quote only the minimal
  relevant snippet when a quote is unavoidable.
- Coder's `changes.md` (Coder touch #2 of 2): drop the required "raw
  patch/git-diff representation" — the engine already produces `diff.patch`
  for review — in favor of file list + logic breakdown. The fix-cycle append
  behavior ("## Fix Cycle N") is unchanged.

## Error handling

- Missing `design.md` / `handoff.md` after their stage → existing
  `MISSING_ARTIFACT` halt path.
- Handoff **agent** failure after an APPROVED verdict must not un-approve the
  run: on handoff-stage `AGENT_ERROR`, fall back to writing the deterministic
  halt-style handoff doc, mark the handoff stage `failed`, but finish the run
  as `done` with verdict APPROVED (the code is approved; only the narrative
  doc degraded).
- `awaiting_plan_approval` with a deleted/empty `specs.md` at continue time →
  `MISSING_ARTIFACT`.
- Back-compat: resuming a pre-upgrade `status.json` (4-stage array) must not
  crash — `stage(name)` lookups for designer/handoff return undefined only in
  legacy resumes, so the resume path backfills missing stage entries as
  `skipped` on load.

## Testing plan

- `handoff.test.mjs`: `compileHaltHandoff` covering each halt reason, empty
  test history, missing git info, dirty/clean tree.
- `state.test.mjs` additions: six-stage `newStatus` with skipped marking;
  legacy 4-stage status backfill.
- `orchestrator` arg parsing: new flags recognised, USAGE updated (covered via
  existing parse tests if present, else a small test).
- `regression.test.mjs` and all existing tests stay green (verdict parsing,
  archival, lock behavior).
- Manual smoke: one `--design --approve-plan --handoff` run in `--sandbox`
  against a toy task; one forced MAX_CYCLES halt verifying `handoff.md`
  appears.

## Non-goals / future iterations

- True parallel design sub-agents (engine concurrency).
- Word/size caps on artifacts; task-size-aware profiles (`--quick`).
- Engine-level context pruning of checker reports fed to later cycles.
- TDD red-green-refactor Coder protocol and green-commit rollback.
