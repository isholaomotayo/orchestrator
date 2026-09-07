# /orchestrate

Delegate the user's request to the self-healing multi-agent pipeline (Planner → Coder → Tester → Reviewer).

## Chat mode vs CLI mode

- **Chat mode** (default when invoked from Cursor/IDE): the orchestrator uses **host** runner — you complete each stage in this chat session. Read `.pipeline/stage-handoff.json`, do the work, then run `bash .pipeline/orchestrate.sh --continue`. No `cursor-agent` login needed.
- **CLI mode** (terminal/CI): headless agent CLIs run subprocesses. Requires authenticated `claude`, `cursor-agent`, `codex`, or `agy` (Antigravity).

**You are a chat session**: always invoke with `--mode chat --host-client cursor`, never pass `--runner`, and never spawn or delegate to another agent CLI — YOU complete every stage. If the run exits with code 3, this is the orchestrator SOURCE repository — do not target it (maintainers only: `--allow-self` / `ORCH_ALLOW_SELF=1`).

## Instructions

1. **Pre-flight / self-invocation guard**: read `.pipeline/status.json`'s `overall` field. If it is `running`, `awaiting_chat`, or `awaiting_plan_approval`, a run is already active — do NOT invoke `bash .pipeline/orchestrate.sh` with a new task. `.pipeline/.lock` alone is not reliable: a chat-mode handoff releases the lock the instant control returns to this session, so it can be absent for the whole time a stage is being worked on while the run is still active. If `.pipeline/stage-handoff.json` exists, you are already inside an active run's stage — including when that stage is itself "build a feature" — so go straight to the **Chat handoff loop** (step 7) instead of starting a new one. Re-invoking here archives the in-progress run as if it had finished and silently starts a new one on top of it.
2. **Bootstrap** (if `.pipeline/orchestrate.sh` is missing):
   ```bash
   bash skills/orchestrate/scripts/bootstrap.sh
   ```
   If the skill was installed via `npx skills add`, use:
   ```bash
   bash .agents/skills/orchestrate/scripts/bootstrap.sh
   ```
3. **Extract the task** from the user's message (everything after `/orchestrate`).
4. **Model selection (required — do not start the pipeline until answered):** Ask the user:
   > Use automatic cost-optimized models per stage, or pick models manually for Planner / Coder / Tester / Reviewer?
   - **Automatic** → proceed with `--model-profile auto`
   - **Manual** → collect four model IDs in one follow-up, then use `--model-profile manual --models '{"planner":"...","coder":"...","tester":"...","reviewer":"..."}'`
   This is the **only** pre-run question. Do not ask anything else before starting.
5. **Run the pipeline**:
   ```bash
   bash .pipeline/orchestrate.sh "TASK_HERE" --mode chat --host-client cursor --model-profile auto
   ```
   Or with manual models:
   ```bash
   bash .pipeline/orchestrate.sh "TASK_HERE" --mode chat --host-client cursor --model-profile manual --models '{"planner":"opus-5","coder":"sonnet-5","tester":"sonnet-5","reviewer":"opus-5"}'
   ```
6. **Tell the user to open the dashboard** immediately after start:
   - Always read the URL dynamically from the script output (`Live dashboard: http://localhost:…`) or `.pipeline/ui.url`. Do not hardcode 4600 as the port drifts if it is already taken or if running multiple repositories.
   - Say something like: *"Open the live dashboard (URL in `.pipeline/ui.url`, e.g., **http://localhost:4600**) in your browser to follow pipeline progress while I complete each stage here."*
   - Do NOT manually run/restart `ui-server.mjs` from this chat session. The orchestrator script handles startup.
7. **Chat handoff loop** (while `.pipeline/stage-handoff.json` exists):
   - Read the handoff + stage prompt file.
   - If `handoff.model` is set, **switch to that model in Cursor** before completing the stage.
   - Complete the stage (write the required artifact). While doing so, periodically check `.pipeline/followups/<stage>.txt` — the dashboard's chat box writes live notes there for whichever stage is active, and the orchestrator process has already exited for this handoff so nothing else will pick them up. If it has content, apply it immediately and delete the file.
   - Run `bash .pipeline/orchestrate.sh --continue`
   - Repeat until done or halted.
8. **Report**: Read `.pipeline/review_report.md` and summarize the audit verdict.
9. **On halt**: see skill docs for `MAX_CYCLES`, `REGRESSION_BLOCKED`, `MISSING_ARTIFACT`, `AGENT_ERROR`.

## Isolation rules

- Treat `.pipeline/` and `.pipeline_sandbox/` as READ-ONLY unless you are completing a chat handoff stage.
- Never auto-fix errors inside `.pipeline_sandbox/`.


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
