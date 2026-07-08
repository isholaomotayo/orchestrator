# Agent Pipeline — Reference

## Architecture

```
Task → Planner → Coder ↔ Checker → Tester → Reviewer → Verdict
```

The Coder loops against deterministic `test`/`lint`/`typecheck` commands until green or halted. A second fix loop may run after the Tester adds tests.

## CLI (orchestrator directly)

```bash
node pipeline/orchestrator.mjs --task "description" [--runner ...] [--sandbox] [--max-cycles N]
node pipeline/orchestrator.mjs --resume --extend N
```

## Install via skills CLI

```bash
# List skills in the repo
npx skills add OWNER/orchestrator --list

# Install for Cursor (project scope)
npx skills add OWNER/orchestrator --skill execute-agent-pipeline -a cursor -y

# Install globally
npx skills add OWNER/orchestrator --skill execute-agent-pipeline -g -a cursor -y --copy
```

Use `--copy` for Cursor if symlinked skills are not discovered (known Cursor limitation).

## Publishing checklist

1. Push repo to GitHub with `skills/execute-agent-pipeline/SKILL.md`
2. Ensure `name` in frontmatter matches directory name
3. Test: `npx skills add OWNER/orchestrator --list` shows the skill
4. Test install into a fresh project
5. Optional: submit to [skills.sh](https://skills.sh) for discovery

## Two manifest formats

| File | Purpose | Consumer |
|------|---------|----------|
| `skills/execute-agent-pipeline/SKILL.md` | Open skills ecosystem (`npx skills add`) | Cursor, Claude Code, Codex, 68+ agents |
| `.pipeline/skill.json` | Workspace tool manifest | `.cursorrules`, `AGENTS.md`, editor rules |

Keep both in sync on name, description, and outputs.
