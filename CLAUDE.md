# Claude Code Instructions

## Workspace skill: `/orchestrate`

This repository ships a portable multi-agent pipeline declared in `.pipeline/skill.json`.
It runs: **Planner → (optional Designer) → Coder loop → Tester → Reviewer (or Review Panel) → Handoff → Reporter**, with a live dashboard whose URL is dynamically selected and saved to `.pipeline/ui.url` (usually starting at `http://localhost:4600`). Handoff and Reporter are mandatory — every run that reaches an `APPROVED` verdict always produces both, with no flag to disable either.

Only invoke this pipeline when the user **explicitly** asks for it — they type `/orchestrate`, or clearly ask to "orchestrate this", "run the pipeline", "use the multi-agent pipeline", or similar. Do NOT infer an implicit request from an ordinary "build this feature" / "fix this bug" / "refactor this" ask; do those directly. Never invoke it on your own initiative, and never as a way to hand off a task someone else gave you (see the self-invocation guard below).

0. **Self-invocation guard — check before every invocation, no exceptions**: read `.pipeline/status.json` (if present). If `overall` is `running`, `awaiting_chat`, or `awaiting_plan_approval`, a pipeline run is already active — **do not** invoke `bash .pipeline/orchestrate.sh` with a new task. `.pipeline/.lock` is NOT a reliable signal for this: chat-mode handoffs release the lock the moment control returns to this session, so the lock can be absent for the entire duration of a stage while a run is still very much active. If you are yourself in the middle of completing a stage handoff (`.pipeline/stage-handoff.json` exists) — including when the assigned stage is itself "build a feature" — that is not a new orchestrate request; just complete the assigned stage and run `--continue`. A fresh invocation while `status.json` already reflects an active run archives it as if it had finished and starts a new one on top of it, silently destroying the in-progress run.
1. Once a run IS active, do not plan and hand-edit the same files yourself alongside it — the run owns the working tree until it finishes or halts. This is a concurrency rule, not a mandate to route work through the pipeline; ordinary requests you were asked to do directly, you do directly.
2. Invoke: `bash .pipeline/orchestrate.sh "<user requirements>"` (flags: `--mode chat|cli`, `--host-client <name>`, `--runner claude|cursor|codex|antigravity|host`, `--model-profile auto|manual`, `--models JSON`, `--approve-plan`, `--design`, `--review-panel`, `--sandbox`, `--allow-self`, `--max-cycles n`, `--max-post-tester-cycles n`, `--max-review-cycles n`, `--no-ui`).
3. **You are a chat session**: always invoke with `--mode chat --host-client claude`. Never pass `--runner`. Never spawn or delegate to another agent CLI — YOU complete each stage from `stage-handoff.json`, then run `--continue`. Exit code 3 means the target is the orchestrator SOURCE repo — do not override (`--allow-self` is maintainers-only); run from a consumer project instead.
4. **Before starting** (slash command / chat): ask whether to use automatic cost-optimized per-stage models or manual selection. This is the only pre-run question. Then pass `--model-profile auto` or `--model-profile manual --models '...'`.
5. **Chat mode**: complete each stage from `.pipeline/stage-handoff.json` in the IDE session (honor `handoff.model` if available here, else use your active chat model and record it as `actualModel`), then `bash .pipeline/orchestrate.sh --continue`. While working the stage, this session IS "the currently running agent" the dashboard's chat box targets — periodically (e.g. between tool calls, or every couple of minutes on longer stages) check `.pipeline/followups/<stage>.txt` for the stage you're on. If it has content, that's a live note queued from the dashboard: read it, fold it into the work immediately, then delete the file so it isn't reapplied later. Don't wait for the file to be non-empty at the *start* of the stage only — the orchestrator process itself has exited for this handoff and will not re-check it for you until this stage runs again.
6. **CLI mode**: wait for the pipeline to exit.
7. Read `.pipeline/review_report.md` and present the audit verdict. Then tell the user where the full stage-by-stage history lives: the dashboard URL in `.pipeline/ui.url` (Runs → this run → the stage rail — Planner through Reporter, each with its conversation feed, artifact, and raw log, still browsable after the run has landed), and the run's own directory (`.pipeline/` for a v1 run, `.pipeline/runs/<runId>/` for a pool run) holding every artifact file directly, for anyone who'd rather read files than use the dashboard.
8. If the pipeline halts (`MAX_CYCLES`, `REGRESSION_BLOCKED`, `MISSING_ARTIFACT`, `AGENT_ERROR`), read `.pipeline/handoff.md` first (written automatically on every halt), then surface `.pipeline/checker_report.md` or logs and ask the human how to proceed.

## Workspace isolation (strict)

- Treat `.pipeline/` and `.pipeline_sandbox/` as READ-ONLY unless you are the pipeline orchestrator.
- Never auto-fix errors inside `.pipeline_sandbox/` — the self-healing orchestrator owns them.
- PRE-FLIGHT CHECK: a pipeline run is active if `.pipeline/.lock` exists, OR `.pipeline/status.json`'s `overall` is `running` / `awaiting_chat` / `awaiting_plan_approval`. Check both — the lock alone misses the entire chat-handoff window (see the self-invocation guard above). Do not start overlapping autonomous work, and do not re-invoke `/orchestrate` for a task you are already executing as part of an active run's stage handoff.


## Roadmap (pool) mode — v2

**The coordinator never does stage work and never spawns workers — except a `claim-run` item, which is an invitation to do exactly that.** In single-run chat mode YOU complete each stage from `stage-handoff.json` and run `--continue`. In roadmap (pool) mode the supervisor spawns a real OS process only for a feature/ticket whose resolved runner is an authenticated agent CLI — opt in per feature with roadmap.md's `- runner: claude|cursor|codex|antigravity` bullet, for genuine unattended parallel automation. Everything else defaults to `runner: host`: no subprocess, no CLI auth needed anywhere. When `pool digest`/`pool attention` shows a `claim-run` item, run `bash .pipeline/orchestrate.sh pool claim <runId>`, complete that stage yourself exactly as in single-run mode, then `bash .pipeline/orchestrate.sh --continue --run-id <runId>`. Otherwise you do intake, answer decisions, and approve merges with `pool` verbs.

**Self-invocation guard** — check before every invocation: read `.pipeline/status.json` and, when `.pipeline/control/` exists, `node pipeline/pool.mjs status --json`. If `overall` is `running`, `awaiting_chat`, or `awaiting_plan_approval`, or a supervisor pid in `.pipeline/control/supervisor.pid` is alive, work is already in flight — drain it (`/digest`) instead of starting anything. If `status.json` has a `pool` field, add work with `roadmap add`, never a fresh `--task`. `.pipeline/.lock` alone is NOT a reliable signal: chat handoffs release it while a run is still active.

**Workspace isolation.** Treat `.pipeline/`, `.pipeline_sandbox/` (legacy), `.pipeline/runs/`, `.pipeline/worktrees/` and `.pipeline/control/` as READ-ONLY unless you are completing an assigned stage. Never `cd` into or edit anything under `.pipeline/worktrees/<runId>` — a worker owns that tree. Change pool state only through `pool` verbs.

**Reading and steering a roadmap run:**

```
bash .pipeline/orchestrate.sh --roadmap .pipeline/roadmap.md   # compile and start
bash .pipeline/orchestrate.sh pool digest                      # four-section status
bash .pipeline/orchestrate.sh pool claim <runId>               # pick up a run parked in chat
bash .pipeline/orchestrate.sh pool decide <id> "<answer>"      # answer a question
bash .pipeline/orchestrate.sh pool approve-merge <featureId>   # only after the human says so
```

Merging is the one irreversible step: never approve a merge the human has not
explicitly agreed to, even when a review is APPROVED.

**Third-party skills** are declared in `.pipeline/config.json` and pinned by
hash. A skill whose bytes changed is refused for that run and reported — pin it
again with `node pipeline/skills.mjs pin <name>` only after reviewing the change.
