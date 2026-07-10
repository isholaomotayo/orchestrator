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

Self-healing multi-agent workflow: **Planner → Coder (builder-checker loop) → Tester → Reviewer**, with artifacts in `.pipeline/` and a live dashboard (port is dynamically selected starting at 4600 and saved to `.pipeline/ui.url` to prevent port drift).

Source: [isholaomotayo/orchestrator](https://github.com/isholaomotayo/orchestrator)

## Chat mode vs CLI mode

The pipeline auto-detects how it was invoked:

| Mode | When | How agent stages run |
|------|------|----------------------|
| **Chat** | `/orchestrate` from Cursor, Claude Code, or other IDE chat (`CURSOR_AGENT=1`, etc.) | **You** (the chat agent) complete each stage. The orchestrator hands off via `.pipeline/stage-handoff.json` and waits for `--continue`. No separate `cursor-agent` / CLI login required. |
| **CLI** | `bash .pipeline/orchestrate.sh` from a terminal, or CI | Headless subprocesses (`claude`, `cursor-agent`, `codex`, `gemini`). Requires the chosen CLI to be **authenticated**. Auto-picks the first logged-in CLI on PATH. |

Override: `--mode chat` or `--mode cli`. Force a CLI runner: `--runner claude` (even from chat).

## When the user invokes `/orchestrate`

1. **Pre-flight**: If `.pipeline/.lock` exists and status is not `awaiting_chat`, a run is active — do not start overlapping work.
2. **Bootstrap** if `.pipeline/orchestrate.sh` is missing:
   ```bash
   bash .agents/skills/orchestrate/scripts/bootstrap.sh
   ```
   Or from this repo's source tree:
   ```bash
   bash skills/orchestrate/scripts/bootstrap.sh
   ```
3. **Extract the task** from the user's message (text after `/orchestrate`).
4. **Model selection (required before starting):** Ask:
   > Use automatic cost-optimized models per stage, or pick models manually for Planner / Coder / Tester / Reviewer?
   - **Automatic** → `--model-profile auto`
   - **Manual** → collect four model IDs, then `--model-profile manual --models '{"planner":"...","coder":"...","tester":"...","reviewer":"..."}'`
   This is the **only** pre-run user question for an autonomous builder run.
5. **Start the pipeline**:
   ```bash
   bash .pipeline/orchestrate.sh "TASK_HERE" --model-profile auto
   ```
6. **Tell the user to open the dashboard** as soon as the command starts (do not skip):
   - Always read the URL dynamically from the script output (`Live dashboard: http://localhost:…`) or `.pipeline/ui.url`. Do not hardcode `http://localhost:4600` since the port drifts dynamically when running multiple repos or if the port is busy.
   - Example message: *"Pipeline started. Open the dashboard (URL is in `.pipeline/ui.url`, e.g., **http://localhost:4600**) in your browser to watch stage progress, checker results, and artifacts while I work each stage in chat."*
   - Do **NOT** manually start or restart `ui-server.mjs` from the chat. The orchestrator shell script manages UI startup. If the dashboard is unavailable, inspect `.pipeline/ui-server.pid`, `.pipeline/ui-server.out`, and check for listening ports using `lsof -nP -iTCP:4600-4620 -sTCP:LISTEN`.
7. **Chat mode loop** (when `.pipeline/stage-handoff.json` exists or status is `awaiting_chat`):
   - Read `.pipeline/stage-handoff.json` and the referenced `promptFile`.
   - If `handoff.model` is set, switch to that model in the IDE before working the stage.
   - Complete that pipeline stage **in this chat session** (write the required `artifact`, follow the stage prompt).
   - For **Reviewer**: read-only audit — only write `.pipeline/review_report.md`.
   - Update `.pipeline/stage-handoff.json` to add the `"actualModel": "model name"` field (e.g. `"actualModel": "Gemini 3.5 Flash"`) to report the model you used.
   - Run: `bash .pipeline/orchestrate.sh --continue`
   - Repeat until the pipeline finishes or halts.
7. **CLI mode**: wait for the orchestrator to finish (no handoff loop).
8. **Report**: Read `.pipeline/review_report.md` and summarize the audit verdict.
9. **On halt**:
   - `MAX_CYCLES` / `REGRESSION_BLOCKED`: surface `.pipeline/checker_report.md`
   - `MISSING_ARTIFACT` at Planner: inspect `.pipeline/logs/planner.log` (often CLI auth failure in CLI mode)
   - `AGENT_ERROR`: CLI auth or spawn failure — suggest `--mode chat` from IDE or log in to the CLI

## CLI flags

| Flag | Purpose |
|------|---------|
| `--model-profile auto\|manual` | Auto = cost-optimized per-stage defaults; manual requires `--models` |
| `--models '{"planner":"...","coder":"...","tester":"...","reviewer":"..."}'` | Manual model map (JSON) |
| `--mode chat\|cli` | Override auto-detected invocation mode |
| `--runner claude\|cursor\|codex\|gemini\|host` | Force a specific agent backend (`host` = IDE chat handoffs) |
| `--continue` | Resume after completing a chat handoff stage |
| `--sandbox` | Run in isolated git worktree (`.pipeline_sandbox/`) |
| `--max-cycles N` | Override Coder fix-loop budget |
| `--max-post-tester-cycles N` | Override post-Tester fix-loop budget |
| `--no-ui` | Skip auto-starting the dashboard |

Resume after `MAX_CYCLES` halt:

```bash
bash .pipeline/orchestrate.sh --resume --extend 5
```

## Workspace isolation (strict)

Unless you **are** the pipeline orchestrator completing a chat handoff:

- Treat `.pipeline/` and `.pipeline_sandbox/` as **READ-ONLY**
- Never auto-fix errors inside `.pipeline_sandbox/`
- Do not modify pipeline prompts or orchestrator code during a normal feature request

## Artifacts

| File | Stage |
|------|-------|
| `.pipeline/stage-handoff.json` | Chat handoff brief (chat mode only) |
| `.pipeline/specs.md` | Planner |
| `.pipeline/changes.md` | Coder |
| `.pipeline/checker_report.md` | Checker |
| `.pipeline/test_suite.md` | Tester |
| `.pipeline/review_report.md` | Reviewer (verdict) |

Reviewer verdicts: `APPROVED`, `REQUEST_CHANGES`, `BLOCK`, `UNKNOWN`.

## Additional resources

- [reference.md](reference.md) — install paths, halt codes, publishing
- `.pipeline/skill.json` — workspace manifest in the scaffold repo
