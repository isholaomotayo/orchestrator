# /orchestrate — Reference

Repository: https://github.com/isholaomotayo/orchestrator

## Architecture

```
Task → Planner → Coder ↔ Checker → Tester → Reviewer → Verdict
```

## Install via skills CLI

```bash
# List skills in the repo
npx skills add isholaomotayo/orchestrator --list

# Install for Cursor (project scope)
npx skills add isholaomotayo/orchestrator --skill orchestrate -a cursor -y --copy

# Install globally
npx skills add isholaomotayo/orchestrator --skill orchestrate -g -a cursor -y --copy
```

Use `--copy` for Cursor if symlinked skills are not discovered.

## Bootstrap scaffold into any project

```bash
bash .agents/skills/orchestrate/scripts/bootstrap.sh
# or
bash skills/orchestrate/scripts/bootstrap.sh
```

Copies `.pipeline/`, `pipeline/`, and merges `package.json` scripts from the GitHub repo.

## Direct CLI

```bash
bash .pipeline/orchestrate.sh "task description" [--runner ...] [--model-profile auto|manual] [--models JSON] [--sandbox]
bash .pipeline/orchestrate.sh --resume [--extend 5]
node pipeline/orchestrator.mjs --task "description" --model-profile auto
```

## Per-stage model selection

Each pipeline stage (Planner, Coder, Tester, Reviewer) can use a different model. Coder fix cycles reuse the Coder model.

| Mode | Behavior |
|------|----------|
| `--model-profile auto` (default) | Uses `modelProfiles.auto` from `.pipeline/config.json` — high-tier for Planner, mid-tier for Coder/Tester/Reviewer |
| `--model-profile manual` | Requires `--models '{"planner":"...","coder":"...","tester":"...","reviewer":"..."}'` |

**Chat mode:** resolved models are written to `stage-handoff.json` (`model`, `modelNote`). Switch IDE model before each stage.

**CLI mode:** `--model` is passed to `claude`, `cursor-agent`, `codex`, and `gemini` subprocesses.

Slash command (`/orchestrate`): the IDE agent must ask the model-selection question before calling `orchestrate.sh` — this is the only pre-run user prompt.

Default auto profiles (override in `.pipeline/config.json`):

| Runner | Planner | Coder / Tester / Reviewer |
|--------|---------|---------------------------|
| host / cursor | opus-4 | sonnet-4 |
| claude | opus | sonnet |
| codex | o3 | gpt-5 |
| gemini | gemini-2.5-pro | gemini-2.5-flash |

## Halt reasons

| Reason | Action |
|--------|--------|
| `MAX_CYCLES` | `bash .pipeline/orchestrate.sh --resume --extend N` |
| `INTERRUPTED` / stale | `bash .pipeline/orchestrate.sh --resume` or dashboard **Resume run** |
| `REGRESSION_BLOCKED` | Human review required |
| `MISSING_ARTIFACT` | Inspect `.pipeline/logs/` (Planner: often CLI auth in CLI mode) |
| `AGENT_ERROR` | CLI auth/spawn failure — use chat mode from IDE or log in to CLI |

## Invocation modes

| Mode | Flag / signal | Runner default |
|------|---------------|----------------|
| Chat | `CURSOR_AGENT=1`, IDE shell, `--mode chat` | `host` (IDE session) |
| CLI | TTY terminal, CI, `--mode cli` | First authenticated CLI on PATH |

## Two manifests

| File | Consumer |
|------|----------|
| `skills/orchestrate/SKILL.md` | `npx skills add` (Cursor, Claude Code, Codex, 68+ agents) |
| `.pipeline/skill.json` | `.cursorrules`, `AGENTS.md`, editor rules |

Both use the name `orchestrate` and command `bash .pipeline/orchestrate.sh`.
