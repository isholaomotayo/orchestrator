# Self-recovery and desktop history: Design

**Date:** 2026-10-03
**Status:** Approved by user. Decisions: rules-first recovery with an optional LLM only for `unknown` diagnoses; desktop DB keeps metadata, all events and ~2 KB log excerpts for 90 days.
**Plan:** [Orchestrator v4](../plans/2026-10-03-orchestrator-v4.md)

## Context

Stage 1 (WP1–WP10) is landed and green (`npm test` 884/884). Stage 2's thin M1 desktop app exists, and
this session added decision cards, plan card, autonomy control, pause-all, ack and the Dock badge (uncommitted).

Runs can still get stuck in states nobody can explain or fix without hand edits. The exploration found:

- **The table is `pipeline/recoverability.mjs`, keyed on `haltReason` only.** It has no surface axis and no entry
  for `INTEGRITY_VIOLATION`, `REGRESSION_BLOCKED`, `RUNNER_UNAVAILABLE`, `INTEGRITY_ERROR`, `DISMISSED`,
  `POOL_STOPPED`, `POOL_PAUSED`. They all fall through to "needs a human decision" with a generic hint
  (`handoff.mjs` `RESUME_HINTS`).
- **Silent states:**
  - A dead engine (`running`, pid gone) is `blocked` and nothing respawns it.
  - Nothing watches the supervisor: `heartbeatAt` is written and never compared.
  - A paused pool has no age limit.
  - A held ticket never times out.
  - `awaiting_chat` with an expired lease has no `reassign` verb in `COMMAND_TYPES`.
  - `status.completionBlocked` (`orchestrator.mjs:606`) is set and never read.
- **Audit gaps:** there is no `recovered` event. Auto-resume, auto-extend, ticket auto-retry, dismiss and dashboard
  resume/extend write no `intervention` event.
- **Drift:** `ui/actions.mjs:21` and `ui-server.mjs:677` keep their own recovery rules instead of reading the table.
- **Desktop persistence is one file** (`~/.orchestrator/desktop/notified.json`). The server exposes no history
  endpoint, because the ledger is only reachable through the legacy `/api/runs`. Event cursors don't survive a
  server restart, and there is no SQLite crate in the lock.

**Decisions already made:**
- Recovery is rules first, with an optional LLM only for diagnoses the rules mark `unknown`.
- The desktop DB stores metadata, all events, and the last ~2 KB of each stage log, kept 90 days.

**Intended outcome.** Every non-terminal run is always *progressing*, *waiting on a named party*, or *carrying a
diagnosis* with evidence and ranked remedies. "Unexplained" becomes a bug that a test catches. Node owns the
deterministic floor (works with no UI and no app). The desktop adds the database, history, insights and
review UI, and consumes only `/api/v1`.


## Invariants (unchanged, restated)

- Surface is immutable. Self-recovery never switches a run's surface.
- Self-recovery acts only when `policyOf()` is `autonomous`, only with safe and idempotent verbs, only inside
  budgets. In guided mode it diagnoses and offers the one-click remedy.
- It never approves a plan, approves a merge, deletes data, or forces anything.
- Node never reads the desktop DB. The desktop never reads or writes `.pipeline/`. The contract is `/api/v1`.
- `desktop/` stays outside the installer's `MANAGED` list and the scaffold's `COVERED_ROOTS`. Releases use `desktop-v*` tags.


## Synergy and isolation

| Mode | What works |
|---|---|
| Skill only | Doctor, self-heal, `doctor --fix`, and diagnosis in the web dashboard |
| App only (review mode) | Browse all stored history, runs, connections and insights |
| Together | Live ingestion, gapless backfill, recurring-failure insights, native remedy cards |


## Design summary

- **Doctor (`pipeline/doctor.mjs`):** a pure `diagnose()` returns `{state, cause, explanation, evidence[], remedies[]}` for every non-terminal run. Remedies come from the single recoverability table. It is exposed as `diagnosis` on the v1 `RunSummary`, through `orchestrate.sh doctor`, and in the web dashboard.
- **Self-heal (`pipeline/self-heal.mjs`):** acts only for autonomous runs, only with safe idempotent verbs, only inside per-run budgets. An exhausted budget flips the run to guided and opens one deduped attention item.
- **History API:** ledger, cross-run events with a stable `<runId>:<seq>` cursor and an `epoch`, decisions and attention history, log excerpts, cost, and `attention.snooze`.
- **Desktop DB (`orch-store`, SQLite, WAL):** `$ORCHESTRATOR_HOME/desktop/history.sqlite`. It is fed by the same client event stream plus a backfill on connect. Tokens are never stored. Log excerpts are secret-scrubbed on write. A prune job enforces the 90-day retention.

See the plan for the work packages, sequence and verification.
