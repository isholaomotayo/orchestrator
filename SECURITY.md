# Security model

This skill installs and runs a multi-agent pipeline: it copies engine code and
stage prompts into your project, and those prompts drive coding agents that
write to your working tree. That makes two things security-relevant — **where
the code comes from**, and **what can influence the agents**. Both are addressed
below.

## 1. Where the code comes from (supply chain)

The scaffold (`pipeline/`, `.pipeline/`) is fetched from GitHub rather than
vendored into the skill bundle, so the fetch is the trust boundary.

| Control | Detail |
|---|---|
| **Pinned ref** | Fetches use a *tagged release* (`ORCHESTRATOR_REF`), never a branch. No `clone` of a moving target. |
| **Manifest verification** | The fetched tree is compared file-by-file against sha256 hashes in `scaffold.sha256`. |
| **Out-of-band trust anchor** | `scaffold.sha256` and its verifier ship **inside the skill bundle** (`npx skills add`), not in the fetched tree. A manifest that travels with the code it describes proves nothing; this one does not. |
| **Verify before execute** | Verification runs before any fetched file is copied or executed — including before the re-exec into the fetched `installer.mjs`. |
| **Fails closed** | Any mismatch, missing file, or unexpected extra file aborts the install. It never proceeds with a warning. |
| **Broad coverage** | Engine code, entrypoint scripts, **stage prompts**, `package.json`, and editor rule files. Prompts steer agents and npm scripts execute, so they are covered like code. Extra files count as tampering because `npm test` globs `pipeline/*.test.mjs`. |
| **No inline remote scripting** | No `curl | bash`, no `node -e` one-liners built from fetched data. The one JSON merge the installer performs lives in a checked-in, reviewable file (`pipeline/merge-package-json.mjs`). |

### Updates are explicit

A run **reports** that an update exists; it does not install one. Applying
upstream code automatically before a run would mean a remote could change the
engine and the stage prompts underneath that run, unattended — a runtime
external dependency that steers the agents. Opt in per project with
`"autoUpdate": true` in `.pipeline/config.json`; updates are otherwise applied
deliberately with `bootstrap.sh --update`, under the same pin-and-verify rules.

### Escape hatches

`--skip-verify` (and `ORCHESTRATOR_REPO` / `ORCHESTRATOR_REF` /
`ORCHESTRATOR_MANIFEST`) exist for developing against a fork. They print a
warning and are never the default. Do not use them to get past a failed
integrity check on the real release — a failure there means the pinned tag now
resolves to content that was not reviewed.

## 2. What can influence the agents (prompt injection)

The pipeline feeds a user-supplied task description, and repository content, to
agents that can edit files. Two boundaries constrain that.

**The task description is delimited data.** Free-form task text is wrapped in an
explicit `TASK BLOCK` marker before it reaches any stage, and every stage prompt
states that only the prompt and that block are instructions. Text inside the
block is the feature to build, not a directive that can redirect the stage.

**Task text is not shell-interpolated.** `--task-file` reads the task from a
file, so a chat host never has to embed and re-quote user text inside a command
line it constructs. This is the recommended path and what the skill instructs
agents to use.

**Everything read while working is data.** Each stage prompt establishes a trust
boundary: source files, comments, dependency code, commit messages, issue text,
tool output, and web pages are material to analyze, never commands to obey.
Agents are instructed to record suspicious embedded instructions in their
artifact and carry on with the assigned task.

## 3. Runtime guardrails

These limit what a compromised or merely misbehaving stage can achieve.

- **Control-plane guard** — every stage's non-owned control files are hashed
  before and after it runs; a stage that writes an artifact it does not own
  halts the run as `INTEGRITY_VIOLATION`. Without it, the Coder could write its
  own `## Verdict: APPROVED`.
- **Read-only proof** — read-only stages have the working tree fingerprinted
  before and after, catching after the fact what a CLI without a permission
  model cannot prevent.
- **Regression halt** — a shrinking test suite halts the run, so "fix the
  failures" cannot be satisfied by deleting the tests.
- **Self-target guard** — the pipeline refuses to run against its own source
  repository (exit 3).
- **Bounded loops** — every fix loop has a cycle budget and halts rather than
  looping indefinitely.

## Reporting a vulnerability

Open a GitHub issue, or contact the maintainer through the repository. Please
include the version (`.pipeline/install.json` records the installed commit) and
whether the finding requires a compromised upstream or works against a
correctly verified install.
