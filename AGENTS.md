# Agent Instructions (Codex / Antigravity / any AGENTS.md-aware CLI)

## Workspace skill: `/orchestrate`

This repository ships a portable multi-agent pipeline declared in `.pipeline/skill.json`.
It runs: **Planner → Coder (self-healing builder-checker loop) → Tester → Reviewer**, writing artifacts to `.pipeline/*.md` with a live dashboard at http://localhost:4600.

When the user invokes `/orchestrate`, or tasks you with building a feature, resolving complex requirements, or a multi-stage refactor:

1. Do NOT plan and edit many files manually in a single run.
2. Invoke: `bash .pipeline/orchestrate.sh "<user requirements>"` (flags: `--mode chat|cli`, `--runner claude|cursor|codex|gemini|host`, `--sandbox`, `--no-ui`).
3. **Chat mode** (auto-detected in IDE): when `.pipeline/stage-handoff.json` exists, complete that stage in chat, then `bash .pipeline/orchestrate.sh --continue` — repeat until done.
4. **CLI mode** (terminal): wait for the orchestrator to finish.
5. Read `.pipeline/review_report.md` and present the audit verdict.
6. If the pipeline halts (`MAX_CYCLES`, `REGRESSION_BLOCKED`, `MISSING_ARTIFACT`, `AGENT_ERROR`), surface `.pipeline/checker_report.md` or `.pipeline/logs/` and ask the human how to proceed.

Install in other projects:

```bash
npx skills add isholaomotayo/orchestrator --skill orchestrate -a cursor -y --copy
bash .agents/skills/orchestrate/scripts/bootstrap.sh
```

## Workspace isolation rules (strict)

- Treat `.pipeline/` and `.pipeline_sandbox/` as READ-ONLY unless you ARE the pipeline orchestrator.
- Never auto-fix compilation errors or test failures observed inside `.pipeline_sandbox/` — the self-healing orchestrator owns them.
- PRE-FLIGHT CHECK: if `.pipeline/.lock` exists, a pipeline run is active. Do not start overlapping autonomous work; wait or inform the user.
