# Orchestrator v2 — Roadmap-driven worker pool — Design

**Date:** 2026-09-06
**Status:** Approved by user (four decisions below)

## Goal

Cross the fork the README names at "Future improvements": turn the single-task,
one-run-per-repo pipeline into a **roadmap-driven worker pool** with a browser
control room, while keeping v1 single-task `/orchestrate` working unchanged.

Three capabilities:

1. **Roadmap execution** — a roadmap of features is worked through
   sequentially; within a feature, independent tickets run as parallel worker
   pipelines, fan in, and land as one change.
2. **Third-party skills** — a pinned, hash-verified skill registry, so a stage
   agent can use an external skill (first: Archify diagrams) and the run can
   publish a self-contained HTML "work done" report.
3. **Browser control room** — monitor, follow and review the whole pool from
   the dashboard: fleet navigation in the sidebar, tabs for concurrent runs,
   a review pane, a decisions inbox and a report viewer.

## Provenance

The supervision model is adapted from **kunchenguid/firstmate** (MIT): one
coordinator agent in front of many isolated worker agents, worktree-per-task,
durable on-disk state with an append-only verb log, a zero-token watcher that
only wakes the coordinator on actionable events, and explicit approval gates.
firstmate has no browser UI (it uses terminal multiplexers); the monitoring
surface here is ours. Its nautical vocabulary is deliberately **not** adopted.

| firstmate | Ours |
|---|---|
| captain | operator (the human) |
| first mate | coordinator (the chat session) |
| crewmate | worker (a headless pipeline run) |
| crew / fleet | pool; control tree at `.pipeline/control/` |
| ship / scout task | build / research task |
| bearings, ahoy, afk, stow | `/digest`, `/catchup`, `/unattended`, `/notes` |
| watcher | supervisor (`pipeline/supervisor.mjs`) |
| wake / wake queue | notification / attention queue |
| landing / teardown | merge / cleanup |

## Decisions log

| Decision | Choice |
|---|---|
| Source to adapt | `kunchenguid/firstmate` (MIT), model only — not its backends or names |
| Worker execution | Headless CLI workers via the existing adapters, one git worktree each, spawned only by the supervisor; the chat session is the coordinator and never does stage work in pool mode |
| Roadmap concurrency | Features sequential (N+1 branches from N's merged base); tickets within a feature parallel |
| Landing | Branch per feature, PR opened after `APPROVED`, pause at `awaiting_merge_approval`, merge only after operator approval plus a live mergeability read |
| Dashboard | Hybrid: sidebar becomes pool navigation, a tab strip is added; still zero runtime dependencies, no framework, no CDN |
| Client packaging | `pipeline/ui/*.mjs` sources concatenated into the committed `pipeline/dashboard.html` by a Node-core build script, with a CI drift check |
| Skill exposure | Prompt injection of a verified `SKILL.md`, never runner auto-discovery |
| Diagram rendering | Agents author Archify JSON specs inside their artifact; trusted engine code validates and renders them |
| Reporter | A new optional stage, soft-fail, hybrid: deterministic compiler plus an agent-authored narrative |

## Architecture

```
operator (dashboard + chat)
   │ decisions / approvals / roadmap edits
   ▼
coordinator (chat session) ──────────▶ .pipeline/roadmap.md  (tracked intent)
   │ intake, decisions, approvals            .pipeline/control/
   │ never does stage work                   ├─ roadmap.json    (compiled + status)
   ▼                                         ├─ snapshot.json   (pool snapshot v1)
supervisor (pipeline/supervisor.mjs)         ├─ decisions.jsonl, attention.jsonl
   │ zero-LLM daemon: spawn, tail,           ├─ briefs/<runId>.md, notes/
   │ classify, escalate, merge               └─ supervisor.{log,pid}, .lock
   ▼
workers = orchestrator.mjs children, one per run
   worktree .pipeline/worktrees/<runId>, branch pipeline/<featureId>/<runId>
   state   .pipeline/runs/<runId>/ (run.json, run.status, status.json, events.jsonl, …)
   ▲
dashboard (ui-server + dashboard.html): watches .pipeline/, /api/*, SSE v2
```

Feature lifecycle: `queued → planning → executing → integrating → reviewing →
awaiting_merge_approval → merging → landed`, with `failed | held | skipped`
off-ramps. Run verb log verbs: `working`, `needs-decision`, `blocked`,
`paused`, `held`, `resolved`, `done`, `failed`, `landed`, `note`.

## Invariants

1. **v1 never regresses.** `pipelinePaths(repoRoot)` with no run id returns
   exactly today's shape; a run without `--run-id` behaves exactly as today.
2. **One writer per file.** Workers write only their own run dir; the
   supervisor alone writes `control/` and the root `status.json` mirror, so
   `integrity.mjs`'s single-writer assumption holds.
3. **The root lock keeps its meaning.** The supervisor holds
   `.pipeline/.lock` with `role: 'supervisor'`, so every existing "is the repo
   busy?" check stays truthful.
4. **Scripts own logic, agents own judgment.** Every coordinator action is a
   `pool` verb; the agent decides what to recommend, never what is pending.
5. **Nothing unverified is executed or injected.** Skills are pinned by a
   sha256 tree manifest, mirroring the scaffold manifest discipline.
6. **Never discard unmerged work.** Worktree cleanup is fail-closed; a refusal
   is a recorded note, never a silent delete.

## Out of scope

Remote or secondary coordinators on other hosts; terminal-multiplexer
backends; voice or relay integrations; multi-human collaboration; a pool eval
task in `evals/` (follow-up).

## Plan

See `docs/superpowers/plans/2026-09-06-orchestrator-v2-pool.md`.
