---
name: execute-agent-pipeline
description: Runs a self-healing multi-agent pipeline (Planner → Coder fix loop → Tester → Reviewer) with a live dashboard. Use when building features, complex refactors, or multi-file changes that should be planned, implemented, tested, and reviewed autonomously. Triggers on requests to delegate implementation, run the agent pipeline, or use spawn.sh.
---

# Execute Agent Pipeline

Portable multi-agent workflow: **Planner → Coder (builder-checker loop) → Tester → Reviewer**, with artifacts in `.pipeline/` and a live dashboard at http://localhost:4600.

## Prerequisites

- Node.js ≥ 18
- At least one agent CLI on `PATH`: `claude`, `cursor-agent`, `codex`, or `gemini`
- Pipeline scaffold present in the target repo (`.pipeline/` + `pipeline/`). If missing, run [bootstrap](#bootstrap-into-a-new-project) first.

## When to use

Use this skill when the user asks to:

- Build a non-trivial feature or complex refactor
- Delegate implementation instead of editing many files manually
- Run the pipeline, orchestrator, or `spawn.sh`
- Get a reviewed, tested change with an audit verdict

Do **not** manually plan and edit many files when this skill applies — delegate to the pipeline.

## Bootstrap into a new project

`npx skills add` installs **agent instructions only**. Copy the pipeline scaffold into the target repo once:

```bash
# From the target project root — replace OWNER/REPO with the published orchestrator repo
git clone --depth 1 --filter=blob:none --sparse https://github.com/OWNER/REPO /tmp/agent-pipeline-scaffold
cd /tmp/agent-pipeline-scaffold
git sparse-checkout set .pipeline pipeline package.json
cd -

cp -R /tmp/agent-pipeline-scaffold/.pipeline .
cp -R /tmp/agent-pipeline-scaffold/pipeline .
# Merge scripts from package.json if needed: "ui", "pipeline", "test"
```

Or clone the full orchestrator repo as a starting template.

## Run the pipeline

```bash
bash .pipeline/spawn.sh "USER_REQUIREMENTS_HERE"
```

Optional flags:

| Flag | Purpose |
|------|---------|
| `--runner claude\|cursor\|codex\|gemini` | Force a specific agent CLI |
| `--sandbox` | Run in isolated git worktree (`.pipeline_sandbox/`) |
| `--max-cycles N` | Override Coder fix-loop budget |
| `--max-post-tester-cycles N` | Override post-Tester fix-loop budget |
| `--no-ui` | Skip auto-starting the dashboard |

Resume after `MAX_CYCLES` halt:

```bash
bash .pipeline/spawn.sh --resume --extend 5
```

Watch live progress: http://localhost:4600

## Agent workflow (strict)

1. **Pre-flight**: If `.pipeline/.lock` exists, a run is active — do not start overlapping work.
2. **Delegate**: Run `bash .pipeline/spawn.sh "<task>"` with appropriate flags.
3. **Wait**: Let the orchestrator finish (do not manually fix code while it runs).
4. **Report**: Read `.pipeline/review_report.md` and summarize the audit verdict.
5. **On halt**: Surface `.pipeline/checker_report.md` for `MAX_CYCLES`, `REGRESSION_BLOCKED`, or `MISSING_ARTIFACT` and ask the human how to proceed.

## Workspace isolation (strict)

Unless you **are** the pipeline orchestrator:

- Treat `.pipeline/` and `.pipeline_sandbox/` as **READ-ONLY**
- Never auto-fix errors inside `.pipeline_sandbox/` — the self-healing loop owns them
- Do not modify pipeline prompts, config, or orchestrator code during a normal feature request

## Artifacts

| File | Stage |
|------|-------|
| `.pipeline/specs.md` | Planner |
| `.pipeline/changes.md` | Coder |
| `.pipeline/checker_report.md` | Checker (between Coder cycles) |
| `.pipeline/test_suite.md` | Tester |
| `.pipeline/review_report.md` | Reviewer (final verdict) |
| `.pipeline/status.json` | Live state machine |

Reviewer verdicts: `APPROVED`, `REQUEST_CHANGES`, `BLOCK`, or `UNKNOWN`.

## Halt reasons

| Reason | Meaning | Action |
|--------|---------|--------|
| `MAX_CYCLES` | Fix loop exhausted | `--resume --extend N` or human intervention |
| `REGRESSION_BLOCKED` | Pass count dropped | Human must review — cannot auto-extend |
| `MISSING_ARTIFACT` | Stage produced empty output | Inspect logs in `.pipeline/logs/` |

## Configuration

Edit `.pipeline/config.json` for default runner, cycle limits, and check commands (`test`, `lint`, `typecheck`).

## Additional resources

- Full documentation: [reference.md](reference.md) in this skill directory
- Workspace manifest (Cursor rules integration): `.pipeline/skill.json` in the scaffold repo
