---
name: digest
description: Show the current state of a roadmap run in four sections — what needs your decision, what is in progress, what recently landed, and what is up next. Use when the user asks for status, "where are we", "what is running", or invokes /digest.
when_to_use: The user asks about the state of an orchestrator pool or roadmap run, or types /digest.
allowed-tools: Bash(node pipeline/pool.mjs *) Bash(bash .pipeline/orchestrate.sh pool *) Read
---

# Digest

Report the pool's current state. **Read it from the snapshot; never from
memory.** A digest that describes a run as it was ten minutes ago is worse than
no digest, because it will be believed.

## How

```bash
bash .pipeline/orchestrate.sh pool status --json
```

That one command is the source of truth. Do not reconstruct state by reading
`runs/*/status.json` yourself — the snapshot already resolves what is live, what
is stale, and what is waiting.

If it reports no roadmap, say so plainly and stop: there is nothing to digest.

## What to say

Render exactly four sections, in this order, using the snapshot's own fields:

1. **Needs your decision** — `needsDecision`. For each, give the question, which
   feature and run it belongs to, and the exact command that answers it. If an
   item has no `decisionId`, it is a stuck feature or a bare escalation: say what
   is stuck and what would unstick it, and do not invent a decision id.
2. **Recently landed** — `recentlyLanded`. Name the feature, and link its pull
   request and report when it has them.
3. **In progress** — `inProgress`. One line per run: which ticket, which stage.
   Say plainly when a run is `stale` ("quiet for a long time") or `dead` ("the
   worker process is gone") — these are the two states most worth interrupting
   someone over.
4. **Up next** — `upNext`, with what each item is waiting on.

Then, only if there is something to add: if `supervisor.alive` is false, nothing
will advance and the operator needs to know. If any entry in `skills` is not
`verified`, that capability is silently unavailable — name it and give the pin
command.

## Boundaries

- The script owns what is true; you own how it reads. Never edit control files.
- Do not answer a decision inside this skill. Report it; the operator decides.
- Use the operator's vocabulary: "worker", "feature", "waiting on you" — not
  internal state names like `integrating` or `awaiting_merge_approval`.
