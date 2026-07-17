# Agent Instructions (Codex / Antigravity / any AGENTS.md-aware CLI)

## Workspace skill: `/orchestrate`

This repository ships a portable multi-agent pipeline declared in `.pipeline/skill.json`.
It runs: **Planner → Coder (self-healing builder-checker loop) → Tester → Reviewer**, writing artifacts to `.pipeline/*.md` with a live dashboard whose URL is dynamically selected and saved to `.pipeline/ui.url` to prevent port drift.

When the user invokes `/orchestrate`, or tasks you with building a feature, resolving complex requirements, or a multi-stage refactor:

1. Do NOT plan and edit many files manually in a single run.
2. Invoke: `bash .pipeline/orchestrate.sh "<user requirements>"` (flags: `--mode chat|cli`, `--host-client claude|cursor|codex|gemini|antigravity`, `--runner claude|cursor|codex|gemini|host`, `--model-profile auto|manual`, `--models JSON`, `--sandbox`, `--allow-self`, `--no-ui`).
3. **If YOU are a chat session** (any IDE): always invoke with `--mode chat --host-client <your-client>` (claude, cursor, codex, gemini, antigravity). Never pass `--runner`. Never spawn or delegate to another agent CLI — YOU complete each stage from `.pipeline/stage-handoff.json`, then run `--continue`.
4. **Before starting** (slash command / chat): ask the user whether to use automatic cost-optimized per-stage models or manual model selection. This is the only pre-run question. Then pass `--model-profile auto` or `--model-profile manual --models '...'`.
5. **Tell the user** to open the live dashboard URL from the script output or `.pipeline/ui.url` (always read this dynamically rather than hardcoding 4600, as the port drifts if occupied or in multi-repo setups) so they can follow stage progress.
6. **Chat mode**: complete each stage from `.pipeline/stage-handoff.json` in the IDE session. Honor `handoff.model` when that model is available in this environment; otherwise use your active chat model and record it as `"actualModel"` in `stage-handoff.json`. Then `bash .pipeline/orchestrate.sh --continue`.
7. **CLI mode**: wait for the orchestrator to finish.
8. Read `.pipeline/review_report.md` and present the audit verdict.
9. If the pipeline halts (`MAX_CYCLES`, `REGRESSION_BLOCKED`, `MISSING_ARTIFACT`, `AGENT_ERROR`), surface `.pipeline/checker_report.md` or `.pipeline/logs/` and ask the human how to proceed.

### Antigravity (IDE chat)

- Antigravity discovers the workflow at `.agents/workflows/orchestrate.md` (registers `/orchestrate`), the always-on rule at `.agent/rules/orchestrate.md`, and the skill at `.agents/skills/orchestrate/SKILL.md`.
- From an Antigravity chat, ALWAYS invoke with `--mode chat --host-client antigravity` and never delegate to an external agent CLI — this chat completes every stage. See `.agents/workflows/orchestrate.md` for the full loop.
- Auto model profiles adapt to the host client: Antigravity gets Gemini-family suggestions; unknown hosts get the `current-chat` sentinel (use your active chat model).

### Self-repo guard

- The pipeline refuses to run against the orchestrator SOURCE repository (exit code 3) — it must only target consumer projects. Maintainers can override with `--allow-self` or `ORCH_ALLOW_SELF=1`.

Install in other projects:

```bash
npx skills add isholaomotayo/orchestrator --skill orchestrate -a cursor -y --copy
bash .agents/skills/orchestrate/scripts/bootstrap.sh
```

## Workspace isolation rules (strict)

- Treat `.pipeline/` and `.pipeline_sandbox/` as READ-ONLY unless you ARE the pipeline orchestrator.
- Never auto-fix compilation errors or test failures observed inside `.pipeline_sandbox/` — the self-healing orchestrator owns them.
- PRE-FLIGHT CHECK: if `.pipeline/.lock` exists, a pipeline run is active. Do not start overlapping autonomous work; wait or inform the user.
