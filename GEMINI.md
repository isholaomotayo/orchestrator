# Antigravity / Gemini Instructions

Google Antigravity (the `agy` CLI and IDE) still reads this file. The Gemini CLI has been deprecated; use `--host-client antigravity` and runner `antigravity`.

This repository ships `/orchestrate` — a portable multi-agent pipeline declared in `.pipeline/skill.json` (Planner → optional Designer → Coder self-healing loop → Tester → Reviewer or Review Panel → optional Handoff, with a live dashboard whose URL is dynamically selected and saved to `.pipeline/ui.url` to prevent port drift).

Use it only when the user **explicitly** asks for it (`/orchestrate`, "orchestrate this", "run the pipeline", "use the multi-agent pipeline"). Do NOT infer an implicit request from an ordinary "build this feature" / "fix this bug" / "refactor this" ask — do those directly. Never self-invoke, and never use it to hand off a task you were asked to do yourself.

## When `/orchestrate` was explicitly requested:

1. **Pre-flight**: if `.pipeline/.lock` exists, a pipeline run is active — do not start overlapping autonomous work.
2. **Model selection (required before starting)**: Ask the user:
   > Use automatic cost-optimized models per stage, or pick models manually for Planner / Coder / Tester / Reviewer?
   - **Automatic** → pass `--model-profile auto`
   - **Manual** → collect four model IDs, then pass `--model-profile manual --models '{"planner":"...","coder":"...","tester":"...","reviewer":"..."}'`
   This is the **only** pre-run question.
3. **Invoke** (you are a chat session — always pass `--mode chat --host-client antigravity`; never pass `--runner` and never delegate stages to another agent CLI; exit code 3 means this is the orchestrator SOURCE repo, which must not be targeted):
   ```bash
   bash .pipeline/orchestrate.sh "<user requirements>" --mode chat --host-client antigravity --model-profile auto
   ```
   Additional optional flags: `--approve-plan`, `--design`, `--handoff`, `--review-panel`, `--sandbox`, `--allow-self`, `--max-cycles n`, `--max-post-tester-cycles n`, `--max-review-cycles n`.
4. **Tell the user** to open the live dashboard URL from `.pipeline/ui.url` (do not hardcode 4600).
5. When it exits, read `.pipeline/review_report.md` and report the verdict.

## Isolation rules

- Treat `.pipeline/` and `.pipeline_sandbox/` as READ-ONLY unless you are the pipeline orchestrator.
- If `.pipeline/.lock` exists, a pipeline run is active — do not start overlapping autonomous work.
- Do not auto-fix errors seen inside `.pipeline_sandbox/`; the self-healing orchestrator manages them.


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
