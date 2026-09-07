# Roadmap mode: a guide

Roadmap mode runs a list of features instead of one task. It splits each
feature into tickets, builds the tickets at the same time, merges them, and
reviews the whole feature before anything reaches your base branch. A
supervisor manages this. You review and approve.

This guide explains what changed, and how to use it.

## What changed

Roadmap mode used to need a signed-in agent CLI (Claude, Codex, Cursor, or
Gemini) on your machine, even for a single ticket. It no longer does.

Each feature, and each ticket inside it, now picks its own runner. The
default is `auto`. `auto` picks a signed-in CLI if one exists. If none does,
it falls back to `host`.

A `host` ticket starts no process. It waits for you to do the work in this
chat, the same way a single task already works. So a roadmap now runs from
start to finish with no CLI signed in anywhere. You do the work, one stage
at a time, and tell it to continue.

## Building a whole product

To have a long list of features run start to finish — plan, build, test,
accept, next — and review once at the end, set `review: end` in the
frontmatter:

```markdown
---
title: Acme platform
base: main
merge: pr
review: end
---
```

Each feature still goes through Planner → Coder → Tester → Reviewer. When a
feature is `APPROVED`, it is accepted onto a working branch
(`pipeline/roadmap/<slug>`) and the next feature starts from that commit. The
base branch does not move. When the list is done, the digest asks you to land
the working branch:

```bash
bash .pipeline/orchestrate.sh pool land-roadmap
# or: bash .pipeline/orchestrate.sh pool approve-merge
```

That is the one irreversible step. Walk-away unattended runs need an
authenticated CLI (`- runner: claude` / `cursor` / `codex` / `antigravity` on a
feature, or one on PATH with `auto`). Without one, `review: end` still works
as attended `claim-run` items.

Default `review: feature` is unchanged: every feature waits for
`pool approve-merge <featureId>` before the next one starts.

## The four words you need

- **Roadmap** — the list of features, written in `roadmap.md`.
- **Feature** — one item on the roadmap. Features run in order.
- **Ticket** — one slice of a feature. Tickets inside a feature run together.
- **Runner** — who does the work for a run: a signed-in CLI, or `host` (you,
  in this chat).

## Quick start

1. Write `.pipeline/roadmap.md`. List your features, each with a
   description and an acceptance list.
2. Compile it, so mistakes surface now, not mid-run:
   ```bash
   bash .pipeline/orchestrate.sh roadmap compile
   ```
3. Start it:
   ```bash
   bash .pipeline/orchestrate.sh --roadmap .pipeline/roadmap.md
   ```
4. From here, read the digest each turn:
   ```bash
   bash .pipeline/orchestrate.sh pool digest
   ```
5. Act on what it shows you. The digest has four parts: what needs you,
   what just landed, what is running, and what comes next.

## Picking a runner

Leave `runner` unset unless you have a reason to change it. `auto` is the
right choice for almost everyone: it uses a CLI when you have one, and
falls back to `host` when you don't.

Set it only when you want to force a choice for one feature:

```markdown
## F2: Invoice PDF export
- depends_on: F1
- runner: host
### Description
Render an invoice as a PDF.
```

- `runner: host` — no CLI needed. You do the work, in this chat.
- `runner: claude` (or `cursor`, `codex`, `antigravity`) — runs unattended, on a
  signed-in CLI, in the background. Use this when you want a feature to
  build itself while you do something else.

A roadmap can mix both. One feature can wait for you; another can run on
its own.

## Claiming a run

When a `host` ticket is ready for you, the digest shows a `claim-run` item.
Claim it:

```bash
bash .pipeline/orchestrate.sh pool claim <runId>
```

This prints the stage you need to do, the brief, and the exact command to
run next. Do the work, then run that command:

```bash
bash .pipeline/orchestrate.sh --continue --run-id <runId>
```

Repeat until the run is done. Each ticket may ask for a few stages in turn
(write the code, write the tests, review the work).

## Everyday commands

| You want to | Run |
|---|---|
| See the status | `pool digest` |
| Pick up a run waiting for you | `pool claim <runId>` |
| Answer a question | `pool decide <decisionId> "<answer>"` |
| Approve a plan | `pool approve-plan <runId>` |
| Approve a merge | `pool approve-merge <featureId>` |
| Land a `review: end` roadmap | `pool land-roadmap` (or `pool approve-merge` with no feature id) |
| Retry a failed feature | `pool retry <featureId>` |
| Ask for changes | `pool request-changes <featureId> "<text>"` |
| Give a run more cycles | `pool extend <runId> <n>` |

Prefix each with `bash .pipeline/orchestrate.sh`.

Nothing reaches your base branch without your approval. A merge always
waits for `pool approve-merge`, even after a review passes — unless you set
`review: end`, in which case per-feature merges are deferred and only the
final `pool land-roadmap` (or `pool approve-merge` with no feature id)
lands onto `base`.

## If you have no CLI signed in

Roadmap mode still works. Every run falls back to `host`. You will see more
`claim-run` items, since nothing runs unattended, but nothing is blocked
and nothing fails. Set a feature's runner to a CLI name only when you
actually want it to build on its own.
