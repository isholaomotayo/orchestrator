# Agent Instructions (Codex / Antigravity / any AGENTS.md-aware CLI)

## Operating principles

- **One entry point:** an explicit `/orchestrate` invocation and one command carry the requested software work through planning, implementation, tests, review, handoff, and report. Do not require a separate agent setup step for an attending chat.
- **Inspectable history:** every run records stage artifacts, visible progress, tool and check events, decisions, approvals, reviews, handoffs, and a terminal report or a visible report error. Preserve these after the chat ends. Record decision and evidence summaries where a host cannot expose a transcript; never claim to capture private reasoning.
- **Portable execution:** the current chat owns host stages by default, including under an unfamiliar IDE. Use `current-chat` when its model catalog is unknown. External CLI workers run only when the operator explicitly selects a CLI runner. Keep host work sequential across the pool.

Apply these as acceptance criteria to every pipeline feature and repair.

## Workspace skill: `/orchestrate`

This repository ships a portable multi-agent pipeline declared in `.pipeline/skill.json`.
It runs: **Planner → Plan Approver → (optional Designer) → Coder (self-healing builder-checker loop) → Tester → Reviewer (or Review Panel) → Handoff → Reporter**, writing artifacts to `.pipeline/*.md` with a live dashboard whose URL is dynamically selected and saved to `.pipeline/ui.url` to prevent port drift. The Plan Approver is the default approval gate: it records a verdict in `plan_review.md`, requests Planner revisions automatically, and asks for a human decision only on a blocked plan or exhausted revisions. `--approve-plan` adds an explicit human gate. Handoff and Reporter are mandatory — every run that reaches an `APPROVED` verdict always produces both, with no flag to disable either.

Use it only when the user **explicitly** asks for it — they type `/orchestrate`, or clearly ask to "orchestrate this", "run the pipeline", "use the multi-agent pipeline", or similar. Do NOT infer an implicit request from an ordinary "build this feature" / "fix this bug" / "refactor this" ask; do those directly. Never invoke it on your own initiative, and never as a way to hand off a task you were asked to do yourself.

When it has been explicitly requested:

1. Once a run IS active, do not plan and hand-edit the same files yourself alongside it — the run owns the working tree until it finishes or halts. This is a concurrency rule, not a mandate to route work through the pipeline.
2. Invoke: `bash .pipeline/orchestrate.sh "<user requirements>"` (flags: `--mode chat|cli`, `--host-client claude|cursor|codex|antigravity`, `--runner claude|cursor|codex|antigravity|host`, `--model-profile auto|manual`, `--models JSON`, `--approve-plan`, `--design`, `--review-panel`, `--sandbox`, `--allow-self`, `--max-cycles n`, `--max-post-tester-cycles n`, `--max-review-cycles n`, `--no-ui`).
3. **If YOU are a chat session** (any IDE): always invoke with `--mode chat --host-client <your-client>` (known or unfamiliar host name). Never pass `--runner`. Never spawn or delegate to another agent CLI — YOU complete each stage from `.pipeline/stage-handoff.json`, then run `--continue`.
4. **Before starting** (slash command / chat): use `--model-profile auto` by default. Ask for model IDs only when the user explicitly requests manual selection; then pass `--model-profile manual --models '...'`.
5. **Tell the user** to open the live dashboard URL from the script output or `.pipeline/ui.url` (always read this dynamically rather than hardcoding 4600, as the port drifts if occupied or in multi-repo setups) so they can follow stage progress.
6. **Chat mode**: complete each stage from `.pipeline/stage-handoff.json` in the IDE session. Honor `handoff.model` when that model is available in this environment; otherwise use your active chat model and record it as `"actualModel"` in `stage-handoff.json`. Then `bash .pipeline/orchestrate.sh --continue`.
7. **CLI mode**: wait for the orchestrator to finish.
8. Read `.pipeline/review_report.md` and present the audit verdict.
9. If the pipeline halts (`MAX_CYCLES`, `REGRESSION_BLOCKED`, `MISSING_ARTIFACT`, `AGENT_ERROR`), surface `.pipeline/checker_report.md` or `.pipeline/logs/` and ask the human how to proceed.

### Antigravity (IDE chat)

- Antigravity discovers the always-on rule at `.agent/rules/orchestrate.md` and the skill at `.agents/skills/orchestrate/SKILL.md` (registers `/orchestrate`).
- From an Antigravity chat, ALWAYS invoke with `--mode chat --host-client antigravity` and never delegate to an external agent CLI — this chat completes every stage. See `.agents/skills/orchestrate/SKILL.md` for the full loop.
- Auto model profiles adapt to the host client: Antigravity gets Gemini-family suggestions; unknown hosts get the `current-chat` sentinel (use your active chat model).

### Self-repo guard

- The pipeline refuses to run against the orchestrator SOURCE repository (exit code 3) — it must only target consumer projects. Maintainers can override with `--allow-self` or `ORCH_ALLOW_SELF=1`.

Install in other projects:

```bash
npx skills add isholaomotayo/orchestrator --skill orchestrate -a cursor -y --copy
bash .agents/skills/orchestrate/scripts/bootstrap.sh
```

## Workspace isolation rules (strict)

- Treat `.pipeline/` and `.pipeline_sandbox/` as READ-ONLY unless you ARE the pipeline orchestrator.
- Never auto-fix compilation errors or test failures observed inside `.pipeline_sandbox/` — the self-healing orchestrator owns them.
- PRE-FLIGHT CHECK: if `.pipeline/.lock` exists, a pipeline run is active. Do not start overlapping autonomous work; wait or inform the user.


## Roadmap (pool) mode — v2

**The attending chat owns host stages.** In single-run chat mode complete each stage from `stage-handoff.json` and run `--continue`. In roadmap mode, authenticated CLI workers run only when explicitly opted in. Everything else defaults to `runner: host`. Read `pool status --json` or `pool digest`, take `agentQueue.current`, run `bash .pipeline/orchestrate.sh pool claim <runId>`, complete that handoff, then `bash .pipeline/orchestrate.sh --continue --run-id <runId>`. Repeat without asking the user after each stage, until the queue is empty or a genuine human decision blocks progress. Respect an existing bridge owner or lease; do not compete for its handoff. Routine host work belongs in Agent queue, not Needs attention. If chat closes, queued work remains quiet until an attending chat resumes it.

**Self-invocation guard** — check before every invocation: read `.pipeline/status.json` and, when `.pipeline/control/` exists, `node pipeline/pool.mjs status --json`. If `overall` is `running`, `awaiting_chat`, or `awaiting_plan_approval`, or a supervisor pid in `.pipeline/control/supervisor.pid` is alive, work is already in flight — drain it (`/digest`) instead of starting anything. If `status.json` has a `pool` field, add work with `roadmap add`, never a fresh `--task`. `.pipeline/.lock` alone is NOT a reliable signal: chat handoffs release it while a run is still active.

**Workspace isolation.** Treat `.pipeline/`, `.pipeline_sandbox/` (legacy), `.pipeline/runs/`, `.pipeline/worktrees/` and `.pipeline/control/` as READ-ONLY unless you are completing an assigned stage. Never `cd` into or edit anything under `.pipeline/worktrees/<runId>` — a worker owns that tree. Change pool state only through `pool` verbs.

**Reading and steering a roadmap run:**

```
bash .pipeline/orchestrate.sh --roadmap .pipeline/roadmap.md   # compile and start
bash .pipeline/orchestrate.sh pool digest                      # decisions, agent queue and progress
bash .pipeline/orchestrate.sh pool claim <runId>               # pick up a run parked in chat
bash .pipeline/orchestrate.sh pool decide <id> "<answer>"      # answer a question
bash .pipeline/orchestrate.sh pool approve-merge <featureId>   # only after the human says so
```

Merging is the one irreversible step: never approve a merge the human has not
explicitly agreed to, even when a review is APPROVED.

**Third-party skills** are declared in `.pipeline/config.json` and pinned by
hash. A skill whose bytes changed is refused for that run and reported — pin it
again with `node pipeline/skills.mjs pin <name>` only after reviewing the change.
