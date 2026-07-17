# /orchestrate — Reference

Repository: https://github.com/isholaomotayo/orchestrator

## Architecture

```
Task → Planner → (optional Designer) → Coder ↔ Checker → Tester → Reviewer → Verdict → (optional Handoff)
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
bash .pipeline/orchestrate.sh "task description" [--runner ...] [--model-profile auto|manual] [--models JSON] [--approve-plan] [--design] [--handoff] [--sandbox]
bash .pipeline/orchestrate.sh --resume [--extend 5]
node pipeline/orchestrator.mjs --task "description" --model-profile auto
```

## New flags and config keys

| Flag | Config key | Default | Meaning |
|---|---|---|---|
| `--approve-plan` | `approvePlan` | `false` | After the Planner produces `specs.md`, halt with status `awaiting_plan_approval` until a human approves (or queues a revision note in `.pipeline/followups/planner.txt`) and resumes with `--continue`. |
| `--design` | `designStage` | `false` | Run an optional Designer stage between Planner and Coder, producing `.pipeline/design.md`. |
| `--handoff` | `handoffStage` | `false` | After an `APPROVED` review, run an optional Handoff stage producing `.pipeline/handoff.md`. |
| `--host-client <name>` | env `PIPELINE_HOST_CLIENT` | auto-detected | Names the IDE chat client hosting the run (`claude`, `cursor`, `codex`, `gemini`, `antigravity`; aliases `agy`, `claude-code`, `cursor-agent`). Implies `--mode chat`, drives dashboard/log attribution (`status.hostClient`, `stage-handoff.json.hostClient`/`hostNote`), and selects environment-aware auto models. |
| `--allow-self` | env `ORCH_ALLOW_SELF=1` | off | Override the self-repo guard: without it, targeting the orchestrator SOURCE repository exits with code **3** (markers: `skills/orchestrate/SKILL.md` + `pipeline/orchestrator.mjs`). Consumers installed via bootstrap never trip the guard. |

The first three also live in `.pipeline/config.json` as top-level booleans and can be enabled by default without passing the flag each run.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Completed, or a chat handoff / approval gate was written |
| `1` | Error or an active lock |
| `2` | Usage error |
| `3` | Self-target guard: this is the orchestrator source repo — override with `--allow-self` / `ORCH_ALLOW_SELF=1` |

## Antigravity discovery paths

Bootstrap installs these into consumers (Antigravity, verified July 2026):

| Path | Purpose |
|------|---------|
| `.agents/skills/orchestrate/SKILL.md` | Workspace skill (also the agents-standard skill location) |
| `.agents/workflows/orchestrate.md` | Workflow — registers `/orchestrate` in Antigravity chat |
| `.agent/rules/orchestrate.md` | Always-on rule: `--mode chat --host-client antigravity`, never delegate to an external CLI |

## Per-stage model selection

Each pipeline stage (Planner, Designer, Coder, Tester, Reviewer, Handoff) can use a different model. Coder fix cycles reuse the Coder model. Manual `--models` only needs the four core stages — Designer defaults to the Planner's model and Handoff defaults to the Reviewer's model when omitted.

| Mode | Behavior |
|------|----------|
| `--model-profile auto` (default) | Uses `modelProfiles.auto` from `.pipeline/config.json` — high-tier for Planner/Designer, mid-tier for Coder/Tester/Reviewer, and cheapest-tier for Handoff |
| `--model-profile manual` | Requires `--models '{"planner":"...","coder":"...","tester":"...","reviewer":"..."}'` (add `"designer"` / `"handoff"` keys to override their defaults) |

**Chat mode:** resolved models are written to `stage-handoff.json` (`model`, `modelNote`). Switch IDE model before each stage (or use your active model, updating `"actualModel"` in `stage-handoff.json` before running `--continue`).

**CLI mode:** `--model` is passed to `claude`, `cursor-agent`, `codex`, and `gemini` subprocesses.

Slash command (`/orchestrate`): the IDE agent must ask the model-selection question before calling `orchestrate.sh` — this is the only pre-run user prompt.

Default auto profiles (override in `.pipeline/config.json`):

| Runner | Planner / Designer | Coder / Tester / Reviewer | Handoff |
|--------|---------------------|---------------------------|---------|
| cursor | opus-4.8 | sonnet-5 | sonnet-5 |
| claude | opus-4.8 | sonnet-5 | sonnet-5 |
| codex | gpt-5.5 | gpt-5.5 | gpt-5.5 |
| gemini / antigravity | gemini-3.1-pro | gemini-3.5-flash | gemini-3.1-flash-lite |

Host (chat) mode is environment-aware: a known `--host-client` uses that client's ecosystem profile above; an unknown or absent host client suggests the `current-chat` sentinel for every stage — "use whatever model this chat session is running". Hosts record the model actually used as `"actualModel"` in `stage-handoff.json` so logs and the dashboard stay truthful.

Available models for manual selection (dashboard dropdowns and `--models`):

| Provider | Model IDs |
|----------|-----------|
| Anthropic | `fable-5`, `opus-4.8`, `sonnet-5` |
| OpenAI | `gpt-5.5-pro`, `gpt-5.5` |
| Google | `gemini-3.1-pro`, `gemini-3.5-flash`, `gemini-3.1-flash-lite` |
| xAI | `grok-4.5`, `grok-4.3` |

Any other model ID can still be entered via the dashboard "Custom…" option or a raw `--models` JSON value.

## Halt reasons

On every halt (`MAX_CYCLES`, `REGRESSION_BLOCKED`, `MISSING_ARTIFACT`, `AGENT_ERROR`, `INTERRUPTED`), the orchestrator deterministically writes `.pipeline/handoff.md` — a summary of state, artifacts, and next steps. Read it first before digging into logs.

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
| Chat | `--mode chat`, `--host-client <name>`, `PIPELINE_HOST_CLIENT`, `CURSOR_AGENT=1`, `ANTIGRAVITY*` env, IDE shell | `host` (IDE session) |
| CLI | TTY terminal, CI, `--mode cli` | First authenticated CLI on PATH |

Env heuristics are unreliable across IDEs (TTY checks misfire in IDE-integrated terminals), so chat sessions must signal explicitly: pass `--mode chat --host-client <your-client>` whenever the invoking agent is itself a chat session. `--host-client` alone implies chat mode. `status.json`/`stage-handoff.json` carry `hostClient` so the dashboard attributes the run ("awaiting Antigravity") correctly.

## Two manifests

| File | Consumer |
|------|----------|
| `skills/orchestrate/SKILL.md` | `npx skills add` (Cursor, Claude Code, Codex, 68+ agents) |
| `.pipeline/skill.json` | `.cursorrules`, `AGENTS.md`, editor rules |

Both use the name `orchestrate` and command `bash .pipeline/orchestrate.sh`.
