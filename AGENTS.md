# Agent Instructions (Codex / Antigravity / any AGENTS.md-aware CLI)

## Workspace skill: `execute_agent_pipeline`

This repository ships a portable multi-agent pipeline skill declared in `.pipeline/skill.json`.
It runs a unified flow: **Planner → Coder (self-healing builder-checker loop) → Tester → Reviewer**, writing every artifact to `.pipeline/*.md` and streaming live progress to a dashboard at http://localhost:4600.

When tasked with building a feature, resolving complex requirements, or a multi-stage refactor:

1. Do NOT plan and edit many files manually in a single run.
2. Invoke the skill: `bash .pipeline/spawn.sh "<user requirements>"` (optional flags: `--runner claude|cursor|codex|gemini`, `--sandbox`, `--no-ui`).
3. Wait for the pipeline to exit, then read `.pipeline/review_report.md` and present the audit verdict to the user.
4. If the pipeline halts (`MAX_CYCLES`, `REGRESSION_BLOCKED`, `MISSING_ARTIFACT`), surface `.pipeline/checker_report.md` and ask the human how to proceed.

## Workspace isolation rules (strict)

- Treat `.pipeline/` and `.pipeline_sandbox/` as READ-ONLY unless you ARE the pipeline orchestrator.
- Never auto-fix compilation errors or test failures observed inside `.pipeline_sandbox/` — the self-healing orchestrator owns them.
- PRE-FLIGHT CHECK: if `.pipeline/.lock` exists, a pipeline run is active. Do not start overlapping autonomous work; wait or inform the user.
