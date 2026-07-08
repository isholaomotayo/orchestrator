# /orchestrate

Delegate the user's request to the self-healing multi-agent pipeline (Planner → Coder → Tester → Reviewer).

## Instructions

1. **Pre-flight**: If `.pipeline/.lock` exists, a run is active — do not start overlapping work.
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
5. **Wait** for the orchestrator to finish. Live dashboard: http://localhost:4600
6. **Report**: Read `.pipeline/review_report.md` and summarize the audit verdict.
7. **On halt** (`MAX_CYCLES`, `REGRESSION_BLOCKED`, `MISSING_ARTIFACT`): surface `.pipeline/checker_report.md` and ask how to proceed.

## Isolation rules

- Treat `.pipeline/` and `.pipeline_sandbox/` as READ-ONLY unless you are the pipeline orchestrator.
- Never auto-fix errors inside `.pipeline_sandbox/`.
