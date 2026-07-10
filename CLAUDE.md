# Claude Code Instructions

## Workspace skill: `/orchestrate`

This repository ships a portable multi-agent pipeline declared in `.pipeline/skill.json`.
It runs: **Planner → Coder (self-healing builder-checker loop) → Tester → Reviewer**, with a live dashboard whose URL is dynamically selected and saved to `.pipeline/ui.url` (usually starting at `http://localhost:4600`).

When the user invokes `/orchestrate`, or tasks you with building a feature, resolving complex requirements, or implementing multi-stage refactoring:

1. Do NOT plan and edit many files manually in a single run.
2. Invoke: `bash .pipeline/orchestrate.sh "<user requirements>"` (flags: `--mode chat|cli`, `--runner claude|cursor|codex|gemini|host`, `--model-profile auto|manual`, `--models JSON`, `--sandbox`, `--no-ui`).
3. **Before starting** (slash command / chat): ask whether to use automatic cost-optimized per-stage models or manual selection. This is the only pre-run question. Then pass `--model-profile auto` or `--model-profile manual --models '...'`.
4. **Chat mode**: complete each stage from `.pipeline/stage-handoff.json` in the IDE session (honor `handoff.model`), then `bash .pipeline/orchestrate.sh --continue`.
5. **CLI mode**: wait for the pipeline to exit.
6. Read `.pipeline/review_report.md` and present the audit verdict.
7. If the pipeline halts (`MAX_CYCLES`, `REGRESSION_BLOCKED`, `MISSING_ARTIFACT`, `AGENT_ERROR`), surface `.pipeline/checker_report.md` or logs and ask the human how to proceed.

## Workspace isolation (strict)

- Treat `.pipeline/` and `.pipeline_sandbox/` as READ-ONLY unless you are the pipeline orchestrator.
- Never auto-fix errors inside `.pipeline_sandbox/` — the self-healing orchestrator owns them.
- PRE-FLIGHT CHECK: if `.pipeline/.lock` exists, a pipeline run is active — do not start overlapping autonomous work.
