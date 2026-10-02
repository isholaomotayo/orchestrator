// /api/v1 — the versioned contract the web dashboard and the desktop app both
// consume. The server computes every judgement (which bucket a run is in, who
// is driving it, which actions are possible and why not); clients only render.
// Pure helpers plus a small event hub, so all of it is testable without HTTP.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { recoveryFor } from './recoverability.mjs';
import { surfaceOf, policyOf, readPolicyOverride } from './mode.mjs';
import { validateArtifactFile } from './artifacts.mjs';
import { STAGE_ARTIFACT_FILES } from './stages.mjs';

export const API_VERSION = 'v1';
export const CONTRACT = 'orchestrator-api.v1';
export const CAPABILITIES = ['runs', 'events.sse', 'events.replay', 'commands', 'autonomy', 'ticket-retry', 'resume-run', 'attention'];

// A host run waiting this long with nobody holding its lease is "unattended".
export const UNATTENDED_AFTER_MS = 30 * 60_000;
const QUIET_AFTER_MS = 2 * 60_000;
const STALLED_AFTER_MS = 10 * 60_000;

export function projectIdOf(repoRoot) {
  let real = repoRoot;
  try { real = fs.realpathSync(repoRoot); } catch { /* keep as given */ }
  return crypto.createHash('sha256').update(real).digest('hex').slice(0, 16);
}

function ageOf(iso, now) {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? now - t : null;
}

function waitingSince(status) {
  const row = (status?.stages || []).find((s) => s.name === status?.awaitingStage);
  return row?.startedAt || null;
}

/**
 * Who is driving the run right now.
 * @returns {{kind:'host-session'|'cli-process'|'none', host:string|null, presence:'active'|'quiet'|'stalled'|'absent', lastActivityAt:string|null, pid:number|null, leaseExpiresAt:string|null}}
 */
export function driverOf(status, { engineAlive = false, pid = null, owner = null, lastEventAt = null, now = Date.now() } = {}) {
  if (engineAlive && surfaceOf(status) === 'cli') {
    const age = ageOf(lastEventAt, now);
    const presence = age == null || age < QUIET_AFTER_MS ? 'active' : age < STALLED_AFTER_MS ? 'quiet' : 'stalled';
    return { kind: 'cli-process', host: status?.runner || null, presence, lastActivityAt: lastEventAt, pid, leaseExpiresAt: null };
  }
  if (status?.overall === 'awaiting_chat') {
    const leased = owner && Date.parse(owner.expiresAt) > now;
    if (!leased) return { kind: 'none', host: status.hostClient || null, presence: 'absent', lastActivityAt: owner?.lastActivityAt || null, pid: null, leaseExpiresAt: owner?.expiresAt || null };
    const last = owner.lastActivityAt || owner.lastCheckpointAt || null;
    const age = ageOf(last, now);
    const presence = age == null || age < QUIET_AFTER_MS ? 'active' : age < STALLED_AFTER_MS ? 'quiet' : 'stalled';
    return { kind: 'host-session', host: owner.host || status.hostClient || null, presence, lastActivityAt: last, pid: null, leaseExpiresAt: owner.expiresAt };
  }
  if (engineAlive) return { kind: 'cli-process', host: status?.runner || null, presence: 'active', lastActivityAt: lastEventAt, pid, leaseExpiresAt: null };
  return { kind: 'none', host: null, presence: 'absent', lastActivityAt: null, pid: null, leaseExpiresAt: null };
}

/** One status vocabulary for every UI. */
export function bucketOf(status, { engineAlive = false, driver = null, now = Date.now() } = {}) {
  if (!status?.overall) return 'unknown';
  if (status.dismissed) return 'done';
  switch (status.overall) {
    case 'done': return 'done';
    case 'halted': return 'blocked';
    case 'awaiting_plan_approval': return 'needs_you';
    case 'awaiting_chat': {
      if (driver?.kind === 'host-session') return 'agent_working';
      const age = ageOf(waitingSince(status), now);
      return age != null && age > UNATTENDED_AFTER_MS ? 'unattended' : 'awaiting_agent';
    }
    case 'running': return engineAlive ? 'working' : 'blocked';
    default: return 'unknown';
  }
}

function action(id, label, enabled, disabledReason = null, extra = {}) {
  return { id, label, enabled: !!enabled, ...(enabled ? {} : { disabledReason }), danger: 'none', ...extra };
}

/** Every action the server would accept for this run, with why not when disabled. */
export function actionsFor(status, { engineAlive = false, dir = null } = {}) {
  if (!status?.overall) return [];
  const out = [];
  const terminal = ['done', 'halted'].includes(status.overall);
  if (status.overall === 'awaiting_chat') {
    const stage = status.awaitingStage;
    const file = stage && STAGE_ARTIFACT_FILES[stage] && dir ? path.join(dir, STAGE_ARTIFACT_FILES[stage]) : null;
    const check = file ? validateArtifactFile(stage, file) : { ok: true };
    out.push(action('run.continue', `Continue after ${stage || 'stage'}`, check.ok,
      `${STAGE_ARTIFACT_FILES[stage] || 'the artifact'} is not ready: ${check.reason}`, { primary: true, params: { handoffId: status.handoffId || null } }));
  }
  if (status.overall === 'awaiting_plan_approval') {
    out.push(action('plan.approve', 'Approve plan', !engineAlive, 'the engine is running', { primary: true }));
    out.push(action('plan.reject', 'Request plan changes', !engineAlive, 'the engine is running', { params: { note: 'required' } }));
  }
  const recovery = recoveryFor(status, { engineAlive });
  if (status.overall === 'halted' || (status.overall === 'running' && !engineAlive)) {
    out.push(action('run.resume', 'Resume', recovery.resume && !engineAlive, recovery.reason || 'the engine is running', { primary: !!recovery.resume }));
    if (recovery.extend) out.push(action('run.extend', 'Extend cycles', !engineAlive, 'the engine is running', { params: { extend: 'integer' } }));
  }
  if (engineAlive) out.push(action('run.cancel', 'Stop run', true, null, { danger: 'confirm' }));
  if (!status.dismissed) out.push(action('run.dismiss', 'Dismiss', !engineAlive, 'stop the engine first', { danger: 'confirm' }));
  out.push(action('run.set_autonomy', 'Change autonomy', !terminal, `the run is ${status.overall}`, { params: { autonomy: ['guided', 'autonomous'] } }));
  out.push(action('message.queue', 'Send note to the active stage', !terminal && !!(status.awaitingStage || status.stages?.some((s) => s.status === 'running')), 'no stage is active'));
  return out;
}

/** The RunSummary every list and badge is built from. */
export function runSummary({ runId = null, status, dir, config = {}, engineAlive = false, pid = null, owner = null, lastEventAt = null, now = Date.now() }) {
  const driver = driverOf(status, { engineAlive, pid, owner, lastEventAt, now });
  const active = (status?.stages || []).find((s) => ['running', 'awaiting_host'].includes(s.status))
    || (status?.stages || []).find((s) => s.name === status?.awaitingStage) || null;
  const recovery = recoveryFor(status || {}, { engineAlive });
  const policy = policyOf(status, config, dir ? readPolicyOverride(dir) : null);
  return {
    runId,
    kind: status?.intent?.kind || null,
    featureId: status?.featureId ?? null,
    ticketId: status?.ticketId ?? null,
    title: String(status?.task || '').split('\n')[0].replace(/^\s*-?\s*\*\*Goal:\*\*\s*/, '').slice(0, 200),
    surface: status ? surfaceOf(status) : null,
    runner: status?.runner ?? null,
    hostClient: status?.hostClient ?? null,
    autonomy: policy.autonomy,
    policy,
    overall: status?.overall ?? null,
    bucket: bucketOf(status, { engineAlive, driver, now }),
    stage: active ? { name: active.name, status: active.status, cycle: active.cycle || 0, maxCycles: active.maxCycles || null, startedAt: active.startedAt || null } : null,
    driver,
    waitingSince: status?.overall === 'awaiting_chat' ? waitingSince(status) : null,
    handoffId: status?.handoffId ?? null,
    haltReason: status?.haltReason ?? null,
    haltClass: status?.overall === 'halted' ? (recovery.resume || recovery.extend ? 'recoverable' : 'terminal') : null,
    dismissed: !!status?.dismissed,
    startedAt: status?.startedAt ?? null,
    endedAt: status?.endedAt ?? null,
    actions: actionsFor(status, { engineAlive, dir }),
  };
}

/** A cheap signature: an upsert is only published when this changes. */
export function summarySignature(summary) {
  const { driver, ...rest } = summary;
  return JSON.stringify({ ...rest, presence: driver?.presence, driverKind: driver?.kind });
}

// ---- events ---------------------------------------------------------------

/**
 * Server-sent events with replay. Frame ids are "<instanceId>.<seq>": a client
 * reconnecting with Last-Event-ID gets every frame it missed, or a `reset`
 * (re-snapshot) when the id belongs to another server instance or has aged out
 * of the replay buffer.
 */
export function createEventHub({ instanceId = crypto.randomUUID(), capacity = 5000 } = {}) {
  let seq = 0;
  const ring = [];
  const clients = new Set();
  const encode = (frame) => `id: ${instanceId}.${frame.seq}\nevent: ${frame.type}\ndata: ${JSON.stringify(frame.data)}\n\n`;
  const wants = (client, frame) => !client.projects || !frame.data?.projectId || client.projects.has(frame.data.projectId);

  function publish(type, data) {
    const frame = { seq: ++seq, type, data };
    ring.push(frame);
    if (ring.length > capacity) ring.shift();
    for (const client of clients) {
      if (!wants(client, frame)) continue;
      try { client.res.write(encode(frame)); } catch { clients.delete(client); }
    }
    return frame;
  }

  function attach(res, { lastEventId = null, projects = null } = {}) {
    const client = { res, projects: projects ? new Set(projects) : null };
    res.write('retry: 2000\n\n');
    res.write(`event: hello\ndata: ${JSON.stringify({ instanceId, cursor: `${instanceId}.${seq}`, heartbeatMs: 15000, api: API_VERSION })}\n\n`);
    if (lastEventId) {
      const [inst, n] = String(lastEventId).split('.');
      const from = Number(n);
      const oldest = ring.length ? ring[0].seq : seq + 1;
      if (inst !== instanceId || !Number.isFinite(from) || from > seq) {
        res.write(`event: reset\ndata: ${JSON.stringify({ reason: inst !== instanceId ? 'server_restarted' : 'cursor_invalid' })}\n\n`);
      } else if (from < oldest - 1) {
        res.write(`event: reset\ndata: ${JSON.stringify({ reason: 'cursor_expired' })}\n\n`);
      } else {
        for (const frame of ring) if (frame.seq > from && wants(client, frame)) res.write(encode(frame));
      }
    }
    clients.add(client);
    return () => clients.delete(client);
  }

  function heartbeat() {
    for (const client of clients) {
      try { client.res.write(': ping\n\n'); } catch { clients.delete(client); }
    }
  }

  return { publish, attach, heartbeat, get size() { return clients.size; }, get cursor() { return `${instanceId}.${seq}`; }, instanceId };
}

/**
 * Incrementally tail a run's events.jsonl by byte offset. Returns only new,
 * complete lines, each with its 1-based line number as the run-local seq.
 */
export function createEventTail() {
  const offsets = new Map();
  return function readNew(file) {
    let stat;
    try { stat = fs.statSync(file); } catch { return []; }
    let state = offsets.get(file) || { offset: 0, line: 0 };
    if (stat.size < state.offset) state = { offset: 0, line: 0 }; // truncated/replaced
    if (stat.size === state.offset) return [];
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(stat.size - state.offset);
      fs.readSync(fd, buf, 0, buf.length, state.offset);
      const text = buf.toString('utf8');
      const end = text.lastIndexOf('\n');
      if (end < 0) return [];
      const out = [];
      for (const raw of text.slice(0, end).split('\n')) {
        state.line += 1;
        if (!raw.trim()) continue;
        try { out.push({ seq: state.line, event: JSON.parse(raw) }); } catch { /* torn line: skip */ }
      }
      state.offset += Buffer.byteLength(text.slice(0, end + 1));
      offsets.set(file, state);
      return out;
    } finally { fs.closeSync(fd); }
  };
}

// ---- commands -------------------------------------------------------------

export const COMMAND_TYPES = [
  'run.start', 'run.continue', 'plan.approve', 'plan.reject', 'run.resume', 'run.extend', 'run.cancel',
  'run.dismiss', 'run.set_autonomy', 'message.queue', 'decision.answer', 'ticket.retry', 'run.resume_in_pool',
  'merge.approve', 'merge.request_changes', 'feature.hold', 'feature.release', 'feature.skip', 'pool.pause', 'pool.resume',
  'attention.ack',
];

/**
 * Idempotent command execution: the same commandId always returns the first
 * result (a double-click is `duplicate`, never a second action). `handlers`
 * maps a command type to an (async) function returning { ok } or { error, code }.
 */
export function createCommandExecutor({ handlers, capacity = 2000 }) {
  const receipts = new Map();
  return async function execute(body = {}) {
    const { commandId, type } = body;
    if (!commandId || typeof commandId !== 'string') return { status: 'rejected', error: { code: 'bad_request', message: 'commandId is required', retryable: false } };
    const fingerprint = JSON.stringify({ type, runId: body.runId ?? null, args: body.args ?? {} });
    const prior = receipts.get(commandId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) return { commandId, status: 'rejected', error: { code: 'conflict', message: 'commandId was already used for a different command', retryable: false } };
      return { ...prior.result, status: 'duplicate', original: prior.result.status };
    }
    const handler = handlers[type];
    let result;
    if (!COMMAND_TYPES.includes(type) || !handler) {
      result = { commandId, status: 'rejected', error: { code: 'unknown_command', message: `unknown command type "${type}"`, retryable: false } };
    } else {
      try {
        const out = await handler(body);
        result = out?.error
          ? { commandId, status: 'rejected', error: { code: out.code === 409 ? 'conflict' : out.code === 404 ? 'not_found' : 'invalid', message: out.error, retryable: out.code === 409 }, ...(out.outputTail ? { outputTail: out.outputTail } : {}) }
          : { commandId, status: 'applied', result: out };
      } catch (err) {
        result = { commandId, status: 'rejected', error: { code: 'failed', message: err.message, retryable: false } };
      }
    }
    receipts.set(commandId, { fingerprint, result });
    if (receipts.size > capacity) receipts.delete(receipts.keys().next().value);
    return result;
  };
}
