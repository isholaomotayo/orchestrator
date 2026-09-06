# Agent Instructions (Codex / Antigravity / any AGENTS.md-aware CLI)

## Workspace skill: `/orchestrate`

This repository ships a portable multi-agent pipeline declared in `.pipeline/skill.json`.
It runs: **Planner → (optional Designer) → Coder (self-healing builder-checker loop) → Tester → Reviewer (or Review Panel) → (optional Handoff)**, writing artifacts to `.pipeline/*.md` with a live dashboard whose URL is dynamically selected and saved to `.pipeline/ui.url` to prevent port drift.

Use it only when the user **explicitly** asks for it — they type `/orchestrate`, or clearly ask to "orchestrate this", "run the pipeline", "use the multi-agent pipeline", or similar. Do NOT infer an implicit request from an ordinary "build this feature" / "fix this bug" / "refactor this" ask; do those directly. Never invoke it on your own initiative, and never as a way to hand off a task you were asked to do yourself.

When it has been explicitly requested:

1. Once a run IS active, do not plan and hand-edit the same files yourself alongside it — the run owns the working tree until it finishes or halts. This is a concurrency rule, not a mandate to route work through the pipeline.
2. Invoke: `bash .pipeline/orchestrate.sh "<user requirements>"` (flags: `--mode chat|cli`, `--host-client claude|cursor|codex|gemini|antigravity`, `--runner claude|cursor|codex|gemini|host`, `--model-profile auto|manual`, `--models JSON`, `--approve-plan`, `--design`, `--handoff`, `--review-panel`, `--sandbox`, `--allow-self`, `--max-cycles n`, `--max-post-tester-cycles n`, `--max-review-cycles n`, `--no-ui`).
3. **If YOU are a chat session** (any IDE): always invoke with `--mode chat --host-client <your-client>` (claude, cursor, codex, gemini, antigravity). Never pass `--runner`. Never spawn or delegate to another agent CLI — YOU complete each stage from `.pipeline/stage-handoff.json`, then run `--continue`.
4. **Before starting** (slash command / chat): ask the user whether to use automatic cost-optimized per-stage models or manual model selection. This is the only pre-run question. Then pass `--model-profile auto` or `--model-profile manual --models '...'`.
5. **Tell the user** to open the live dashboard URL from the script output or `.pipeline/ui.url` (always read this dynamically rather than hardcoding 4600, as the port drifts if occupied or in multi-repo setups) so they can follow stage progress.
6. **Chat mode**: complete each stage from `.pipeline/stage-handoff.json` in the IDE session. Honor `handoff.model` when that model is available in this environment; otherwise use your active chat model and record it as `"actualModel"` in `stage-handoff.json`. Then `bash .pipeline/orchestrate.sh --continue`.
7. **CLI mode**: wait for the orchestrator to finish.
8. Read `.pipeline/review_report.md` and present the audit verdict.
9. If the pipeline halts (`MAX_CYCLES`, `REGRESSION_BLOCKED`, `MISSING_ARTIFACT`, `AGENT_ERROR`), surface `.pipeline/checker_report.md` or `.pipeline/logs/` and ask the human how to proceed.

### Antigravity (IDE chat)

- Antigravity discovers the workflow at `.agents/workflows/orchestrate.md` (registers `/orchestrate`), the always-on rule at `.agent/rules/orchestrate.md`, and the skill at `.agents/skills/orchestrate/SKILL.md`.
- From an Antigravity chat, ALWAYS invoke with `--mode chat --host-client antigravity` and never delegate to an external agent CLI — this chat completes every stage. See `.agents/workflows/orchestrate.md` for the full loop.
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

**The coordinator never does stage work and never spawns workers — except a `claim-run` item, which is an invitation to do exactly that.** In single-run chat mode YOU complete each stage from `stage-handoff.json` and run `--continue`. In roadmap (pool) mode the supervisor spawns a real OS process only for a feature/ticket whose resolved runner is an authenticated agent CLI — opt in per feature with roadmap.md's `- runner: claude|cursor|codex|gemini` bullet, for genuine unattended parallel automation. Everything else defaults to `runner: host`: no subprocess, no CLI auth needed anywhere. When `pool digest`/`pool attention` shows a `claim-run` item, run `bash .pipeline/orchestrate.sh pool claim <runId>`, complete that stage yourself exactly as in single-run mode, then `bash .pipeline/orchestrate.sh --continue --run-id <runId>`. Otherwise you do intake, answer decisions, and approve merges with `pool` verbs.

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
