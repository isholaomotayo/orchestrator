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
   - Complete the stage in THIS chat (write the required artifact), then run:
     ```bash
     bash .pipeline/orchestrate.sh --continue
     ```
   - Repeat until the pipeline completes or halts.
6. **Report** — read `.pipeline/review_report.md` and present the audit verdict.
7. **On halt** (`MAX_CYCLES`, `REGRESSION_BLOCKED`, `MISSING_ARTIFACT`, `AGENT_ERROR`) — read `.pipeline/handoff.md` first, then surface `.pipeline/checker_report.md` or `.pipeline/logs/` and ask the human how to proceed.

## Isolation

- Treat `.pipeline/` and `.pipeline_sandbox/` as read-only outside an active chat handoff.
- If `.pipeline/.lock` exists, a run is active — do not start overlapping work.
