---
name: orchestrate
description: Runs a self-healing multi-agent pipeline for one task (Planner → Plan Approver → optional Designer → Coder fix loop → Tester → Reviewer → Handoff → Reporter, the last two mandatory), or a whole roadmap of features as a pool of parallel workers, with approval gates and a live dashboard. Use only when the user explicitly invokes /orchestrate or explicitly asks to orchestrate, run the pipeline, or run a roadmap. Do not self-invoke for ordinary "build/fix/refactor this" requests, and never re-invoke it from within a stage you are already executing as part of an active run (see the self-invocation guard).
when_to_use: Trigger only on explicit phrases like "/orchestrate", "orchestrate this", "run the pipeline", "use the multi-agent pipeline", or when the user provides a task directly after /orchestrate. Do not trigger on generic build/implement/refactor requests, and never trigger while already completing a stage handoff for an active run.
argument-hint: "[task] [--roadmap <file>] [--model-profile auto|manual] [--mode chat|cli] [--host-client <name>] [--approve-plan] [--design] [--allow-self]"
arguments:
  - task
  - model-profile
  - mode
  - runner
disable-model-invocation: true
allowed-tools: Bash(bash .pipeline/orchestrate.sh *) Bash(node pipeline/pool.mjs *) Bash(node pipeline/skills.mjs *) Bash(bash skills/orchestrate/scripts/bootstrap.sh *) Bash(bash .agents/skills/orchestrate/scripts/bootstrap.sh *) Bash(cat .pipeline/*) Bash(cat .pipeline/ui.url) Bash(lsof *) Read Write(.pipeline/task.txt) Write(.pipeline/roadmap.md)
---

# Orchestrate

Self-healing multi-agent workflow: **Planner → Plan Approver → (optional Designer) → Coder (builder-checker loop) → Tester → Reviewer → Handoff → Reporter**, with artifacts saved to `.pipeline/*.md` and a live dashboard whose URL is dynamically selected and saved to `.pipeline/ui.url` to prevent port drift. The read-only Plan Approver is the default gate: it records its verdict in `plan_review.md`, automatically returns `REQUEST_CHANGES` to Planner, and escalates `BLOCK` or exhausted revisions for a human decision. `--approve-plan` adds a human gate after agent approval. Handoff and Reporter are mandatory: every run that reaches an `APPROVED` verdict always produces a continuation document for the next agent and a human-facing report — there is no flag to skip either.

The operating contract is one skill and one command for the whole request; an inspectable record during and after every run; and an attending chat that can own stages on any host without extra runner setup. Record visible progress and decision/evidence summaries, and mark unavailable transcript or private reasoning capture honestly. In pool mode, only an explicitly named CLI runner may launch an external agent; keep host runs sequential across features.

## Current environment

!`[ -f .pipeline/.lock ] && cat .pipeline/.lock || echo "No active pipeline run"`

!`[ -d .pipeline/control ] && node pipeline/pool.mjs status --json 2>/dev/null | head -40 || echo "No roadmap pool in this project"`

!`[ -f .pipeline/status.json ] && cat .pipeline/status.json || echo "No status.json"`

!`[ -f .pipeline/ui.url ] && echo "Dashboard: $(cat .pipeline/ui.url)" || echo "Dashboard: not yet started"`

## Instructions

### 1. Parse Arguments

If the user invoked this skill with arguments, extract them:
- **`$task`** — The feature or task description to implement (e.g. "implement JWT auth")
- **`$model-profile`** — `auto` or `manual` (defaults to `auto`)
- **`$mode`** — `chat` or `cli` override (optional; auto-detected from environment)
- **`$runner`** — `claude`, `cursor`, `codex`, `antigravity`, or `host` (optional; `gemini` is a deprecated alias for `antigravity`)

If `$task` was not provided as an argument, extract it from the user's message (text after `/orchestrate`).

**Two shapes of work.**

- **One task** → single-run mode. You are a chat session: invoke with `--mode chat --host-client <your-client>` (any lowercase host name), never pass `--runner`, and complete each stage yourself from `.pipeline/stage-handoff.json`, then run `--continue`.
- **A roadmap of features** → pool mode. You are the attending chat: drain host stages sequentially, and handle intake and decisions. The supervisor spawns a real OS process only for an explicitly selected authenticated CLI runner. Everything else defaults to `runner: host` and appears in the Agent queue without a human notification. Complete each queued stage directly via `pool claim <runId>` (see step 6b).

### 2. Pre-flight Check

Before running anything:
- **Self-invocation guard, check this first, no exceptions**: look at `status.json`'s `overall` field AND the pool status from the environment above. If a supervisor is alive or any run is active, work is already in flight — drain it (`/digest`) rather than starting anything. If `status.json` has a `pool` field, this project is running a roadmap: add work with `roadmap add`, never with a fresh `--task`. If it is `running`, `awaiting_chat`, or `awaiting_plan_approval`, a pipeline run is already active — do NOT invoke `bash .pipeline/orchestrate.sh` with a new task. The lock file is not a reliable signal here: a chat-mode handoff releases `.pipeline/.lock` the instant control returns to this session, so the lock can be absent for the entire time a stage is being worked on while the run is still active. If you are the one currently completing that stage (`.pipeline/stage-handoff.json` exists) — including when the assigned stage is itself "build a feature" — that is not a new orchestrate request; go straight to the **Chat Handoff Loop** (step 6) instead of re-running step 4. Invoking the script again here would archive the in-progress run as if it had already finished and silently start a new one on top of it.
- If the environment above shows an active lock file with status **not** `awaiting_chat`, stop and inform the user a pipeline run is active.
- If `.pipeline/orchestrate.sh` is missing, bootstrap the scaffold:
  ```bash
  bash .agents/skills/orchestrate/scripts/bootstrap.sh
  ```
- **Self-repo guard**: the pipeline exits with code 3 if the target is the orchestrator SOURCE repository (it must only run against consumer projects). Do not override on your own; maintainers can pass `--allow-self` or set `ORCH_ALLOW_SELF=1`.

### 3. Model Selection

- **Default**: run with `--model-profile auto`; it selects cost-optimized models per stage for the current host, with `current-chat` as the fallback for unfamiliar hosts.
- **Manual, only when explicitly requested**: collect four model names from the user, then build `--model-profile manual --models '{"planner":"...","coder":"...","tester":"...","reviewer":"..."}'`.

### 4. Execute the Pipeline

Write `$task` to `.pipeline/task.txt` using the Write tool (not by embedding it in a shell command — `$task` is free-form text and may contain characters that would otherwise need re-quoting on a command line), then run:

```bash
bash .pipeline/orchestrate.sh --task-file .pipeline/task.txt \
  --mode chat --host-client <your-client> \
  --model-profile auto \
  [--approve-plan] [--design]
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
3. Work on the assigned pipeline stage in this session (specs, design, code, tests, review, handoff, or reporter — Handoff and Reporter are mandatory stages that always run after an `APPROVED` review, same as any other stage in this loop). Never spawn or delegate to another agent CLI (`handoff.hostNote` reiterates this when set).

   **Progressive Incremental Streaming (Mandatory for Live Dashboard)**:
   Because the orchestrator script exits while waiting for your chat session, the dashboard has zero visibility into your work unless you emit events. Never wait until the end of a stage to emit progress. Follow this progressive pattern:
   - **Stage Start Heartbeat**: Immediately upon picking up the handoff, emit an intent heartbeat:
     ```bash
     bun pipeline/host-event.mjs --stage <stage> --kind text --text "Starting <stage>: inspecting specs and requirements..."
     ```
     (Use `handoff.progressStream.heartbeat` if provided; add `--run-id <runId>` when pooled).
   - **Tool / Milestone Batches**: Emit a progress event after every 1–2 major tool operations, file edits, or test runs:
     ```bash
     bun pipeline/host-event.mjs --stage <stage> --kind tool --tool edit --file <file_path>
     bun pipeline/host-event.mjs --stage <stage> --kind text --text "<concise_action_summary>"
     ```
   - **Check Followups**: Periodically check `.pipeline/followups/<stage>.txt` for live notes from the dashboard operator. Read and apply any note immediately, then delete the file.
   - **Stage Completion Summary**: Emit your final summary event right before invoking `--continue`.
4. Set `"actualModel": "your model name"` in `stage-handoff.json`.
5. Resume:
   ```bash
   bash .pipeline/orchestrate.sh --continue
   ```
6. Repeat until the pipeline finishes or halts.

When status is `awaiting_plan_approval` (an explicit `--approve-plan` gate, a blocked agent verdict, or exhausted revisions): present `.pipeline/specs.md` and `.pipeline/plan_review.md` to the user and ask them to approve or request revisions. To request a revision, queue a note in `.pipeline/followups/planner.txt` before resuming. Either way, resume with `bash .pipeline/orchestrate.sh --continue`.

### 6b. Roadmap (pool) mode

When the user hands you a roadmap, or a body of work too large for one run:

1. Write `.pipeline/roadmap.md` — flat frontmatter (`title`, `base`, `merge: pr|local-only`, optional `review: feature|end`), then one `## <ID>: <title>` per feature with `- depends_on:`, a `### Description` and a `### Acceptance` list. Features run in order; explicitly selected CLI tickets may run in parallel, while host stages run one at a time across the pool. A feature may declare `- runner: host|claude|cursor|codex|antigravity`; unset or `auto` means the attending host. Name a CLI only when the user wants unattended execution.
2. Compile and show it, so validation errors surface before anything runs:
   ```bash
   bash .pipeline/orchestrate.sh roadmap compile
   ```
3. Start with the compiled feature list and automatic model selection unless the user explicitly requested manual models:
   ```bash
   bash .pipeline/orchestrate.sh --roadmap .pipeline/roadmap.md
   ```
4. Read `bash .pipeline/orchestrate.sh pool status --json`. While `agentQueue.current` exists, claim that run, complete its current handoff, continue it, and read status again. Do this without waiting for another user message. Respect existing bridge ownership and leases. When the queue is empty, handle genuine human decisions and other pool actions:

   | Waiting on | Verb |
   |---|---|
   | `agentQueue.current` | `pool claim <runId>`, complete that stage yourself, then `--continue --run-id <runId>`; repeat |
   | a plan gate | `pool approve-plan <runId>` |
   | a question | `pool decide <decisionId> "<answer>"` |
   | a cycle budget | `pool extend <runId> <n>` |
   | a failed feature | `pool retry <featureId>` (or skip) |
   | a feature ready to merge (`review: feature`) | `pool approve-merge <featureId>` (ask the user first) |
   | a `review: end` roadmap ready to land | `pool land-roadmap` (ask the user first) |
   | changes needed | `pool request-changes <featureId> "<text>"` |

   Never merge without the user saying so. Never edit files under `.pipeline/worktrees/` — workers own them.

### 7. Post-Run Audit

Once the pipeline exits, read `.pipeline/review_report.md` and report the verdict: `APPROVED`, `REQUEST_CHANGES`, `BLOCK`, or `UNKNOWN`.

### 8. On Halt

| Halt Code | Action |
|-----------|--------|
| `MAX_CYCLES` | Surface `.pipeline/checker_report.md`, suggest `bash .pipeline/orchestrate.sh --resume --extend 5` |
| `REGRESSION_BLOCKED` | Surface `.pipeline/checker_report.md`, human review required |
| `MISSING_ARTIFACT` | Inspect `.pipeline/logs/planner.log` — often a CLI auth failure in CLI mode |
| `AGENT_ERROR` | CLI auth/spawn failure — suggest `--mode chat` from IDE or log in to the CLI tool |
| `INTEGRITY_VIOLATION` | A stage wrote control-plane files it does not own, or a "read-only" stage edited the tree. Surface the listed files; the stage's output is untrusted — human review required |
| `INVALID_VERDICT` | `.pipeline/review_report.md` has no parseable verdict. Show the report and ask whether to add the verdict line and `--resume` |

### 9. Workspace Isolation

- Treat `.pipeline/` and `.pipeline_sandbox/` as **read-only** unless completing an active chat handoff.
- Never manually fix errors inside `.pipeline_sandbox/`; the self-healing coder loop handles them.

## Examples

### Example 1: Full invocation with arguments

```
/orchestrate implement JWT authentication middleware --model-profile auto
```

→ Task is `implement JWT authentication middleware`, model profile is `auto`. Proceed directly to execution.

### Example 2: Plain invocation (conversational)

```
/orchestrate
```

→ Ask the user for the task description, then use the automatic model profile.

### Example 3: Manual model selection

*User explicitly requests the manual profile.*
*Agent collects:* Planner = `opus-5`, Coder = `sonnet-5`, Tester = `sonnet-5`, Reviewer = `opus-5`.
*Agent runs:*
```bash
bash .pipeline/orchestrate.sh "task" \
  --model-profile manual \
  --models '{"planner":"opus-5","coder":"sonnet-5","tester":"sonnet-5","reviewer":"opus-5"}'
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
