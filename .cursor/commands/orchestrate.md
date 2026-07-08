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
4. **Run the pipeline**:
   ```bash
   bash .pipeline/orchestrate.sh "TASK_HERE"
   ```
5. **Chat handoff loop** (while `.pipeline/stage-handoff.json` exists):
   - Read the handoff + stage prompt file.
   - Complete the stage (write the required artifact).
   - Run `bash .pipeline/orchestrate.sh --continue`
   - Repeat until done or halted.
6. **Report**: Read `.pipeline/review_report.md` and summarize the audit verdict.
7. **On halt**: see skill docs for `MAX_CYCLES`, `REGRESSION_BLOCKED`, `MISSING_ARTIFACT`, `AGENT_ERROR`.

## Isolation rules

- Treat `.pipeline/` and `.pipeline_sandbox/` as READ-ONLY unless you are completing a chat handoff stage.
- Never auto-fix errors inside `.pipeline_sandbox/`.
