# Claude Code Instructions

## Workspace skill: `/orchestrate`

This repository ships a portable multi-agent pipeline declared in `.pipeline/skill.json`.
It runs: **Planner → Coder (self-healing builder-checker loop) → Tester → Reviewer**, with a live dashboard at http://localhost:4600.

When the user invokes `/orchestrate`, or tasks you with building a feature, resolving complex requirements, or implementing multi-stage refactoring:

1. Do NOT plan and edit many files manually in a single run.
2. Invoke: `bash .pipeline/orchestrate.sh "<user requirements>"` (flags: `--runner claude|cursor|codex|gemini`, `--sandbox`, `--no-ui`).
3. Wait for the pipeline to exit, then read `.pipeline/review_report.md` and present the audit verdict.
4. If the pipeline halts (`MAX_CYCLES`, `REGRESSION_BLOCKED`, `MISSING_ARTIFACT`), surface `.pipeline/checker_report.md` and ask the human how to proceed.

## Workspace isolation (strict)

- Treat `.pipeline/` and `.pipeline_sandbox/` as READ-ONLY unless you are the pipeline orchestrator.
- Never auto-fix errors inside `.pipeline_sandbox/` — the self-healing orchestrator owns them.
- PRE-FLIGHT CHECK: if `.pipeline/.lock` exists, a pipeline run is active — do not start overlapping autonomous work.
