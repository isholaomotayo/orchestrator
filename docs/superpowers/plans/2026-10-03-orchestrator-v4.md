# Orchestrator v4 — Implementation Plan

**Date:** 2026-10-03
**Design:** [Self-recovery and desktop history](../specs/2026-10-03-self-recovery-and-history-design.md)

## Status (2026-10-03)

| Item | State |
|---|---|
| Stage 1, WP1–WP10 | Landed (commits `063d773`..`fb6bd24`); `npm test` 884/884 |
| Stage 2 M1 (thin) | Landed: inbox, run view, server-driven actions, notifications, decision and plan cards, autonomy control, pause-all, ack, Dock badge |
| M1 still open | Projects → Runs tree, stage rail and tabs, tray, snooze (needs WP12) |
| WP11 R1 (one halt-reason registry, audit trail) | Landed (`1cf9270`, `e533f8e`). Still open: the table's surface axis, `ui/actions.mjs` mirror |
| WP11 R2 (Doctor: `diagnose()`, `diagnosis` in the API, `orchestrate.sh doctor`) | Landed (`880c77b`) |
| WP11 R3 (self-heal) | Landed: dead-engine restart with grace, backoff and budget; hand-back to guided; supervisor-crash alert; `doctor --fix`. Deferred, see below |
| WP12 (History API), Desktop track D1–D4 | Planned: see the addendum at the end |

**R3, deliberately not built, and why**

- **Held-ticket timeout.** An autonomous run already retries a halted ticket once at the moment it halts, so a ticket
  only reaches `held` after that budget is spent or when the run is guided. A held ticket is already resurfaced
  hourly. Retrying it again on a timer would spend a second budget on a failure already seen twice.
- **Automatic `reassign` of a parked host run.** A parked run needs a new chat session to claim it, and nothing the
  engine can do unattended supplies one. The doctor already names who it is waiting on; `reassign` stays a manual or
  host action.
- **Gating the existing halt auto-resume by autonomy.** The supervisor still auto-resumes transient `AGENT_ERROR`
  and does one auto-extend for `MAX_CYCLES` whatever the run's autonomy. That predates self-heal and changing it
  would alter field behaviour, so it needs its own decision.

The original v4 plan follows unchanged. The addendum extends WP1, WP6, WP7, WP8, WP10 and Stage 2 M1/M2.

---

## Context

`/orchestrate` started as a skill (Node `.mjs` engine + local web dashboard) and is now carrying real
roadmap workloads. A forensics pass over the 69 most recent runs in `~/dev/petra` (Sep 12–30, 2026)
shows the skill works, but runs are not reliable, not observable, and not controllable enough:

- **7 halts + ~16 manual interventions**, several by hand-forging `status.json`; ~52 min of finished,
  committed work thrown away by full-feature replans; one stage parked **13 h with zero signal**.
- Every run was chat/host mode (Antigravity). Agent-CLI mode has **zero** real usage — and has latent
  bugs that would hit as soon as it is used.
- Reports are untrustworthy (every coverage table renders all-red), retries are invisible, cost is null.

Top root causes (evidence in petra `.pipeline/control/supervisor.log`, `runs.jsonl`, `runs/*/events.jsonl`):

1. Recoverable halts (MISSING_ARTIFACT, false REGRESSION_BLOCKED) fail the whole **feature** within ~2 s,
   and the only remedy (`pool retry`) replans from scratch, orphaning committed tickets (P8 ×3, P9 ×2).
2. `checker.mjs parseTestCounts` reads only the **last** TAP summary → false regressions; the guard saw
   123 of 605 tests. Petra has a local fix (petra commit `7eac1e8`) that never went upstream.
3. Recovery paths are broken in source: stale-run `--resume` reads its own lock (always "alive");
   supervisor auto-resume sends `--resume` for AGENT_ERROR, which the engine always rejects; dashboard
   Extend sends `{cycles}` but the server reads `extend` (always 400).
4. Parked chat stages raise no signal (claim-run attention removed in `473d579`); no FIFO.
5. Orphan runs, dismiss → bad respawn, supervisor tick crash loops (invalid ticket scope, missing remote
   base ref) that stall the pool silently.
6. Mode is decided in ~12 scattered places with 3 different "is chat" predicates; dashboard-started runs
   inherit a chat env and get silently converted to host runs.
7. The UI is "push a ping, refetch everything": actions are fire-and-forget (failure → success toast),
   no plan-approve / new-run controls, idle shutdown kills the server during chat runs.

**Intended outcome.** Stage 1 makes every run recoverable without hand edits, in both surfaces
(chat/host and CLI), with one clear mode model, a push-based versioned API, and truthful reporting —
tracked and controlled from the web UI. Stage 2 adds an **optional** native Rust/GPUI desktop app
(spec + thin macOS MVP) on that same API: tray, attention inbox, notifications, live run view, and
guided↔autonomous control, with a Vercel AI SDK assistant and SDK runners in later milestones.
The skill must keep working fully without the app.

## Core concept: two orthogonal mode axes

Today "mode" mixes several separate things. Stage 1 splits them into two axes, each decided in one place:

| Axis | Values | Decided | Mutable? |
|---|---|---|---|
| **surface**: who executes stages | `host` (a chat session completes stages via handoff) · `cli` (the engine spawns an agent CLI) | once, at run creation, recorded as `status.surface` (+ `runner`, `hostClient`) | **No.** Immutable for the run's life; never silently reconciled |
| **autonomy**: who decides at gates | `guided` (plan gate, halts ask a human, merge gate) · `autonomous` (auto-recover within budgets, notify only) | run policy `status.policy.autonomy`; project default in `config.json` | **Yes**, from the UI mid-run; applies at the next gate, with an audit event |

Every consumer (engine, supervisor, ui-server, report, web UI, desktop) reads these through one module,
`pipeline/mode.mjs` (`surfaceOf(status)`, `isHost(status)`, `policyOf(status)`). This replaces the
three current predicates (`adapters.mjs:324` `runner==='host'`, `orchestrator.mjs:776` `isChat`,
`isHostSurface` at ~1216/1693/1717/1743) and the duplicate heuristic in `orchestrate.sh:283`.

---

# Stage 1 — Flawless runs, clear modes, controllable UI

Each work package (WP) lands as its own PR. **Write the failing test first** (node:test, `npm test`),
regenerate `scaffold.sha256` (pre-commit hook / `scripts/gen-scaffold-manifest.mjs`), and keep
`dashboard.html` rebuilt (`scripts/build-dashboard.mjs`). The WPs are ordered by failure impact.

### WP1 — Recovery correctness (confirmed source bugs)
- **Stale resume:** in `orchestrator.mjs`, decide staleness *before* `acquireLock()` (~176), or compare
  `lock.pid !== process.pid`. Today the `--resume` branch (~359) reads its own lock, so a run is never stale.
- **One recoverability table** in `pipeline/recovery.mjs` (new; small and pure): for each `haltReason` ×
  surface, the allowed verbs `resume | extend | revalidate | retry-stage | none`. The engine's `--resume`
  guard (~366), the supervisor's `resumableHalt` (~1224) and the dashboard affordances (ui-server ~275)
  all read it, so the supervisor can no longer send `--resume` for AGENT_ERROR when the engine
  rejects it (~1050, ~1035). Transient AGENT_ERROR and INTERRUPTED (including after a supervisor stop, ~1288) become resumable.
- **`--revalidate` path** (replaces hand-forged `status.json`): re-run `validateArtifactFile`
  (`artifacts.mjs:103`) and the checks. If they pass, move the run halted→`awaiting_chat` (host) or
  re-enter the stage (cli), and append a `recovered` event plus a `run.status` verb via `appendRunVerb`.
- **Uncaught-error path** (~1827): mark the running stage `failed`, set `haltReason: ENGINE_ERROR`,
  `haltTransient`, and write `handoff.md` through `compileHaltHandoff`.
- Tests: stale-resume, the supervisor↔engine verb contract (real engine, not fake-spawn args;
  extends `supervisor.test.mjs:336`), revalidate after a missing section.

### WP2 — Checker / regression truth
- Upstream petra's fix (petra `pipeline/checker.mjs` + `checker.test.mjs`, commit `7eac1e8`): sum every
  `# pass` / `# fail` TAP summary instead of `lastMatch`.
- When `passedCount` is `null`, skip the count-drop rule and record `counts: unknown`. This removes the
  `null < prev` comparison (`orchestrator.mjs` ~942).
- Rewrite the REGRESSION_BLOCKED message to state the facts without accusing the agent. Make checks
  async (`spawn`, `detached: true`) with a timeout that kills the process group (`checker.mjs:15`), and
  write `checker_report.md` / `test_history.json` atomically using the existing state.mjs atomic-write helper.

### WP3 — Pool resilience (biggest waste of finished work)
- **Ticket-level retry** `pool retry-ticket <featureId> <ticketId>` (pool-cli + `/api/pool/action`).
  It keeps committed tickets; `retryFeature` (`pool.mjs:555`) is kept for an explicit full replan.
- **Grace window before failing a feature:** a halted ticket that is recoverable under the WP1 table
  goes to `held` (an attention item) instead of failing the feature within 2 s (supervisor ~1132-1146).
  A run that reaches APPROVED during the hold is adopted, not discarded.
- `respawn()` (~1212) uses recorded `run.json` meta and refuses (raising an attention item) when
  `kind`/`brief` are unknown. Never default to `kind:'ticket'`.
- **Dismiss:** never overwrite `done`; clear dormant `meta.requests`; idempotent by run id; check engine
  liveness (`bridge.mjs` ~73-104).
- **Tick exceptions** (~1277) open a deduped `supervisor-error` attention item and back off, instead of
  retrying every 2 s in silence.
- **Validate early:** check ticket file scopes (`tickets.mjs` ~81 parser) at plan approval, and check the
  base ref exists on the remote at roadmap compile time.
- **Declared-scope check** at `commitTicket` (~381): an undeclared changed file is a warning attention
  item, not a silent conflict later on.
- If a PR already exists, adopt it (~745-750). A roadmap recompile keeps landed / done features
  (`roadmap.json` `orphans[]`).
- Serialize `roadmap.json` writes (supervisor tick vs `pool.mjs` ~523/562/586/594) through one
  `withControlLock` helper built on `acquireLockFile`.

### WP4 — Mode separation (implements the two axes above)
- Add `pipeline/mode.mjs`. Set `surface` once in the fresh-run path (`orchestrator.mjs` ~455-478, from
  `detectRunner` + `resolveExecutionSurface`). Old runs get `surface` derived from `executionSurface`
  (read-compat).
- `reconcileChatRunner` (`adapters.mjs` ~188) may coerce only an **unpinned** runner at creation, never
  an existing CLI run.
- ui-server-started runs always pass `--mode` and `--runner` explicitly and scrub host-detection env vars
  (`CLAUDECODE`, etc.) for CLI runs (~481-490, ~599). Continue/resume read the recorded surface.
- Add `policy.autonomy` to `newStatus` (`state.mjs` ~184). Gates (plan approval, halt handling, merge
  approval) consult `policyOf()`. Add a `set-autonomy` verb and endpoint that emit an audit event.
- Remove the `orchestrate.sh:283` heuristic and print the engine's resolved surface instead.

### WP5 — CLI runner hardening (latent, unused in the field)
- Spawn agents `detached` in their own process group. Stop, timeout and signal handlers
  (`orchestrator.mjs` ~277-294, `adapters.mjs` ~353-360) kill `-pgid` and wait. The "Stop" toast tells the truth.
- `retry.mjs`: classify on exit code, signal and the agent's own stderr/result envelope, not the last
  40 lines of combined log (which contain the agent's test output, e.g. `rejects_unauthorized_*`).
  Check timeout, 429 and 529 as transient **before** the fatal patterns.
- Add timeouts to git/gh/glab calls (`worktrees.mjs:21`, `repos.mjs:44`, `merging.mjs:88`, supervisor ~1309).
- Use the existing but unused `agentEnv` (`adapters.mjs` ~119) so agents don't inherit `GH_TOKEN`.
- Cursor auth probe: use a non-prompting check (`invocation.mjs` ~121); probe runners in parallel.

### WP6 — Chat/host reliability
- **Parked-run signal:** one deduped `awaiting-agent` attention item per `awaiting_chat` run
  (`attention.mjs` ~99), escalating with age (e.g. 10 min → 1 h → 4 h), and FIFO ordering in the agent queue.
  This reverses the accidental part of `473d579` without restoring the 111-item noise.
- **`--continue` pre-validates** the artifact (same path as bridge `stage.prepare`, `bridge.mjs` ~158). A
  missing section keeps the run in `awaiting_chat` with an exact "add section X to file Y" message instead
  of halting. This covers 5 of 7 field halts.
- **Bridge:** dashboard notes no longer silently enroll a run in the bridge (`ui-server` ~810 →
  `bridge.mjs` ~117), and the Continue endpoint carries completion credentials when a run is enrolled.
  Document the bridge protocol in `skills/orchestrate/SKILL.md`.
- **Guard command fix:** `node pipeline/pool.mjs status --json` → `pipeline/pool-cli.mjs` in SKILL.md,
  AGENTS.md, CLAUDE.md, GEMINI.md and the digest/catchup/notes/unattended skills. Add a test that fails if
  the referenced command prints nothing.
- **Halt hints:** use absolute run-dir paths in messages. Correct the MISSING_ARTIFACT hint (`handoff.mjs:12`)
  for host and pool runs, and remove the duplicated "Goal:" line.
- Record the host's reported model as `actualModel` (not the client name), with `modelSource: host-reported`.

### WP7 — Realtime, controllable UI + versioned API v1 (shared with Stage 2)
- **SSE with data:** `/api/v1/events` frames carry `id:` (a per-project monotonic cursor), `event:` and
  typed `data:` (`run.upserted`, `attention.upserted|resolved`, `decision.*`, `pool.updated`,
  `run.event{seq}`, `reset`). The server tails `events.jsonl` incrementally by byte offset and supports
  Last-Event-ID replay. Heartbeat every 15 s.
- **Narrow `fs.watch`** (ui-server ~121) to exclude `worktrees/**` and `node_modules`. Cheap
  `/api/v1/projects/:id/snapshot` + `runs/:id` + `events?afterSeq=` replace whole-state refetches.
  Keep `/api/state` for compatibility.
- **The server computes run status:** `bucket` (working / awaiting_agent / unattended / needs_you / blocked /
  done, promoted from `ui/runs.mjs`), `driver.presence`, and `actions[]` affordances
  `{id, label, enabled, disabledReason}` taken from the WP1 recoverability table. Web and desktop only render them.
- **Synchronous commands:** `POST /api/v1/projects/:id/commands {commandId, type, runId, args}` returns
  `applied | rejected | duplicate` with an error and the tail of `orchestrator.out`. It waits for the first
  status transition. Replaying the same `commandId` is idempotent, which fixes the 4× dismiss.
- **Missing controls:** plan approve/reject, a New Run form, an autonomy toggle, ticket retry,
  revalidate, and acknowledge/snooze. Fix the Extend body (`ui/api.mjs:52` `cycles` → `extend`) and
  drop the unknown `--handoff` flag (~501).
- **Idle shutdown** counts parked chat runs and connected SSE clients (~1038).
- **Security** (needed before a native client):
  - Host-header check on GET requests.
  - Reject `Origin: null` (`http-guard.mjs:46`; update `regression.test.mjs`).
  - Only registered projects may be used as `?project=`.
  - Bearer token on `/api/v1`, with a 0600 server registry at `~/.orchestrator/servers/<instanceId>.json`.
  - `/healthz` returns `instanceId`, `apiVersions` and `capabilities`.
  - `orchestrate.sh ui --ensure --json`.
- **JSON Schema** for v1 payloads in `pipeline/contract/v1/`. ui-server tests validate emitted payloads against it.

### WP8 — Reporting truth
- `parseReviewCoverage` (`report.mjs` ~140-155): accept `**E1 (…)**` / `E1 (…)` IDs, find the status
  column by its header, and accept verified/ok/pass. If coverage isn't measured, show "not measured" in
  grey, never red.
- `finalize` → `writeTerminalReport` (`orchestrator.mjs` ~598, `report.mjs` ~425) keeps the Reporter's
  diagrams and title.
- **Lineage:** `supersedes` / `supersededBy` on runs, in `runs.jsonl`, feature reports and `relatedRuns`.
- **Intervention log:** every human or out-of-band action (revalidate, dismiss, resolve-manually with a
  note, autonomy change, command provenance `via: web|desktop|chat|cli`) goes to the run events and the ledger.
- Per-stage surface, model (requested vs actual), cost with `source: measured|estimated|unknown`
  (Claude CLI `total_cost_usd` where available).
- Root `status.json` stays consistent, and `snapshot.supervisor.alive` is written false on exit.
- **Bridge journal compaction:** periodic snapshot + truncate, prune receipts, and stop
  `host-hooks.mjs:30` from registering a session on every tool call when no run is active.

### WP9 — Installer hygiene
- Detect stale, untracked engine copies (e.g. petra's 80 `.pipeline/*.mjs` files): `installer --check`
  flags them and `--apply` removes them after confirmation.
- The installer refuses to run while any run is parked or running (not only when the root lock is held,
  `installer.mjs` ~329). `pool reset` checks liveness and keeps worktrees that hold unmerged commits
  (`pool.mjs` ~668-699).

### WP10 — Field-failure regression suite ("flawless in both modes", made verifiable)
Add `pipeline/field-failures.test.mjs`. It reproduces each observed failure mode with the repo's existing
fake runners (`runtime.smoke.test.mjs` `customRunners`, `pool.integration.test.mjs` fake runner) and
writes no petra data into this repo. Each scenario runs on **both surfaces**: missing artifact section →
continue; multi-suite TAP counts; halt → hold → adoption; ticket retry keeps commits; dismiss of an
orphan/done run; tick exception → attention; parked host run → escalation; stale resume; supervisor
stop/restart → INTERRUPTED resume; CLI timeout with auth-like strings in the test output → transient.

**Sequencing:** WP2 → WP1 → WP6 → WP3 → WP4 → WP5 → WP8 → WP7 → WP9, with WP10 growing alongside each one.
WP7's contract is the Stage 2 gate.

---

# Stage 2 — Orchestrator Desktop (Rust / GPUI), spec + thin MVP

The app is **optional**: it is a native client of the Stage 1 `/api/v1` contract. Chat, CLI and the web
dashboard keep working without it, and the app never owns or kills `ui-server`.

### Architecture
- **`desktop/` at the repo root**, outside the scaffold's `COVERED_ROOTS`
  (`skills/orchestrate/scripts/scaffold-manifest.mjs`) and outside installer `MANAGED` (`installer.mjs:84`).
  - It has no dependencies in the root `package.json`, which is merged into consumer repos.
  - Releases are tagged **`desktop-v*`**, never `v*`, because `installer.mjs:289` resolves the skill's latest from `refs/tags/v*`.
  - Add tests asserting that `desktop/` is never managed or covered.
  - It gets its own path-filtered macOS CI job.
- **Rust workspace crates:**
  - `orch-contract`: serde types with `Unknown` fallbacks, checked against Stage 1's JSON Schema fixtures.
  - `orch-client`: discovery via `~/.orchestrator/servers/*` → `.pipeline/ui.url` → `/healthz`; bearer auth; commands with `commandId`; its own small SSE parser with Last-Event-ID; a private 2-thread tokio runtime that talks to the UI over `async_channel`.
  - `orch-core`: pure reducers, selectors and NotificationPolicy, with no IO and no GPUI.
  - `orch-app`: GPUI views plus a `platform/` layer for tray, notifications, dock badge, keychain and URL scheme.
- **GPUI pinning** (to verify in M0): crates.io `gpui` has been stale since 0.2.2. Pin the weekly Zed
  snapshot `gpui-pre =0.3.7` and the gpui-kit (formerly gpui-component) release built on the same
  snapshot. Never mix GPUI distributions. Wrap gpui-kit in our own `ui::` module, and upgrade in one
  monthly PR. Zed's GPL crates are reference only and are never copied.
- **Platform pieces:**
  - Tray: `gpui-tray`, or an objc2 NSStatusItem as fallback.
  - Notifications: `mac-usernotifications` (UNUserNotificationCenter; needs a signed .app with a bundle id; dev builds get in-app toasts).
  - Dock badge: `objc2-app-kit` NSDockTile.
  - Secrets: `keyring` v4.
  - Deep links: `orchestrator://open?project=&run=`, which **navigate only and never perform actions**.
  - Packaging: `cargo-packager` + codesign/notarize. No auto-update in M1, just a release banner.
- **AI assistant (M2), Vercel AI SDK v7 in a Node ≥22 sidecar** at `desktop/assistant/`, with its own lockfile.
  - The app spawns it and sends secrets on **stdin**, never env or disk.
  - It streams the AI SDK UI Message Stream over local SSE, which the Rust client parses and renders.
  - Providers come from `createProviderRegistry` only, and any model id without a `provider:` prefix is rejected so nothing falls back to AI Gateway by accident:
    - **BYOK** `@ai-sdk/anthropic|openai|google`
    - **local** `ai-sdk-ollama` and `createOpenAICompatible` for LM Studio
    - **AI Gateway**
  - Tools wrap `/api/v1`. Read-only tools need no approval; every mutating tool uses
    `toolApproval: 'user-approval'`, shown as a native approval card. Answers cite event `seq` numbers.
  - A per-project data-egress policy ("local models only" vs allowed cloud providers) asks for confirmation the first time a project uses a cloud provider.

### UX (borrowing from Orca, Conductor, Zed's agent panel, Claude Code desktop, Nimbalyst)
- **Layout:** a sidebar with the Inbox and Projects → Runs, using the unified status icons from the
  server `bucket` (working / waiting-on-agent / nobody-driving / needs-you / blocked / done); a center view;
  a right dock with Inspector and Assistant.
- **Tray:** "2 need you · 3 working", the top attention items, and "Pause all autonomy".
- **Attention inbox:** notifications are coalesced, with quiet hours, snooze and acknowledge (server-side, so
  escalation stops), a dock badge, and click-to-jump. Notified keys persist across relaunches. A notification never approves anything.
- **Run view:**
  - Header: surface chip, autonomy toggle, presence line ("Antigravity · checkpoint 2m ago" / "Nobody driving · 47m"), cost with its source, and server-provided actions with pending → applied/rejected feedback.
  - Stage rail Planner→Reporter showing model, mode, cycle and cost.
  - Tabs: Feed (threaded), Artifacts, Messages (delivery receipts), Logs.
  - Blocked runs list their remedies instead of requiring hand edits.
- **Plan approval and decision cards.** A Guided/Autonomous segmented control shows the effective policy.

### Milestones
- **M0 spike (go/no-go, about 1 week, macOS).** Pinned GPUI + gpui-kit + tray build; a signed .app with
  UNUserNotification click-through; dock badge; `on_open_urls`; keychain round-trip; SSE on the side
  runtime streaming into an Entity. If tray fails, fall back to objc2.
- **M1 (thin, macOS, after Stage 1's WP7):** discovery/attach/"Start server" (`orchestrate.sh ui --ensure`),
  add project, tray + badge, inbox + notifications, runs list, live run view, server-driven controls, plan
  and decision cards, autonomy toggle + panic button, deep links, "Open in web dashboard" for everything
  not yet native. Signed DMG `desktop-v0.1.0`.
  Exit criteria:
  - A parked stage shows in under 1 s.
  - A notification fires within its threshold + 5 s.
  - A week of petra dogfooding needs no state-file hand edits.
  - No duplicate commands.
  - The skill works with the app closed.
- **M2:** AI SDK assistant (BYOK + local + Gateway), diff viewer with line comments sent back as
  follow-ups, a Checks/merge-readiness panel, a self-moving roadmap board, native reports (lineage,
  interventions, per-stage cost), Sparkle auto-update, global hotkey.
- **M3:** optional Claude Agent SDK runner as a `customRunners` package `runners/claude-sdk/`
  (`adapters.mjs:271`), so the engine stays zero-dependency. It maps `canUseTool` to decision gates in guided
  runs and uses `setPermissionMode` when autonomy is toggled. Also: an ACP runner, per-stage checkpoints as
  git refs, Linux/Windows builds.

### Open items (decide before M1 ships)
App name and bundle id; signing identity (personal vs KTO Apple Developer account); whether the app may
start host-surface runs ("copy prompt for <host>"); assistant chat retention.

---

## Verification

**Stage 1**
1. `npm test` (all `pipeline/*.test.mjs` plus the new `field-failures.test.mjs`); `npm run test:browser`
   (Playwright `tests/browser/control-room.test.mjs`, extended for the new controls, command feedback,
   and SSE replay after reconnect); CI `node --check` + the dashboard freshness check.
2. Contract: ui-server tests validate every emitted v1 payload against `pipeline/contract/v1/*.schema.json`.
3. Dogfood on petra after reinstalling via `bootstrap.sh --update`, which also removes the stale `.pipeline/*.mjs` copy:
   - **Host:** a roadmap run under Antigravity or Claude Code chat. Deliberately omit an artifact section → the run stays awaiting_chat with a fix message. Park a stage → an attention item escalates. Dismiss → one click with feedback.
   - **CLI:** `--mode cli --runner claude` on one ticket. Stop it mid-stage → no orphaned processes (`pgrep`). Supervisor stop/start → INTERRUPTED resumes.
   - **Both:** no hand edits of state files; reports show real coverage, lineage and interventions.

**Stage 2**
1. `cargo test --workspace`: contract fixtures (recorded by `scripts/record-contract-fixtures.mjs` from
   fake-runner pipelines), proptest for the SSE parser, `insta` snapshots of reducers, NotificationPolicy with an injected clock.
2. Headless e2e on macOS CI (`orch-client` + `orch-core` against a real `ui-server` with a token):
   plan gate → approve → done; host park → presence absent → notify effect; stream kill → gapless resume;
   server restart → `reset` → re-snapshot; a duplicate `commandId` → `duplicate`.
3. Manual dogfood of M1 on petra, including quitting the app mid-run, with no regressions to the chat-only flow.

---

# Addendum: self-recovery and desktop history

## WP11: Self-recovery "Doctor" (Node, zero-dependency, extends WP1/WP6/WP8)

Each sub-step is its own PR, test first, with `scaffold.sha256` and the dashboard rebuilt as for every WP.

**R1: One complete recoverability table + honest audit trail** (extends WP1)
- Extend `pipeline/recoverability.mjs`:
  - Add the surface axis the header comment already promises.
  - Add entries for every halt reason the engine or supervisor can write, using the existing `halt()` call sites
    as the source list.
  - New verbs: `respawn` (dead engine), `reassign` (parked host, expired lease; `bridge.mjs` already has it),
    `restart-stage`, `acknowledge` (INTEGRITY_VIOLATION / REGRESSION_BLOCKED after review), `undismiss`,
    `pool-resume`.
- Make `ui/actions.mjs` and `ui-server.mjs:677` `extendRun` read the table. Add a contract test that every
  `haltReason` written anywhere has a table entry and a hint. `RESUME_HINTS` is generated from the table so it
  cannot drift.
- Surface `status.completionBlocked` in the halt handoff and in the run summary.
- Add the missing `recovered` event. Route auto-resume, auto-extend, ticket auto-retry, dismiss, dashboard
  resume and dashboard extend through `recordIntervention` (`interventions.mjs`), with `via` set to
  `self-heal|web|desktop|chat|cli`.

**R2: `pipeline/doctor.mjs`, pure `diagnose()`**
- Input: status, run meta, driver/lease, events tail, engine pid liveness, supervisor heartbeat, pool
  paused/stopped, attention, age in state.
- Output `{state, cause, explanation, evidence[], remedies[]}`:
  - `state` is one of `healthy | waiting | stalled | dead-engine | parked-no-host | held | halted-recoverable |
    halted-terminal | pool-stopped | pool-paused | supervisor-dead | unknown`.
  - `evidence` holds event `seq` numbers and file refs.
  - Each remedy is `{verb, safe, auto, reason}`, taken from the R1 table.
- It reuses `classifyRun` (`attention.mjs`), `driverOf` and `bucketOf` (`api-v1.mjs`), `recoveryFor`, and `compileHaltHandoff`.
- Expose it as `diagnosis` on the v1 `RunSummary` (schema in `pipeline/contract/v1/`), and as the CLI
  `bash .pipeline/orchestrate.sh doctor [--json]`. The web dashboard renders it. No app is needed.

**R3: `pipeline/self-heal.mjs`, safe auto-remedies + watchdogs** (extends WP3/WP6)
- Executor for autonomous runs: for each diagnosis, run the first `safe && auto` remedy, within per-run budgets
  stored in `run.json`:
  - Budgets: respawn 2, reassign 1, auto-resume 2, retry-ticket 1. Backoff comes from `retry.mjs`.
  - When a budget is exhausted: flip the run to guided, open one deduped attention item that carries the
    diagnosis, and stop. This is the circuit breaker.
- Watchdogs, hosted in the supervisor tick and in the ui-server's existing watch loop, so single-run projects
  are covered too:
  - Dead engine: after a short grace, `respawn` through the existing resume path.
  - Supervisor dead: compare `heartbeatAt` to a threshold. A server or desktop client that sees a stale
    heartbeat opens the `supervisor-dead` attention item.
  - Held ticket: after a timeout, one auto-retry, then escalate.
  - Pool paused: resurface hourly, using the existing `paused`/`held` resurface cadence.
  - Parked host (`awaiting_chat`): keep the 10 min / 1 h / 4 h escalation, and offer `reassign` once the lease expires.
- Add `orchestrate.sh doctor --fix` for one-shot repair in guided projects. It applies safe remedies after confirmation.

**Tests (WP10 extension, `pipeline/field-failures.test.mjs`, both surfaces)**
- Dead engine is respawned once and then escalated.
- Supervisor-dead is detected.
- A held ticket times out, retries once, then escalates.
- Parked host with an expired lease gets `reassign`.
- An unmapped state produces `unknown` with evidence, never silence.
- A budget-exhausted run flips to guided.
- Self-heal never emits `merge.approve` or `plan.approve`.
- Every halt reason has a table entry and a hint.


## WP12: History API v1 (extends WP7; the desktop DB's backfill source)

- `GET /api/v1/projects/:id/ledger?after=<cursor>`: `runs.jsonl` rows, including finished runs whose directory is gone.
- `GET /api/v1/projects/:id/events?after=<runId>:<seq>`: cross-run events. `seq` is already stable (the
  `events.jsonl` line number). Add an `epoch` that changes if the file is truncated or replaced, so clients detect rewrites.
- `GET /api/v1/projects/:id/history/{decisions,attention}`.
- `GET /api/v1/projects/:id/runs/:runId/log?stage=&tail=` for log excerpts.
- `GET /api/v1/projects/:id/runs/:runId/cost`: the existing `readTotalCost`/`readEventsByStage`.
- Attention snooze: add `attention.snooze {id, until}`, which suppresses escalation server-side.
  This closes the gap noted for M1, since only ack exists today.
- Add the new payloads to the JSON Schemas, and check them in the ui-server contract tests.


## Desktop track: history database and review (offloads the heavy lifting)

**D1: `orch-store` crate (SQLite, new workspace dep `rusqlite` with `bundled`, WAL)**
- Location: `$ORCHESTRATOR_HOME/desktop/history.sqlite`, never inside a repo. Migrations use `PRAGMA user_version`.
  It replaces `notified.json`; `notified.rs` is migrated once.
- Tables:
  - `connections`: instance_id, url, connected_at, disconnected_at, reason. **No tokens.**
  - `projects`, `runs` (current summary), `run_transitions` (bucket/stage/overall/halt/diagnosis over time).
  - `events` (PK project, run, seq), `commands` (commandId, kind, status, via), `interventions`.
  - `attention`, `decisions`, `diagnoses`, `log_excerpts` (last ~2 KB per stage, secret-scrubbed on write).
  - `cost`, `notifications`, `settings` (retention default 90 days). A prune job enforces the 90 days.
- Ingestion: one writer thread with batching, subscribed to the same `ClientEvent` stream `orch-app` already
  consumes, so the server sees no extra load. Writes are idempotent upserts.
- Backfill on connect: ledger, `events?after=` per run, decisions and attention history. This gives gapless
  history across periods when the app was closed or the server restarted.
- Layering: `orch-core` stays pure (it emits records). `orch-store` does the IO. `orch-app` reads through it.
- Review mode: the app opens and browses the DB with no server running.

**D2: Review views in `orch-app`** (the "Logs" tab and "native reports" from the spec)
- History: cross-project run timeline, filterable by bucket, halt reason, surface and date.
- Run review: replay events from the DB, diagnoses over time, interventions with their `via`, cost with its source.
- Connections log.
- Recovery panel: diagnosis cards with the server's remedy buttons, using the same pending → applied/rejected
  feedback and confirm-click rules as decisions.

**D3: Insights + plan/progress review**
- Insights: halt-reason frequency, mean time to recover, interventions per run, recurring failures.
  A reason hitting 3+ runs in 7 days becomes a "recurring failure" item that suggests a config change.
- Plan view: roadmap progress per project over time, from stored `pool.updated` snapshots.
  Per-run notes are stored in the DB.

**D4 (M2, opt-in): LLM triage** via the AI SDK sidecar already in the spec. It summarises only diagnoses with
`state: unknown`, using DB context. Mutating tools stay behind the approval card. Every fix is still a command.


## Where it fits in the existing plan

| Existing | Change |
|---|---|
| WP1 recovery | R1 completes the table; R2/R3 are the new WP11 |
| WP6 parked-run signal | R3 adds `reassign` and escalation-to-action |
| WP7 API v1 | WP12 adds history endpoints, snooze and the `diagnosis` field |
| WP8 intervention log | R1 makes every recovery path write one |
| WP10 field failures | extended with the scenarios above |
| Stage 2 M1 | finish: Projects→Runs tree, stage rail + tabs, tray, snooze (needs WP12) |
| Stage 2 M2 | D1–D3 land here as "History & Recovery"; D4 joins the assistant |
| Stage 2 M3 | unchanged |

**Sequence:** Step 0 → R1 → R2 → R3 → WP12 → D1 → D2 → D3 → (M1 finish, in parallel with D2) → D4 with M2.


## Verification

1. **Step 0:** `git log` shows the two commits. `cargo test --workspace` and `npm test` pass on the committed tree.
2. **R1–R3:** `npm test`, including the new field-failure scenarios on both surfaces and the "every halt reason has
   an entry and a hint" test. Manually: kill a CLI run's engine pid, and confirm `doctor` reports `dead-engine`
   and that an autonomous run respawns once. Then confirm it escalates to guided with an attention item and
   never silently stalls.
3. **WP12:** ui-server tests validate every new payload against `pipeline/contract/v1/*.schema.json`.
   Re-record the fixtures with `scripts/record-contract-fixtures.mjs`.
4. **D1:** `cargo test --workspace`:
   - Migration tests and idempotent re-ingest.
   - An e2e that backfills from a real `ui-server` after a simulated server restart, with no gaps and no duplicates.
   - A prune test for the 90-day retention.
   - An assertion that no bearer token is written to the DB.
5. **D2/D3:** run the app against a scratch project as done this session. Confirm the history survives an app
   restart, and review mode works with the server stopped.
6. **Isolation checks:** the skill passes its tests with the app absent. The app opens its DB with no server.
   The installer test still proves `desktop/` is never managed or covered.


## Critical files

- Node: `pipeline/recoverability.mjs`, `handoff.mjs`, `attention.mjs`, `supervisor.mjs`, `api-v1.mjs`,
  `ui-server.mjs`, `ui/actions.mjs`, `interventions.mjs`, `run-registry.mjs`, `pipeline/contract/v1/*`,
  `field-failures.test.mjs`, plus new `doctor.mjs` and `self-heal.mjs`.
- Desktop: `desktop/Cargo.toml`, new `crates/orch-store`, `orch-client` (backfill calls), `orch-core`
  (record emission), `orch-app` (views), `notified.rs` (migrated into the DB).
- Docs: `docs/superpowers/plans/2026-10-03-orchestrator-v4.md`,
  `docs/superpowers/specs/2026-10-03-self-recovery-and-history-design.md`, `desktop/README.md`, `docs/api-v1.md`.

