---
name: unattended
description: Set or explain the policy for what may be handled without the operator while they are away, and what must wait for them. Use when the user says they are stepping away, asks what can run unattended, or invokes /unattended.
when_to_use: The user is leaving a roadmap run going and wants to say what may proceed without them.
allowed-tools: Bash(node pipeline/pool.mjs *) Bash(bash .pipeline/orchestrate.sh pool *) Read Write(.pipeline/control/notes/*)
---

# Unattended

The pool keeps running when nobody is watching; the question is what it may do
without asking. This skill records that, and applies it when draining.

## Recording the policy

Confirm the boundary with the operator in their own words before writing it
down, then record it as a note (`/notes`, kind `decision`) so the next session
inherits it rather than guessing.

## The default boundary

**Handle without asking** — things that are reversible and already gated by
something else:

- reporting status, acknowledging items that have been surfaced;
- extending a cycle budget on a run that halted with `MAX_CYCLES`, once;
- retrying a run that halted with a transient agent error.

**Always wait for the operator** — things that are hard to undo, or where being
wrong is expensive:

- **any merge**, even an approved-looking one. Merging is the one irreversible
  step, and `merge.autoMerge` exists for operators who have explicitly chosen it;
- anything touching authentication, payments, data deletion, or schema
  migrations;
- a `BLOCK` verdict, or a review that was not approved;
- a regression halt or an integrity violation — both mean a guardrail fired, and
  a guardrail that fires unattended should stop the line;
- any decision with no recommended option, because the planner did not consider
  it obvious either.

## While away

Keep a record rather than a running commentary: when the operator returns they
want the list of what happened and what is still waiting, which is exactly what
`/catchup` gives them. Do not batch-acknowledge open items to make the list look
shorter — the list is the point.
