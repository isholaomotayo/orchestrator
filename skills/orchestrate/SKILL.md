---
name: orchestrate
description: Runs a self-healing multi-agent pipeline (Planner → optional Designer → Coder fix loop → Tester → Reviewer → optional Handoff) with an optional plan-approval gate and a live dashboard. Use when the user invokes /orchestrate, asks to orchestrate a feature, delegate implementation, or run the agent pipeline. Triggers on /orchestrate, orchestrate, or multi-file autonomous implementation requests.
when_to_use: Trigger on phrases like "orchestrate this", "run the pipeline", "delegate this to agents", "build this autonomously", "use the multi-agent pipeline", or when the user provides a task after /orchestrate.
argument-hint: "[task] [--model-profile auto|manual] [--mode chat|cli] [--host-client <name>] [--runner claude|cursor|codex|gemini] [--approve-plan] [--design] [--handoff] [--allow-self]"
arguments:
  - task
  - model-profile
  - mode
  - runner
disable-model-invocation: true
allowed-tools: Bash(bash .pipeline/orchestrate.sh *) Bash(bash skills/orchestrate/scripts/bootstrap.sh *) Bash(bash .agents/skills/orchestrate/scripts/bootstrap.sh *) Bash(cat .pipeline/*) Bash(cat .pipeline/ui.url) Bash(lsof *) Read
---

# Orchestrate

Self-healing multi-agent workflow: **Planner → (optional Designer) → Coder (builder-checker loop) → Tester → Reviewer → (optional Handoff)**, with artifacts saved to `.pipeline/*.md` and a live dashboard whose URL is dynamically selected and saved to `.pipeline/ui.url` to prevent port drift.

## Current environment

!`[ -f .pipeline/.lock ] && cat .pipeline/.lock || echo "No active pipeline run"`

!`[ -f .pipeline/ui.url ] && echo "Dashboard: $(cat .pipeline/ui.url)" || echo "Dashboard: not yet started"`

## Instructions

### 1. Parse Arguments

If the user invoked this skill with arguments, extract them:
- **`$task`** — The feature or task description to implement (e.g. "implement JWT auth")
- **`$model-profile`** — `auto` or `manual` (if not provided, ask)
- **`$mode`** — `chat` or `cli` override (optional; auto-detected from environment)
- **`$runner`** — `claude`, `cursor`, `codex`, `gemini`, or `host` (optional)

If `$task` was not provided as an argument, extract it from the user's message (text after `/orchestrate`).

**You are a chat session.** Always invoke with `--mode chat --host-client <your-client>` (`claude`, `cursor`, `codex`, `gemini`, or `antigravity`). Never pass `--runner`. Never spawn or delegate to another agent CLI — YOU complete each stage from `.pipeline/stage-handoff.json`, then run `--continue`.

### 2. Pre-flight Check

Before running anything:
- If the environment above shows an active lock file with status **not** `awaiting_chat`, stop and inform the user a pipeline run is active.
- If `.pipeline/orchestrate.sh` is missing, bootstrap the scaffold:
  ```bash
  bash .agents/skills/orchestrate/scripts/bootstrap.sh
  ```
- **Self-repo guard**: the pipeline exits with code 3 if the target is the orchestrator SOURCE repository (it must only run against consumer projects). Do not override on your own; maintainers can pass `--allow-self` or set `ORCH_ALLOW_SELF=1`.

### 3. Model Selection (Required Before Start)

If `$model-profile` was **not** passed as an argument, ask exactly this question before proceeding:

> **Which model profile would you like to use?**
> - **`auto`** — Cost-optimized per stage (recommended). Planner gets a high-tier model, Coder/Tester/Reviewer get mid-tier.
> - **`manual`** — You pick a model for each stage: Planner, Coder, Tester, Reviewer.

This is the **only** pre-run question. Do not ask about mode, runner, or other flags unless the user brings them up.

- **Automatic**: run with `--model-profile auto`
- **Manual**: collect four model names from the user, then build `--model-profile manual --models '{"planner":"...","coder":"...","tester":"...","reviewer":"..."}'`

### 4. Execute the Pipeline

Assemble the command from what was gathered:

```bash
bash .pipeline/orchestrate.sh "$task" \
  --mode chat --host-client <your-client> \
  --model-profile auto \
  [--approve-plan] [--design] [--handoff]
```

- **Chat Mode** (you, an IDE session — the default driver): You complete each stage in the handoff loop. The orchestrator updates `.pipeline/stage-handoff.json` and waits for `bash .pipeline/orchestrate.sh --continue`. `--host-client` attributes the run to your IDE (dashboard, logs) and adapts suggested models to your environment (e.g. Gemini-family in Antigravity, `current-chat` when unknown).
- **CLI Mode** (headless terminal/CI only — never from a chat): Sub-processes run autonomously. Wait for the script to exit.

### 5. Share the Dashboard URL

As soon as the pipeline starts, tell the user to open the live dashboard. **Never hardcode `http://localhost:4600`** — read the URL dynamically:

```bash
cat .pipeline/ui.url
```

Example message: *"Pipeline started! Open the live dashboard (URL in `.pipeline/ui.url`) to watch stage progress, checker results, and artifacts."*

### 6. Chat Handoff Loop

When `.pipeline/stage-handoff.json` is present and status is `awaiting_chat`:

1. Read the handoff file and its referenced prompt.
2. If `handoff.model` specifies a model available in this environment, switch to it; otherwise (or when the model is `current-chat`) use your active chat model.
3. Work on the assigned pipeline stage in this session (specs, design, code, tests, or review). Never spawn or delegate to another agent CLI (`handoff.hostNote` reiterates this when set).
4. Set `"actualModel": "your model name"` in `stage-handoff.json`.
5. Resume:
   ```bash
   bash .pipeline/orchestrate.sh --continue
   ```
6. Repeat until the pipeline finishes or halts.

When status is `awaiting_plan_approval` (only when `--approve-plan` is set): present `.pipeline/specs.md` to the user and ask them to approve or request revisions. To request a revision, queue a note in `.pipeline/followups/planner.txt` before resuming. Either way, resume with `bash .pipeline/orchestrate.sh --continue`.

### 7. Post-Run Audit

Once the pipeline exits, read `.pipeline/review_report.md` and report the verdict: `APPROVED`, `REQUEST_CHANGES`, `BLOCK`, or `UNKNOWN`.

### 8. On Halt

| Halt Code | Action |
|-----------|--------|
| `MAX_CYCLES` | Surface `.pipeline/checker_report.md`, suggest `bash .pipeline/orchestrate.sh --resume --extend 5` |
| `REGRESSION_BLOCKED` | Surface `.pipeline/checker_report.md`, human review required |
| `MISSING_ARTIFACT` | Inspect `.pipeline/logs/planner.log` — often a CLI auth failure in CLI mode |
| `AGENT_ERROR` | CLI auth/spawn failure — suggest `--mode chat` from IDE or log in to the CLI tool |

### 9. Workspace Isolation

- Treat `.pipeline/` and `.pipeline_sandbox/` as **read-only** unless completing an active chat handoff.
- Never manually fix errors inside `.pipeline_sandbox/`; the self-healing coder loop handles them.

## Examples

### Example 1: Full invocation with arguments

```
/orchestrate implement JWT authentication middleware --model-profile auto
```

→ Task is `implement JWT authentication middleware`, model profile is `auto`. Skip the model selection question and proceed directly to execution.

### Example 2: Plain invocation (conversational)

```
/orchestrate
```

→ Ask the user for the task description and model profile before proceeding.

### Example 3: Manual model selection

*User chooses manual profile.*
*Agent collects:* Planner = `opus-4.8`, Coder = `sonnet-5`, Tester = `sonnet-5`, Reviewer = `sonnet-5`.
*Agent runs:*
```bash
bash .pipeline/orchestrate.sh "task" \
  --model-profile manual \
  --models '{"planner":"opus-4.8","coder":"sonnet-5","tester":"sonnet-5","reviewer":"sonnet-5"}'
```

### Example 4: Resuming a halted pipeline

```
/orchestrate --resume
```

→ Detect no task was given, check `.pipeline/.lock` state, and run:
```bash
bash .pipeline/orchestrate.sh --resume --extend 5
```

## Resources

- [REFERENCE.md](REFERENCE.md) — CLI flags, model profiles, available models, halt codes, and installation options.
