# Orchestrator Desktop

An **optional** native macOS companion for the `/orchestrate` skill, built with
[GPUI](https://www.gpui.rs) (snapshot crate `gpui-pre`). It is a client of a
project's dashboard server (`/api/v1`, see [../docs/api-v1.md](../docs/api-v1.md)).
It never reads `.pipeline/` files itself, and it never starts or stops runs on
its own. The skill behaves the same whether the app is open or closed.

The installer never copies this directory into consumer projects;
`pipeline/installer.test.mjs` checks that.

## Build and run

You need Rust 1.93 or later. GPUI uses `slice_as_array`, so earlier versions fail.

```bash
cd desktop
cargo run -p orch-app                 # development window
./packaging/bundle-macos.sh           # target/Orchestrator.app, ad-hoc signed
```

The app attaches to a running dashboard. It finds one through
`~/.orchestrator/servers/*.json`, a record every server writes for itself. If
no server is running, the app lists the projects it knows about and offers to
start a dashboard for one. It does that by running
`bash .pipeline/orchestrate.sh ui --ensure`.

macOS only delivers system notifications to an app launched from a bundle,
which is why `bundle-macos.sh` exists. To sign for distribution, set
`SIGN_IDENTITY="Developer ID Application: …"` before running the script.

## Crates

| Crate | What it does |
|---|---|
| `orch-contract` | The `/api/v1` types, mirroring `pipeline/contract/v1`. Every enum has an `Unknown` variant, so a newer server never breaks an older app. |
| `orch-client` | Server discovery, typed REST calls and commands, an SSE parser, and an event stream that resumes with `Last-Event-ID`. It runs on its own tokio runtime and talks to the UI through channels. |
| `orch-core` | Pure state, with no IO and no GPUI: the reducer, the notification policy, the badge count, inbox ordering and the activity feed. |
| `orch-app` | The GPUI window. |

## Tests

```bash
cargo test --workspace     # includes an e2e test against a real ui-server (needs node)
node ../scripts/record-contract-fixtures.mjs   # re-record server payloads into tests/contract/fixtures
```

The contract tests parse payloads recorded from a real server. If the Node
side changes its output, re-recording the fixtures will show the difference in
`git diff`, and CI fails until the fixtures are updated.

## M1 scope (this milestone)

- An inbox ordered by who needs a person: waiting on you, nobody driving,
  blocked, waiting for an agent, then working.
- A run view showing surface, autonomy, driver presence, stage and halt reason.
- A live activity feed.
- Action buttons built from the server's `actions[]`:
  - A disabled button shows the server's reason.
  - A destructive action needs a confirming second click.
  - Clicking twice never sends a command twice, because commands carry a `commandId`.
  - Actions that need free text open the web dashboard instead.
- Native notifications for state changes that need a person. Each one is shown
  once, including across relaunches, and clicking it opens the run.
- The attention count in the window title.
- `orchestrator://open?project=<id>&run=<id>` deep links. A deep link only
  selects a run; it never performs an action.

Later milestones, in the order planned:

- **M2:** a menu-bar icon and dock badge, an assistant panel using the Vercel
  AI SDK in a Node sidecar (your own API keys, local models, or AI Gateway,
  with approval required for every action), a diff viewer with line comments,
  a self-updating roadmap board, and auto-update.
- **M3:** a Claude Agent SDK runner and an ACP runner, checkpoints, and Linux
  and Windows builds.
