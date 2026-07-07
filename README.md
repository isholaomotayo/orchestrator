# Agent Pipeline — Unified Self-Healing Multi-Agent Skill

A portable, zero-dependency workspace skill that turns a vague feature request into reviewed, tested software via a single pipeline:

```
Task ─► PLANNER ──specs.md──► CODER ──changes.md──► TESTER ──test_suite.md──► REVIEWER ──review_report.md──► Verdict
                              │ self-healing loop (≤5 cycles):
                              │  1. Coder agent implements / fixes
                              │  2. Checker runs test + lint + typecheck
                              │  3. green → advance
                              │     regression (pass count drops) → HALT
                              │     cycles exhausted → HALT
```

Every stage streams verbose activity and writes markdown artifacts into `.pipeline/`, and a **live dashboard** renders stage progress, the Coder's fix-cycle dots, agent logs, and the artifacts at **http://localhost:4600**.

Works with any of these agent CLIs (auto-detected, or pick with `--runner`): **Claude Code** (`claude`), **Cursor** (`cursor-agent`), **Codex** (`codex`), **Gemini / Antigravity** (`gemini`).

## Quickstart

```bash
# Run the full pipeline on a task (starts the dashboard automatically)
bash .pipeline/spawn.sh "Fix the failing multiply test in demo/" --runner claude

# Dashboard only
npm run ui       # → http://localhost:4600
```

Flags: `--runner claude|cursor|codex|gemini`, `--sandbox` (run agents in an isolated git worktree at `.pipeline_sandbox/`), `--no-ui`.

## How it works

| Component | Role |
|---|---|
| [.pipeline/spawn.sh](.pipeline/spawn.sh) | Entrypoint: lock pre-flight, boots the dashboard, runs the orchestrator |
| [pipeline/orchestrator.mjs](pipeline/orchestrator.mjs) | State machine: stage transitions, coder fix loop, guardrails, `status.json` + `events.jsonl` |
| [pipeline/adapters.mjs](pipeline/adapters.mjs) | Headless CLI adapters with verbose stream parsing per runner |
| [pipeline/checker.mjs](pipeline/checker.mjs) | Deterministic (non-LLM) verification: runs configured test/lint/typecheck, parses pass counts, writes `checker_report.md` |
| [pipeline/ui-server.mjs](pipeline/ui-server.mjs) | Zero-dep HTTP + SSE server watching `.pipeline/` |
| [pipeline/dashboard.html](pipeline/dashboard.html) | Single-file dashboard (stage rail, cycle dots, live logs, artifact tabs) |
| [.pipeline/prompts/](.pipeline/prompts) | System prompts for the four agent roles |
| [.pipeline/skill.json](.pipeline/skill.json) | Portable skill declaration discovered by agent CLIs |

### Guardrails

1. **Regression halt** — if a fix cycle passes *fewer* tests than the previous cycle, the pipeline halts (`REGRESSION_BLOCKED`) for human inspection instead of burning tokens.
2. **Max cycles** — the Coder loop stops after `maxCoderCycles` (default 5); post-Tester fixes are capped at `maxPostTesterCycles` (default 2).
3. **Never-weaken-tests** — the Coder prompt forbids deleting/mocking tests to pass; the Reviewer runs **read-only** (tool allowlist) and can only write `review_report.md`.
4. **Mutex lock** — `.pipeline/.lock` prevents overlapping runs; other agents are instructed to pre-flight check it.
5. **Sandbox** — `--sandbox` runs agents in a git worktree (`.pipeline_sandbox/`) so IDE watchers never see half-finished code; artifacts still land in the main `.pipeline/` via symlink.
6. **Artifact validation** — each stage must produce its expected non-empty artifact or the pipeline halts (`MISSING_ARTIFACT`).

### Configuration — `.pipeline/config.json`

```jsonc
{
  "runner": "auto",              // or claude | cursor | codex | gemini | <customRunner>
  "maxCoderCycles": 5,
  "maxPostTesterCycles": 2,
  "uiPort": 4600,
  "checks": {                    // set any to "" to skip
    "test": "npm test --silent",
    "lint": "npm run lint --if-present --silent",
    "typecheck": "npm run typecheck --if-present --silent"
  },
  "checkTimeoutMs": 300000,
  "agentTimeoutMs": 1800000
}
```

Custom/stub runners (useful for CI or token-free testing) can be defined under `customRunners`:

```jsonc
"customRunners": {
  "stub": { "command": "bash", "args": ["scripts/stub-agent.sh", "{task}"] }
}
```

Placeholders: `{task}`, `{systemPrompt}`, `{readOnly}`.

### Editor / agent discovery

The skill is advertised to every major agent CLI via committed rule files: [.clauderules](.clauderules) (Claude Code), [.cursorrules](.cursorrules) (Cursor), [AGENTS.md](AGENTS.md) (Codex, Antigravity), [GEMINI.md](GEMINI.md) (Gemini CLI). All of them also carry the isolation guardrails (treat `.pipeline/` + `.pipeline_sandbox/` as read-only, respect the `.lock`).

### Runtime artifacts (gitignored)

`status.json` (live state consumed by the UI) · `events.jsonl` (append-only event feed) · `logs/<stage>.log` (verbose agent output) · `specs.md` · `changes.md` · `checker_report.md` · `test_suite.md` · `review_report.md` · `test_history.json` · `.lock`.

## Demo

[demo/math.js](demo/math.js) contains an intentional bug (`multiply` adds instead of multiplying). Try:

```bash
bash .pipeline/spawn.sh "Fix the failing multiply test in demo/math.js" --runner claude
```

and watch the Planner → Coder (fix loop) → Tester → Reviewer flow reach a verdict on the dashboard.
