---
name: orchestrate
description: Run the self-healing multi-agent pipeline (Planner → optional Designer → Coder loop → Tester → Reviewer → optional Handoff) from this Antigravity chat session.
---

# /orchestrate (Antigravity workflow)

You are an **Antigravity chat session**. When this workflow triggers, the pipeline must run in chat mode with THIS session as the driver.

## Hard rules

- Always invoke with `--mode chat --host-client antigravity`.
- **Never** pass `--runner`. **Never** spawn or delegate to another agent CLI (`claude`, `cursor-agent`, `codex`, `gemini`) — YOU complete every stage in this chat.
- If the run refuses with exit code 3, this is the orchestrator SOURCE repository — do not override; tell the user to install into their project instead (maintainers only: `--allow-self`).

## Steps

0. **Self-invocation guard (check first, no exceptions)** — read `.pipeline/status.json`'s `overall` field. If it is `running`, `awaiting_chat`, or `awaiting_plan_approval`, a run is already active — do NOT invoke `bash .pipeline/orchestrate.sh` with a new task. `.pipeline/.lock` is not reliable here: a chat-mode handoff releases the lock the instant control returns to this session, so it can be absent for the whole time a stage is being worked on while the run is still active. If `.pipeline/stage-handoff.json` exists, you are already inside that run's active stage — including when the stage itself is "build a feature" — so go straight to the **Chat handoff loop** (step 5) instead of starting a new one. Re-invoking here archives the in-progress run as if it had finished and silently starts a new one on top of it.
1. **Bootstrap** if `.pipeline/orchestrate.sh` is missing:
   ```bash
   bash .agents/skills/orchestrate/scripts/bootstrap.sh
   ```
2. **Model profile** — ask only this one pre-run question: automatic cost-optimized per-stage models (`--model-profile auto`) or manual selection (`--model-profile manual --models '{"planner":"...","coder":"...","tester":"...","reviewer":"..."}'`)?
3. **Run**:
   ```bash
   bash .pipeline/orchestrate.sh "<task>" --mode chat --host-client antigravity --model-profile auto
   ```
4. **Dashboard** — tell the user to open the live dashboard URL from `.pipeline/ui.url` (read it dynamically; never hardcode `http://localhost:4600`, the port drifts).
5. **Chat handoff loop** — while `.pipeline/stage-handoff.json` exists:
   - Read the handoff and its `promptFile`.
   - If `handoff.model` names a model available in Antigravity, use it; otherwise use your active chat model. Either way, record the model actually used as `"actualModel"` in `stage-handoff.json`.
   - Complete the stage in THIS chat (write the required artifact). While working, periodically check `.pipeline/followups/<stage>.txt` — the dashboard's chat box queues live notes there for whichever stage is active, and the orchestrator process has already exited for this handoff so nothing else will pick them up. Apply anything found immediately, then delete the file. Then run:
     ```bash
     bash .pipeline/orchestrate.sh --continue
     ```
   - Repeat until the pipeline completes or halts.
6. **Report** — read `.pipeline/review_report.md` and present the audit verdict.
7. **On halt** (`MAX_CYCLES`, `REGRESSION_BLOCKED`, `MISSING_ARTIFACT`, `AGENT_ERROR`) — read `.pipeline/handoff.md` first, then surface `.pipeline/checker_report.md` or `.pipeline/logs/` and ask the human how to proceed.

## Isolation

- Treat `.pipeline/` and `.pipeline_sandbox/` as read-only outside an active chat handoff.
- A run is active if `.pipeline/.lock` exists OR `.pipeline/status.json`'s `overall` is `running` / `awaiting_chat` / `awaiting_plan_approval` — do not start overlapping work (see the self-invocation guard above).
