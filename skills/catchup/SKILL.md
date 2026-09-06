---
name: catchup
description: Recap what happened while the user was away and what is still waiting on them. Use at the start of a session, when the user asks "what did I miss", or invokes /catchup.
when_to_use: A session starts against a project with an orchestrator pool, or the user asks what they missed or what is outstanding.
allowed-tools: Bash(node pipeline/pool.mjs *) Bash(bash .pipeline/orchestrate.sh pool *) Read
---

# Catch up

Answer one question: **what, if anything, needs this person now?**

## How

```bash
bash .pipeline/orchestrate.sh pool status --json
bash .pipeline/orchestrate.sh pool attention --pending --json
```

## What to say

- If nothing is pending and nothing is stuck: one line. "Nothing is waiting for
  you." Do not pad it.
- Otherwise, lead with the oldest thing waiting on a decision, because that is
  what has been blocking longest. Then anything that landed since, then anything
  stuck.
- For each open item, name the command that resolves it.

Never answer a decision here, and never mark an item acknowledged on the user's
behalf — acknowledging something they have not seen destroys the only record
that it was still outstanding.
