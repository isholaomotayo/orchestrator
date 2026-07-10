# /orchestrate

Delegate the user's request to the self-healing multi-agent pipeline (Planner → Coder → Tester → Reviewer).

## Chat mode vs CLI mode

- **Chat mode** (default when invoked from Cursor/IDE): the orchestrator uses **host** runner — you complete each stage in this chat session. Read `.pipeline/stage-handoff.json`, do the work, then run `bash .pipeline/orchestrate.sh --continue`. No `cursor-agent` login needed.
- **CLI mode** (terminal/CI): headless agent CLIs run subprocesses. Requires authenticated `claude`, `cursor-agent`, `codex`, or `gemini`.

## Instructions

1. **Pre-flight**: If `.pipeline/.lock` exists and status is not `awaiting_chat`, a run is active — do not start overlapping work.
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
   bash .pipeline/orchestrate.sh "TASK_HERE" --model-profile auto
   ```
   Or with manual models:
   ```bash
   bash .pipeline/orchestrate.sh "TASK_HERE" --model-profile manual --models '{"planner":"opus-4.8","coder":"sonnet-5","tester":"sonnet-5","reviewer":"sonnet-5"}'
   ```
6. **Tell the user to open the dashboard** immediately after start:
   - URL is in the command output (`Live dashboard: http://localhost:…`) or `.pipeline/ui.url`.
   - Say something like: *"Open **http://localhost:4600** in your browser to follow pipeline progress while I complete each stage here."*
   - Use the actual port from the run if it is not 4600.
7. **Chat handoff loop** (while `.pipeline/stage-handoff.json` exists):
   - Read the handoff + stage prompt file.
   - If `handoff.model` is set, **switch to that model in Cursor** before completing the stage.
   - Complete the stage (write the required artifact).
   - Run `bash .pipeline/orchestrate.sh --continue`
   - Repeat until done or halted.
8. **Report**: Read `.pipeline/review_report.md` and summarize the audit verdict.
9. **On halt**: see skill docs for `MAX_CYCLES`, `REGRESSION_BLOCKED`, `MISSING_ARTIFACT`, `AGENT_ERROR`.

## Isolation rules

- Treat `.pipeline/` and `.pipeline_sandbox/` as READ-ONLY unless you are completing a chat handoff stage.
- Never auto-fix errors inside `.pipeline_sandbox/`.
