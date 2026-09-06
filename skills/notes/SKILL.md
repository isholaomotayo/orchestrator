---
name: notes
description: Record a durable note about a project — a learning, a decision and why it was made, or a gotcha worth warning the next person about. Use when the user says "remember this", "note that", or invokes /notes.
when_to_use: The user wants something recorded durably about how a project works or why a choice was made.
allowed-tools: Bash(node pipeline/pool.mjs notes *) Bash(bash .pipeline/orchestrate.sh pool notes *) Read
---

# Notes

Write down what a future session would otherwise have to rediscover.

## How

```bash
bash .pipeline/orchestrate.sh pool notes add "<the note>" --kind learning|decision|gotcha [--run <runId>] [--feature <featureId>]
```

Notes land in `.pipeline/control/notes/` as dated markdown with provenance, and
are meant to be committed.

## What is worth a note

- **decision** — a choice and the reason for it, especially one that looks
  arbitrary from the outside ("money is stored in integer pence because…").
- **gotcha** — something that will bite the next person ("the migration must run
  before the backfill or the unique index fails").
- **learning** — a recurring failure and what fixed it.

## What is not

Anything already recorded elsewhere. A note that restates a specification, a
review, or a commit message adds noise and ages badly. Reference the artifact
instead.

Keep each note to a few sentences, in plain language, and never include a
secret, token, or credential — reference where it lives instead.
