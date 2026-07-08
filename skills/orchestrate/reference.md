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
bash .pipeline/orchestrate.sh "task description" [--runner ...] [--sandbox]
bash .pipeline/orchestrate.sh --resume --extend 5
node pipeline/orchestrator.mjs --task "description"
```

## Halt reasons

| Reason | Action |
|--------|--------|
| `MAX_CYCLES` | `bash .pipeline/orchestrate.sh --resume --extend N` |
| `REGRESSION_BLOCKED` | Human review required |
| `MISSING_ARTIFACT` | Inspect `.pipeline/logs/` |

## Two manifests

| File | Consumer |
|------|----------|
| `skills/orchestrate/SKILL.md` | `npx skills add` (Cursor, Claude Code, Codex, 68+ agents) |
| `.pipeline/skill.json` | `.cursorrules`, `AGENTS.md`, editor rules |

Both use the name `orchestrate` and command `bash .pipeline/orchestrate.sh`.
