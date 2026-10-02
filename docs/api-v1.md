# Orchestrator API v1

The dashboard server (`pipeline/ui-server.mjs`) exposes a versioned API at
`/api/v1`. The web dashboard and the desktop app both use it. The server
computes every judgement about a run: its status bucket, who is driving it,
and which actions are possible, with the reason when an action is not.
Clients only render what the server sends.

Schemas: `pipeline/contract/v1/*.schema.json`. `pipeline/contract.test.mjs`
checks the server's payloads against them.

## Find a server

```bash
bash .pipeline/orchestrate.sh ui --ensure --json
```

This reuses a running dashboard for the project, or starts one. It prints
`{url, port, instanceId, apiVersions, started}`.

Each running server also writes an owner-only (0600) record to
`${ORCHESTRATOR_HOME:-~/.orchestrator}/servers/<instanceId>.json`. The record
holds `{instanceId, port, pid, token, startedAt, apiVersions, serverVersion, url}`.
The server deletes the record when it exits. `GET /healthz` needs no token and
returns `instanceId`, `apiVersions`, `contract` and `capabilities`.

## Authentication and safety

- Every `/api/v1` request needs `Authorization: Bearer <token>`. EventSource
  clients that cannot set headers pass `?access_token=<token>` instead. The
  dashboard page receives the token in a `<meta name="pipeline-api-token">` tag.
- Every request must name a loopback `Host` on the server's own port, or the
  server returns 421. This blocks DNS rebinding.
- A POST with `Origin: null`, or with an origin other than this server, gets 403.
- `?project=` on the legacy routes accepts only registered projects. A project
  is registered by `POST /api/register` or `POST /api/v1/projects`. The server
  remembers registered projects across restarts in
  `${ORCHESTRATOR_HOME}/projects.json`.

## Read

| Route | Returns |
|---|---|
| `GET /api/v1/projects` | `{projects:[{projectId, repoRoot, name, install, capabilities, attention, defaults}]}` |
| `POST /api/v1/projects {repoRoot}` | Registers a project (it must already have `.pipeline/`) |
| `GET /api/v1/projects/:projectId/snapshot` | `{cursor, project, runs:[RunSummary], attention, decisions, pool}` |
| `GET /api/v1/projects/:projectId/runs/:runId` | `{run: RunSummary, status, artifacts:[{name,size,updatedAt}]}`. Use `runId` `root` for a single-run (v1) project |
| `GET /api/v1/projects/:projectId/runs/:runId/events?afterSeq=&limit=` | `{events:[{seq, …}], nextSeq, hasMore}`. `limit` is at most 500 |

A **RunSummary** contains `bucket`, `driver`, `actions` and the fields below.

- `bucket` is one of:
  - `working`: a CLI engine is running.
  - `agent_working`: a host session holds the lease.
  - `awaiting_agent`: parked, waiting for a chat agent.
  - `unattended`: parked for more than 30 minutes with nobody driving.
  - `needs_you`: a plan is awaiting approval.
  - `blocked`, `done`, `unknown`.
- `driver` is `{kind: host-session|cli-process|none, presence: active|quiet|stalled|absent, …}`.
- `actions` is a list of `{id, label, enabled, disabledReason?, primary?, danger, params?}`.
  Action ids are command types, so a client can show exactly the buttons the
  server would accept.
- The other fields are: `surface` (`host`|`cli`), `autonomy`, `policy.effective`,
  `stage`, `waitingSince`, `handoffId`, `haltReason`, `haltClass`
  (`recoverable`|`terminal`).

## Live events

`GET /api/v1/events?projects=<id>,<id>` is a server-sent event stream.

- Every frame has an `id:` of the form `<instanceId>.<seq>`.
- To resume after a disconnect, reconnect with `Last-Event-ID` (or
  `?lastEventId=`). The server replays every frame you missed.
- If the id belongs to another server instance, or is older than the replay
  buffer, the server sends `event: reset` instead. Fetch a fresh snapshot
  when that happens.
- A `: ping` comment arrives every 15 seconds.

| Event | Data |
|---|---|
| `hello` | `{instanceId, cursor, heartbeatMs, api}` |
| `run.upserted` | `{projectId, run: RunSummary}`. Sent only when the summary changed |
| `run.event` | `{projectId, runId, seq, event}`. One per new `events.jsonl` line; `seq` matches the backfill route |
| `attention.updated` | `{projectId, items}`. The pending attention list |
| `pool.updated` | `{projectId, snapshot}` |
| `reset` | `{reason: server_restarted\|cursor_expired\|cursor_invalid}` |

## Commands

`POST /api/v1/projects/:projectId/commands`, with body:

```json
{ "commandId": "<client uuid>", "type": "run.continue", "runId": "<runId|root>", "args": {}, "client": { "kind": "desktop" } }
```

It returns `{commandId, status: applied|rejected|duplicate, result?, error?: {code, message, retryable}, outputTail?, cursor}`.

- **Idempotent.** Sending the same `commandId` again returns the first result
  with `status: "duplicate"`. A double-click is never a second action.
- **Synchronous.** A command that starts the engine waits for the engine's
  first move. If the engine refuses quickly (for example, a resume the
  recoverability table rejects, or a stale continue), the result is
  `rejected` and carries the engine's own reason and an output tail.
- **Types:** `run.start`, `run.continue` (`args.handoffId`), `plan.approve`,
  `plan.reject` (`args.note`), `run.resume`, `run.extend` (`args.extend`),
  `run.cancel`, `run.dismiss`, `run.set_autonomy` (`args.autonomy`),
  `message.queue` (`args.stage`, `args.text`), `decision.answer`,
  `ticket.retry` (`args.featureId`, `args.ticketId`), `run.resume_in_pool`,
  `merge.approve`, `merge.request_changes`, `feature.hold|release|skip`,
  `pool.pause|resume`, `attention.ack`.
- **Merging is irreversible.** Only send `merge.approve` after a human has
  explicitly agreed.
