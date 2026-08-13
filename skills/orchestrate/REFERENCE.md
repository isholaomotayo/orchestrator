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

Copies `.pipeline/`, `pipeline/`, and merges `package.json` scripts from the GitHub repo, then records
`.pipeline/install.json` (installed commit + a hash of every delivered file).

## Update an installed scaffold

```bash
bash .agents/skills/orchestrate/scripts/bootstrap.sh --update   # engine always; prompts/docs only if untouched
bash .agents/skills/orchestrate/scripts/bootstrap.sh --force    # also overwrite edited prompts/docs
```

`orchestrate.sh` also applies pending updates automatically before a new run (never on `--continue` /
`--resume`, never while `.pipeline/.lock` is held). Disable with `ORCH_NO_AUTO_UPDATE=1` or
`"autoUpdate": false` in `.pipeline/config.json`. An edited prompt is never overwritten — the new
version is written beside it as `<file>.new`. `.pipeline/config.json` and run state are never touched.

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
| `--review-panel` | `reviewPanel` | `false` | Replace the single Reviewer with three concurrent read-only lenses (spec/correctness, security, architecture). Verdict is the **strictest** of the three, so a lone security finding cannot be outvoted; per-lens reports land in `.pipeline/review_{correctness,security,architecture}.md`. CLI mode only — a chat host runs one stage at a time. |
| — | `agentRetries` | `2` | Bounded retries for **transient** agent failures (429/5xx/overloaded/network/timeout) with exponential backoff. Auth, quota, and bad-model failures are fatal and never retried. Set `0` to disable. |
| — | `stageEffort` | see below | Per-stage reasoning effort. |
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

| Runner | Planner / Designer | Coder / Tester | Reviewer | Handoff |
|--------|---------------------|----------------|----------|---------|
| claude | opus-5 | sonnet-5 | opus-5 | haiku-4.5 |
| cursor | opus-5 | sonnet-5 | opus-5 | haiku-4.5 |
| codex | gpt-5.6-sol | gpt-5.5 | gpt-5.6-sol | gpt-5.4-mini |
| gemini / antigravity | gemini-3.1-pro | gemini-3.6-flash | gemini-3.1-pro | gemini-3.5-flash |

The Reviewer sits on the frontier tier deliberately: its verdict gates the whole
run, it is read-only, and it runs few times. The Handoff stage is pure
summarisation and sits on the cheapest tier.

Host (chat) mode is environment-aware: a known `--host-client` uses that client's ecosystem profile above; an unknown or absent host client suggests the `current-chat` sentinel for every stage — "use whatever model this chat session is running". Hosts record the model actually used as `"actualModel"` in `stage-handoff.json` so logs and the dashboard stay truthful.

Available models for manual selection (dashboard dropdowns and `--models`):

| Provider | Model families |
|----------|----------------|
| Anthropic | `opus-5`, `fable-5`, `sonnet-5`, `haiku-4.5` |
| OpenAI | `gpt-5.6-sol`, `gpt-5.5`, `gpt-5.4-mini` |
| Google | `gemini-3.1-pro`, `gemini-3.6-flash`, `gemini-3.5-flash` |
| xAI | `grok-4.5` |

Any other model ID can still be entered via the dashboard "Custom…" option or a raw `--models` JSON value; unknown ids pass through to the CLI verbatim after a startup warning.

### Model families vs. runner model ids

The pipeline reasons in vendor-neutral **families**. Each runner CLI is handed
the identifier it actually accepts, resolved in `pipeline/models.mjs`:

| Family | `claude --model` | `cursor-agent --model` |
|---|---|---|
| `opus-5` | `opus` | `claude-opus-5` |
| `sonnet-5` | `sonnet` | `claude-sonnet-5` |
| `haiku-4.5` | `haiku` | — |

Short aliases are used for `claude` so an auto profile always tracks the newest
model in that family. `codex` and `gemini` receive the family id unchanged.

### Reasoning effort

Every stage carries an effort level (`low` | `medium` | `high` | `xhigh` | `max`),
configurable under `stageEffort` in `.pipeline/config.json`:

| Stage | Default effort | Why |
|---|---|---|
| planner / designer | `high` | every later stage depends on this output |
| coder / tester | `medium` | the token-heavy loop; the checker catches errors |
| reviewer | `high` | its verdict gates the run |
| handoff | `low` | summarisation of existing artifacts |

Effort is delivered per runner: `claude --effort <level>`, `codex -c model_reasoning_effort=<level>`, and — because `cursor-agent` has no effort flag — by selecting the effort-tiered cursor model id (`claude-opus-5-thinking-high`). Chat/host stages receive it as a target in `stage-handoff.json.effort`.

## Integrity guarantees

Two checks run around every stage, independent of which runner executed it:

- **Control-plane guard.** Before and after each stage the orchestrator hashes
  `review_report.md`, `checker_report.md`, `status.json`, `specs.md`,
  `design.md`, `test_history.json`, `stage-handoff.json`, and every stage prompt.
  A stage that changes any of them — other than the one artifact it owns — halts
  the run as `INTEGRITY_VIOLATION`. Without this, the Coder could write its own
  `## Verdict: APPROVED`.
- **Read-only proof.** Read-only stages have the working tree fingerprinted
  before and after. `cursor-agent` and `gemini` cannot hard-enforce read-only, so
  this catches after the fact what their CLIs cannot prevent.

Artifacts are also content-validated rather than size-checked: a review report
with no parseable verdict halts as `INVALID_VERDICT` instead of being treated as
a rejection and silently burning a fix pass.

## Halt reasons

On every halt (`MAX_CYCLES`, `REGRESSION_BLOCKED`, `MISSING_ARTIFACT`, `AGENT_ERROR`, `INTERRUPTED`), the orchestrator deterministically writes `.pipeline/handoff.md` — a summary of state, artifacts, and next steps. Read it first before digging into logs.

| Reason | Action |
|--------|--------|
| `MAX_CYCLES` | `bash .pipeline/orchestrate.sh --resume --extend N` |
| `INTERRUPTED` / stale | `bash .pipeline/orchestrate.sh --resume` or dashboard **Resume run** |
| `REGRESSION_BLOCKED` | Human review required |
| `MISSING_ARTIFACT` | Inspect `.pipeline/logs/` (Planner: often CLI auth in CLI mode) |
| `INTEGRITY_VIOLATION` | A stage wrote control-plane files it does not own, or a read-only stage mutated the working tree. Its output is untrusted — inspect the listed files and `git status` before resuming. |
| `INVALID_VERDICT` | The review report has no parseable verdict line. Read `review_report.md`; if the audit is sound, add the verdict line and `--resume`. |
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
