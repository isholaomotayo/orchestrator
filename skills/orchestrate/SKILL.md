---
name: orchestrate
description: Runs a self-healing multi-agent pipeline (Planner → Coder fix loop → Tester → Reviewer) with a live dashboard. Use when the user invokes /orchestrate, asks to orchestrate a feature, delegate implementation, or run the agent pipeline. Triggers on /orchestrate, orchestrate, or multi-file autonomous implementation requests.
disable-model-invocation: true
metadata:
  author: isholaomotayo
  repository: https://github.com/isholaomotayo/orchestrator
  slash_command: /orchestrate
---

# /orchestrate

Self-healing multi-agent workflow: **Planner → Coder (builder-checker loop) → Tester → Reviewer**, with artifacts in `.pipeline/` and a live dashboard at http://localhost:4600.

Source: [isholaomotayo/orchestrator](https://github.com/isholaomotayo/orchestrator)

## Install

```bash
npx skills add isholaomotayo/orchestrator --skill orchestrate -a cursor -y --copy
```

`npx skills add` installs agent instructions. Bootstrap the pipeline scaffold once per project (see below).

## When the user invokes `/orchestrate`

1. **Pre-flight**: If `.pipeline/.lock` exists, a run is active — do not start overlapping work.
2. **Bootstrap** if `.pipeline/orchestrate.sh` is missing:
   ```bash
   bash .agents/skills/orchestrate/scripts/bootstrap.sh
   ```
   Or from this repo's source tree:
   ```bash
   bash skills/orchestrate/scripts/bootstrap.sh
   ```
3. **Extract the task** from the user's message (text after `/orchestrate`).
4. **Run**:
   ```bash
   bash .pipeline/orchestrate.sh "TASK_HERE"
   ```
5. **Wait** for the orchestrator to finish (do not manually edit code during the run).
6. **Report**: Read `.pipeline/review_report.md` and summarize the audit verdict.
7. **On halt**: Surface `.pipeline/checker_report.md` for `MAX_CYCLES`, `REGRESSION_BLOCKED`, or `MISSING_ARTIFACT`.

## CLI flags

| Flag | Purpose |
|------|---------|
| `--runner claude\|cursor\|codex\|gemini` | Force a specific agent CLI |
| `--sandbox` | Run in isolated git worktree (`.pipeline_sandbox/`) |
| `--max-cycles N` | Override Coder fix-loop budget |
| `--max-post-tester-cycles N` | Override post-Tester fix-loop budget |
| `--no-ui` | Skip auto-starting the dashboard |

Resume after `MAX_CYCLES` halt:

```bash
bash .pipeline/orchestrate.sh --resume --extend 5
```

## Workspace isolation (strict)

Unless you **are** the pipeline orchestrator:

- Treat `.pipeline/` and `.pipeline_sandbox/` as **READ-ONLY**
- Never auto-fix errors inside `.pipeline_sandbox/`
- Do not modify pipeline prompts or orchestrator code during a normal feature request

## Artifacts

| File | Stage |
|------|-------|
| `.pipeline/specs.md` | Planner |
| `.pipeline/changes.md` | Coder |
| `.pipeline/checker_report.md` | Checker |
| `.pipeline/test_suite.md` | Tester |
| `.pipeline/review_report.md` | Reviewer (verdict) |

Reviewer verdicts: `APPROVED`, `REQUEST_CHANGES`, `BLOCK`, `UNKNOWN`.

## Additional resources

- [reference.md](reference.md) — install paths, halt codes, publishing
- `.pipeline/skill.json` — workspace manifest in the scaffold repo
