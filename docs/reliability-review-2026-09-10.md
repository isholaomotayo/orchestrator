# Reliability handoff review — 10 September 2026

Reviewed the seven commits from `9d4218c` through `96a7716` against the reliability plan and the supplied session handoff. The mandatory Handoff/Reporter stages and visible disabled actions are retained. Petra was not modified.

## Standards and integration review

No general coding-standard violations were established. Four concrete integration and interaction defects were found and repaired:

1. **Codex/Cursor hook invocation.** Their generated entries used a separate `args` field although their documented interface takes a shell command. The installer now emits quoted command strings for these hosts. Tests execute the installed commands with stdin and project paths containing spaces, quotes, and shell substitutions. Reinstallation repairs old bridge entries while preserving user hooks. Sources: [Codex hooks](https://learn.chatgpt.com/docs/hooks), [Cursor hooks](https://prod.cursor.com/docs/hooks). Claude retains its documented exec form: [Claude command hooks](https://code.claude.com/docs/en/hooks#command-hook-fields).
2. **Malformed settings preservation.** Installing or uninstalling previously treated unreadable or invalid existing JSON as an empty configuration and could replace unrelated settings. Only a missing file now means empty configuration. Malformed JSON and non-object settings fail without changing the original bytes; successful writes use atomic replacement.
3. **Stale roadmap approval recovery.** Target movement previously returned to final review with the same stale evidence, making subsequent approvals fail repeatedly. It now creates an isolated combined validation attempt from the current target and accepted working branch. Successful validation updates the working branch with an expected-SHA check and opens a fresh human approval. Missing inputs, conflicts, and worktree/commit failures retain their artifacts and expose blockers. Target movement during validation supersedes that attempt rather than accepting its evidence.
4. **Runs search focus.** Rendering search results recreated the input on each keystroke. The view now retains its controls during ordinary filtering and refreshes. A Chromium interaction test covers typing, retained focus, background refresh, failed API responses, recovery, and clearing filters. CI now installs Chromium and runs this suite.

## Specification review

Three bridge contract defects were reproduced in disposable fixtures and repaired:

1. **Release bypass.** Releasing a claimed run removed the only signal that completion needed bridge validation. Protocol enrollment now persists separately from the current owner. Claiming a run or queuing a priority instruction enrolls it; release cannot undo that enrollment. A subprocess test verifies that bare engine continuation fails after release and leaves the message queued. The handoff's compatibility behavior for unclaimed runs without priority instructions is retained.
2. **Lease expiry during verification.** Final completion now rechecks the lease inside the inbox transaction. Expired credentials cannot commit even when they passed an earlier check; the old run status remains available for reconnect.
3. **False delivery from telemetry.** Antigravity telemetry hooks could mark messages delivered while returning no agent context. Reporting now records activity without delivering the inbox; the next injection-capable checkpoint supplies the messages and records delivery.

An additional journal recovery defect was found locally: valid JSON without a terminating newline was read as committed even though the next transaction discarded it. Readers and writers now share the same newline-terminated commit boundary. Regression coverage verifies both the state and idempotency receipt remain uncommitted.

## Verification

- Full regression suite: **704 passed, 0 failed**, with localhost listening permitted and Git signing disabled only for disposable fixtures.
- A subsequently added engine subprocess regression also passed; the focused bridge suite is **32/32**. The repository now contains **705 unit/integration tests**.
- Chromium interaction suite: **1 passed**, exercising several browser transitions against the shipped bundle and a controlled local API.
- Syntax checks, dashboard bundle freshness, and `git diff --check` passed.
- CI now explicitly disables fixture Git signing, installs Chromium, and runs the browser suite.

The initial sandboxed run passed 660 tests and failed 30 HTTP tests solely because localhost listeners were denied. The successful full run above supersedes that result.

## Remaining release evidence

This is a review-and-repair result, not complete release sign-off:

- Real UI-to-context-to-acknowledgment-to-disposition sessions in all four host applications have not been demonstrated. Executing generated hook commands proves their invocation contract, not host lifecycle delivery or installed-version support.
- Full cross-file crash-injection and lock-contention acceptance remains outstanding. In particular, run-status projection and bridge-journal persistence still span separate writes; this pass does not establish an atomic crash boundary across both. The shared command layer also does not yet cover every scheduler/control mutation.
- The compatibility path still allows unclaimed new runs without priority messages to use plain continuation. That follows the supplied implementation handoff, but differs from the original plan's strict enrollment requirement for all new managed chat runs.
- Browser coverage is now in CI but is not yet the complete original acceptance matrix (all host reconnects, project isolation, every control action, and upgrade/rollback scenarios).
- No version was cut, no release/scaffold trust hashes were regenerated, and no consumer was upgraded.
