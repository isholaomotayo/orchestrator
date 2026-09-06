# Orchestrator pipeline rules (Antigravity)

Always-on rules for any Antigravity chat session working in a repository that contains the `/orchestrate` pipeline (`.pipeline/orchestrate.sh`).

- Any pipeline invocation from this chat MUST include `--mode chat --host-client antigravity`. You (this chat session) are the driver for every stage.
- **Self-invocation guard, check before every invocation, no exceptions**: read `.pipeline/status.json`'s `overall` field. If it is `running`, `awaiting_chat`, or `awaiting_plan_approval`, a run is already active — do NOT invoke `bash .pipeline/orchestrate.sh` with a new task. `.pipeline/.lock` is not reliable for this: a chat-mode handoff releases the lock the instant control returns to this session, so it can be absent for the whole time a stage is being worked on while the run is still active. If `.pipeline/stage-handoff.json` exists, you are already inside that run's active stage — including when the stage itself is "build a feature" — so just complete it and run `--continue` instead of starting a new run. Re-invoking here archives the in-progress run as if it had finished and silently starts a new one on top of it.
- NEVER delegate pipeline stages to an external agent CLI (`claude`, `cursor-agent`, `codex`, `gemini`) and never pass `--runner`. Complete each stage from `.pipeline/stage-handoff.json` in this chat, then run `bash .pipeline/orchestrate.sh --continue`.
- While completing a stage, periodically check `.pipeline/followups/<stage>.txt` — the dashboard's chat box queues live notes there for whichever stage is active, and the orchestrator process has already exited for this handoff so nothing else will pick them up. Apply anything found immediately, then delete the file.
- If `handoff.model` names a model that is not available in Antigravity, use your active chat model instead and record it as `"actualModel"` in `stage-handoff.json`.
- Treat `.pipeline/` and `.pipeline_sandbox/` as READ-ONLY outside an active chat handoff. Never auto-fix errors observed inside `.pipeline_sandbox/` — the self-healing orchestrator owns them.
- A pipeline run is active if `.pipeline/.lock` exists OR `status.json`'s `overall` is `running` / `awaiting_chat` / `awaiting_plan_approval` — do not start overlapping autonomous work (see the self-invocation guard above).
- If the pipeline refuses with exit code 3, the current repo is the orchestrator SOURCE repository — do not target it; install the pipeline into the consumer project instead (maintainers only: `--allow-self` / `ORCH_ALLOW_SELF=1`).


## Roadmap (pool) mode — v2

**The coordinator never does stage work and never spawns workers.** In single-run chat mode YOU complete each stage from `stage-handoff.json` and run `--continue`. In roadmap (pool) mode the supervisor spawns workers via `bash .pipeline/orchestrate.sh pool start`; you do intake, answer decisions, and approve merges with `pool` verbs.

**Self-invocation guard** — check before every invocation: read `.pipeline/status.json` and, when `.pipeline/control/` exists, `node pipeline/pool.mjs status --json`. If `overall` is `running`, `awaiting_chat`, or `awaiting_plan_approval`, or a supervisor pid in `.pipeline/control/supervisor.pid` is alive, work is already in flight — drain it (`/digest`) instead of starting anything. If `status.json` has a `pool` field, add work with `roadmap add`, never a fresh `--task`. `.pipeline/.lock` alone is NOT a reliable signal: chat handoffs release it while a run is still active.

**Workspace isolation.** Treat `.pipeline/`, `.pipeline_sandbox/` (legacy), `.pipeline/runs/`, `.pipeline/worktrees/` and `.pipeline/control/` as READ-ONLY unless you are completing an assigned stage. Never `cd` into or edit anything under `.pipeline/worktrees/<runId>` — a worker owns that tree. Change pool state only through `pool` verbs.

**Reading and steering a roadmap run:**

```
bash .pipeline/orchestrate.sh --roadmap .pipeline/roadmap.md   # compile and start
bash .pipeline/orchestrate.sh pool digest                      # four-section status
bash .pipeline/orchestrate.sh pool decide <id> "<answer>"      # answer a question
bash .pipeline/orchestrate.sh pool approve-merge <featureId>   # only after the human says so
```

Merging is the one irreversible step: never approve a merge the human has not
explicitly agreed to, even when a review is APPROVED.

**Third-party skills** are declared in `.pipeline/config.json` and pinned by
hash. A skill whose bytes changed is refused for that run and reported — pin it
again with `node pipeline/skills.mjs pin <name>` only after reviewing the change.
