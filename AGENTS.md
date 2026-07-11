# Agent Instructions (Codex / Antigravity / any AGENTS.md-aware CLI)

## Workspace skill: `/orchestrate`

This repository ships a portable multi-agent pipeline declared in `.pipeline/skill.json`.
It runs: **Planner → Coder (self-healing builder-checker loop) → Tester → Reviewer**, writing artifacts to `.pipeline/*.md` with a live dashboard whose URL is dynamically selected and saved to `.pipeline/ui.url` to prevent port drift.

When the user invokes `/orchestrate`, or tasks you with building a feature, resolving complex requirements, or a multi-stage refactor:

1. Do NOT plan and edit many files manually in a single run.
2. Invoke: `bash .pipeline/orchestrate.sh "<user requirements>"` (flags: `--mode chat|cli`, `--runner claude|cursor|codex|gemini|host`, `--model-profile auto|manual`, `--models JSON`, `--sandbox`, `--no-ui`).
3. **Before starting** (slash command / chat): ask the user whether to use automatic cost-optimized per-stage models or manual model selection. This is the only pre-run question. Then pass `--model-profile auto` or `--model-profile manual --models '...'`.
4. **Tell the user** to open the live dashboard URL from the script output or `.pipeline/ui.url` (always read this dynamically rather than hardcoding 4600, as the port drifts if occupied or in multi-repo setups) so they can follow stage progress.
5. **Chat mode**: complete each stage from `.pipeline/stage-handoff.json` in the IDE session (honor `handoff.model` — switch model before each stage), then `bash .pipeline/orchestrate.sh --continue`.
6. **CLI mode**: wait for the orchestrator to finish.
7. Read `.pipeline/review_report.md` and present the audit verdict.
8. If the pipeline halts (`MAX_CYCLES`, `REGRESSION_BLOCKED`, `MISSING_ARTIFACT`, `AGENT_ERROR`), surface `.pipeline/checker_report.md` or `.pipeline/logs/` and ask the human how to proceed.

Install in other projects:

```bash
npx skills add isholaomotayo/orchestrator --skill orchestrate -a cursor -y --copy
bash .agents/skills/orchestrate/scripts/bootstrap.sh
```

## Workspace isolation rules (strict)

- Treat `.pipeline/` and `.pipeline_sandbox/` as READ-ONLY unless you ARE the pipeline orchestrator.
- Never auto-fix compilation errors or test failures observed inside `.pipeline_sandbox/` — the self-healing orchestrator owns them.
- PRE-FLIGHT CHECK: if `.pipeline/.lock` exists, a pipeline run is active. Do not start overlapping autonomous work; wait or inform the user.
