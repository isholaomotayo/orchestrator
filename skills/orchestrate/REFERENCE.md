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

## Supply-chain integrity

Every fetch — the initial bootstrap clone and every `--update` / `--self-update`
— is **pinned to a tagged release** (`ORCHESTRATOR_REF`, currently `v1.0.1`),
never a floating branch, and the fetched tree is then **verified file-by-file
against `scaffold.sha256`** before anything in it is copied or executed.

Pinning alone would not be integrity: a tag can be moved, a repo can be
hijacked, a proxy can rewrite a response. The manifest closes that gap.

| Property | Why it matters |
|---|---|
| The manifest ships **with the skill**, not with the clone | A manifest fetched alongside the code it describes proves nothing — whoever controls the code controls the manifest. `scaffold.sha256` arrives via `npx skills add`, out-of-band from the tree it validates. |
| The **verifier** also runs from the installed skill | Running the clone's own copy would let a tampered tree approve itself. |
| Verification happens **before** any fetched code runs | Including before the re-exec into the fetched `installer.mjs`. |
| Coverage includes **stage prompts** and `package.json` | Prompts steer the agents and npm scripts execute, so both are as security-relevant as engine code. |
| **Extra** files fail the check too | `npm test` globs `pipeline/*.test.mjs`, so a merely *added* file can execute. |
| Fails **closed** | A mismatch aborts the install; it never proceeds with a warning. |

Escape hatch, for local development against a fork only:
`ORCHESTRATOR_REPO` / `ORCHESTRATOR_REF` / `ORCHESTRATOR_MANIFEST` to point at
your own release, or `--skip-verify` to install unverified (prints a warning).

Cutting a release:

```bash
npm run release:manifest -- --ref vX.Y.Z   # rehash the tree
git commit -am "release vX.Y.Z"            # commit the manifest
git tag vX.Y.Z && git push --tags
```

The manifest never hashes itself, which is what makes a same-commit pin
possible — a file cannot contain its own hash, and a commit cannot contain its
own SHA.

## Update an installed scaffold

```bash
bash .agents/skills/orchestrate/scripts/bootstrap.sh --update   # engine always; prompts/docs only if untouched
bash .agents/skills/orchestrate/scripts/bootstrap.sh --force    # also overwrite edited prompts/docs
```

Updates are **explicit by default**. `orchestrate.sh` tells you when one is available but does not
install it: applying upstream code before a run would let a remote change the engine and the stage
prompts underneath that run, unattended. Opt in per project with `"autoUpdate": true` in
`.pipeline/config.json` (then `ORCH_NO_AUTO_UPDATE=1` suppresses it for one run); auto-update never
runs on `--continue` / `--resume`, nor while `.pipeline/.lock` is held. Either way the fetch is
pinned and integrity-verified as described above. An edited prompt is never overwritten — the new
version is written beside it as `<file>.new`. `.pipeline/config.json` and run state are never touched.

## Direct CLI

```bash
bash .pipeline/orchestrate.sh "task description" [--runner ...] [--model-profile auto|manual] [--models JSON] [--approve-plan] [--design] [--handoff] [--review-panel] [--sandbox]
bash .pipeline/orchestrate.sh --task-file .pipeline/task.txt [same flags as above]
bash .pipeline/orchestrate.sh --resume [--extend 5]
node pipeline/orchestrator.mjs --task "description" --model-profile auto
node pipeline/orchestrator.mjs --task-file .pipeline/task.txt --model-profile auto
```

`--task-file` reads the task text from a file instead of a shell argument.
Chat-mode hosts should prefer it: it means free-form, user-supplied task text
never has to be embedded in (and correctly re-quoted within) a shell command
the agent constructs.

## New flags and config keys

| Flag | Config key | Default | Meaning |
|---|---|---|---|
| `--approve-plan` | `approvePlan` | `false` | After the Planner produces `specs.md`, halt with status `awaiting_plan_approval` until a human approves (or queues a revision note in `.pipeline/followups/planner.txt`) and resumes with `--continue`. |
| `--design` | `designStage` | `false` | Run an optional Designer stage between Planner and Coder, producing `.pipeline/design.md`. |
| `--handoff` | `handoffStage` | `false` | After an `APPROVED` review, run an optional Handoff stage producing `.pipeline/handoff.md`. |
| `--host-client <name>` | env `PIPELINE_HOST_CLIENT` | auto-detected | Names the IDE chat client hosting the run (`claude`, `cursor`, `codex`, `antigravity`; aliases `agy`, `gemini`, `claude-code`, `cursor-agent`). Implies `--mode chat`, drives dashboard/log attribution (`status.hostClient`, `stage-handoff.json.hostClient`/`hostNote`), and selects environment-aware auto models. |
| `--review-panel` | `reviewPanel` | `false` | Replace the single Reviewer with three concurrent read-only lenses (spec/correctness, security, architecture). Verdict is the **strictest** of the three, so a lone security finding cannot be outvoted; per-lens reports land in `.pipeline/review_{correctness,security,architecture}.md`. CLI mode only — a chat host runs one stage at a time. |
| — | `agentRetries` | `2` | Bounded retries for **transient** agent failures (429/5xx/overloaded/network/timeout) with exponential backoff. Auth, quota, and bad-model failures are fatal and never retried. Set `0` to disable. |
| — | `stageEffort` | see below | Per-stage reasoning effort. |
| `--allow-self` | env `ORCH_ALLOW_SELF=1` | off | Override the self-repo guard: without it, targeting the orchestrator SOURCE repository exits with code **3** (markers: `skills/orchestrate/SKILL.md` + `pipeline/orchestrator.mjs`). Consumers installed via bootstrap never trip the guard. |
| — | `uiIdleTimeoutMs` / env `PIPELINE_UI_IDLE_TIMEOUT_MS` | `3600000` (1h) | The dashboard server runs detached and nothing else ever stops it, so it auto-exits once idle past this many ms with no open browser tab (no requests, no SSE clients) **and** no registered project has a run in flight. Set `0` to disable and keep it running forever. |

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

**CLI mode:** `--model` is passed to `claude`, `cursor-agent`, `codex`, and `agy` (Antigravity) subprocesses. (`gemini` is a deprecated runner alias for `antigravity`.)

Slash command (`/orchestrate`): the IDE agent must ask the model-selection question before calling `orchestrate.sh` — this is the only pre-run user prompt.

Default auto profiles (override in `.pipeline/config.json`):

| Runner | Planner / Designer | Coder / Tester | Reviewer | Handoff |
|--------|---------------------|----------------|----------|---------|
| claude | opus-5 | sonnet-5 | opus-5 | haiku-4.5 |
| cursor | opus-5 | sonnet-5 | opus-5 | haiku-4.5 |
| codex | gpt-5.6-sol | gpt-5.5 | gpt-5.6-sol | gpt-5.4-mini |
| antigravity (`gemini` alias) | gemini-3.1-pro | gemini-3.6-flash | gemini-3.1-pro | gemini-3.5-flash |

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
model in that family. `codex` and `antigravity` (`agy`) receive the family id unchanged.

### Reasoning effort

Every stage carries an effort level (`low` | `medium` | `high` | `xhigh` | `max`),
configurable under `stageEffort` in `.pipeline/config.json`:

| Stage | Default effort | Why |
|---|---|---|
| planner / designer | `high` | every later stage depends on this output |
| coder / tester | `medium` | the token-heavy loop; the checker catches errors |
| reviewer | `high` | its verdict gates the run |
| handoff | `low` | summarisation of existing artifacts |

Effort is delivered per runner: `claude --effort <level>`, `agy --effort <low|medium|high>` (higher tiers collapse to `high`), `codex -c model_reasoning_effort=<level>`, and — because `cursor-agent` has no effort flag — by selecting the effort-tiered cursor model id (`claude-opus-5-thinking-high`). Chat/host stages receive it as a target in `stage-handoff.json.effort`.

## Integrity guarantees

Two checks run around every stage, independent of which runner executed it:

- **Control-plane guard.** Before and after each stage the orchestrator hashes
  `review_report.md`, `checker_report.md`, `status.json`, `specs.md`,
  `design.md`, `test_history.json`, `stage-handoff.json`, and every stage prompt.
  A stage that changes any of them — other than the one artifact it owns — halts
  the run as `INTEGRITY_VIOLATION`. Without this, the Coder could write its own
  `## Verdict: APPROVED`.
- **Read-only proof.** Read-only stages have the working tree fingerprinted
  before and after. `cursor-agent` and `agy` cannot hard-enforce read-only, so
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

---

# v2: roadmap mode, skills and reports

## Roadmap and pool commands

```bash
bash .pipeline/orchestrate.sh --roadmap <file>       # compile and start the supervisor
bash .pipeline/orchestrate.sh roadmap compile|show
bash .pipeline/orchestrate.sh roadmap hold|release|skip <featureId>
bash .pipeline/orchestrate.sh pool start|stop|pause|resume
bash .pipeline/orchestrate.sh pool status [--json] | digest
bash .pipeline/orchestrate.sh pool attention [--json] | ack <id>
bash .pipeline/orchestrate.sh pool decisions [--json]
bash .pipeline/orchestrate.sh pool claim <runId>                    # pick up a run parked in chat (runner: host)
bash .pipeline/orchestrate.sh pool decide <decisionId> "<answer>"
bash .pipeline/orchestrate.sh pool approve-plan <runId>
bash .pipeline/orchestrate.sh pool approve-merge [featureId] [--note "..."]
bash .pipeline/orchestrate.sh pool land-roadmap [--note "..."]   # review: end — land the working branch onto base
bash .pipeline/orchestrate.sh pool retry <featureId>
bash .pipeline/orchestrate.sh pool request-changes <featureId> "<text>"
bash .pipeline/orchestrate.sh pool extend <runId> <cycles>
bash .pipeline/orchestrate.sh pool notes add "<text>" [--kind learning|decision|gotcha]
```

Exit codes: `0` ok, `1` error, `2` usage, `3` self-target guard, `4` no supervisor running.

## Engine flags added in v2

| Flag | Meaning |
|---|---|
| `--run-id <id>` | run state lives in `.pipeline/runs/<id>/` instead of `.pipeline/` |
| `--worktree <path\|auto>` | isolate this run in its own git worktree (`--sandbox` is now sugar for `auto`) |
| `--branch <name>` | branch for this run's commits |
| `--base-ref <sha>` | what the review diff is scoped against (an integration run reviews a whole feature) |
| `--feature-id`, `--ticket-id` | identity, recorded in `run.json` and the snapshot |
| `--brief-file <path>` | task text from a brief; the machine header never enters the TASK block |
| `--specs-file <path>` | start from an existing specification, skipping the Planner |
| `--changes-file <path>` | seed the Coder artifact (used by integration runs) |
| `--start-at tester` | begin at verification over work that is already committed |
| `--plan-only` | run the Planner and stop, producing the specification tickets are sliced from |
| `--report` | compile the work-done report after an approved review |

## Feature and run state

Feature statuses: `queued`, `planning`, `awaiting_plan_approval`, `executing`,
`integrating`, `reviewing`, `awaiting_merge_approval`, `merge_approved`,
`merging`, `landed`, `failed`, `held`, `skipped`.

Roadmap frontmatter: `title`, `base`, `merge: pr|local-only`, `review: feature|end`
(default `feature`). `review: end` accepts each approved feature onto
`pipeline/roadmap/<slug>` and asks once, at the end, to land that branch onto
`base` via `pool land-roadmap`.

Run verbs (`.pipeline/runs/<id>/run.status`, append-only): `working`,
`needs-decision`, `blocked`, `paused`, `held`, `resolved`, `done`, `failed`,
`landed`, `note`.

Contracts: `orchestrator-roadmap.v1`, `orchestrator-run-meta.v1`,
`orchestrator-pool-snapshot.v1`.

## Configuration added in v2

```jsonc
"pool": {
  "maxParallel": 3,              // tickets running at once within a feature
  "pollMs": 2000,
  "heartbeatMs": 300000,
  "staleAfterMs": 600000,        // quiet this long while "working" is suspicious
  "staleEscalateMs": 240000,     // still quiet this long after that: tell someone
  "pauseResurfaceMs": 3600000,   // how often a declared wait is put back in front of you
  "autoResumeMax": 2,            // transient failures retried without asking
  "serializeOnFileOverlap": true,
  "featurePlanApproval": true,
  "ticketFlags": { "reviewPanel": false },
  "integrationFlags": { "reviewPanel": true, "report": true }
},
"merge": {
  "mode": "pr",                  // pr | local-only
  "remote": "origin",
  "mergeMethod": "squash",
  "requireMergeable": true,      // refuse while checks are outstanding
  "autoMerge": false,            // still performs the live check
  "cleanupOnMerge": true
},
"reportStage": false,
"reports": { "diagrams": true, "archifyTimeoutMs": 120000 },
"skills": [ /* see below */ ]
```

## Skills

```jsonc
"skills": [{
  "name": "archify",
  "source": { "type": "local", "path": "~/.claude/skills/archify" },
  // or  { "type": "git", "repo": "...", "ref": "v2.16.0", "sha256": "<hash of the pin file>" }
  "stages": ["reporter"],
  "entry": "SKILL.md",
  "maxPromptBytes": 32768,
  "omitSections": ["## Update awareness", "## Setup and fallback"],
  "tools": [{ "bash": "node {skillDir}/bin/archify.mjs validate" }],
  "diagrams": {
    "render":   "node {skillDir}/bin/archify.mjs deliver {type} {spec} {out} --quality showcase --json",
    "validate": "node {skillDir}/bin/archify.mjs validate {type} {spec} --quality showcase --json",
    "types": ["architecture", "workflow", "sequence", "dataflow", "lifecycle"],
    "repoRootFlag": { "architecture": "--repo-root {repoRoot}" }
  }
}]
```

```bash
node pipeline/skills.mjs list | verify [name] | pin <name>
```

`pin` records a sha256 of every file in the package. Review a skill before
pinning it: its text becomes part of your agents' instructions.

## Upgrading from v1

1. Refresh the skill bundle, then `bash .agents/skills/orchestrate/scripts/bootstrap.sh --update`.
2. `.gitignore` is not managed — copy the v2 block from this repository's
   `.gitignore` by hand. Without it, worktrees show up as untracked files.
3. `.pipeline_sandbox/` is legacy. Finish or discard any run using it, delete the
   directory, and use `--worktree auto` (or nothing) instead of `--sandbox`.
4. Existing runs, `--continue`, `--resume` and the single-run dashboard are
   unchanged; a v1 `status.json` still resumes.
