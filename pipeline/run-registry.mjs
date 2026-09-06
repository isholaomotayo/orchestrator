// The run registry: identity, metadata and the append-only verb log that make
// many concurrent runs legible to the supervisor, the dashboard and a human.
//
// Three separate records per run, deliberately:
//   run.json    — mutable facts the supervisor owns (branch, pid, phase, PR)
//   run.status  — an append-only verb log; the durable story of what happened
//   status.json — the stage machine the orchestrator already writes
// The verb log is the one both the orchestrator and the supervisor append to,
// so its lines stay short and single-line: O_APPEND writes under PIPE_BUF are
// atomic on POSIX, which makes two writers safe without a lock.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { atomicWrite, appendLine } from './state.mjs';

export const RUN_META_CONTRACT = 'orchestrator-run-meta.v1';

// The complete, closed set of run verbs. A typo must fail loudly rather than
// invent a state nothing downstream knows how to classify or clear.
export const RUN_VERBS = [
  'working',        // the run is executing a stage
  'needs-decision', // parked on a question only the operator can answer
  'blocked',        // cannot proceed without intervention
  'paused',         // a declared external wait
  'held',           // the operator is holding this deliberately
  'resolved',       // a decision was answered; the run may continue
  'done',           // finished successfully
  'failed',         // finished unsuccessfully
  'landed',         // the work reached the base branch
  'note',           // informational; never an open item
];

// Verbs that mean "someone must look at this" — used by the supervisor's
// classifier and by the digest to build the "Needs your decision" section.
export const ATTENTION_VERBS = ['needs-decision', 'blocked', 'held'];
// Verbs after which the run will never move on its own.
export const TERMINAL_VERBS = ['done', 'failed', 'landed'];

const RUN_ID_RE = /^[\w.-]+$/;

// Keep ids to the character class the UI server already accepts for run dirs
// (ui-server.mjs runDir), so a new run is browsable with no UI change.
function sanitizeSegment(value, fallback) {
  const cleaned = String(value ?? '').replace(/[^\w.-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '').slice(0, 24);
  return cleaned || fallback;
}

/**
 * A run id that is unique, path-safe, and sorts chronologically as a string —
 * so `ls` and the dashboard's run list are in run order for free.
 * Shape: 20260906T070512Z-F1-T02-3f9a
 */
export function newRunId({ featureId = null, ticketId = null, kind = 'ticket', now = new Date() } = {}) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const parts = [stamp];
  if (featureId) parts.push(sanitizeSegment(featureId, 'f'));
  parts.push(sanitizeSegment(ticketId || kind, 'run'));
  // 4 bytes, not 2: a run id collides only if two runs share a directory, which
  // silently merges two runs' state. At 2 bytes the birthday bound puts a
  // collision within reach of a busy pool; at 4 it is ~1 in 4 billion per pair.
  parts.push(crypto.randomBytes(4).toString('hex'));
  return parts.join('-');
}

export function isValidRunId(runId) {
  if (typeof runId !== 'string' || !runId || runId === '.' || runId === '..') return false;
  return RUN_ID_RE.test(runId);
}

/**
 * Write (or merge into) this run's meta record. Merging matters: the supervisor
 * updates one field at a time as a run progresses, and a whole-record write
 * would silently drop facts recorded by an earlier tick.
 */
export function writeRunMeta(paths, patch) {
  if (!paths.runMeta) return null;
  const current = readRunMeta(paths) || {
    contract: RUN_META_CONTRACT,
    runId: paths.runId,
    featureId: null,
    ticketId: null,
    kind: 'ticket',
    mode: 'build',
    branch: null,
    baseBranch: null,
    baseRef: null,
    worktree: null,
    brief: null,
    runner: null,
    pid: null,
    spawnedAt: new Date().toISOString(),
    attempts: 1,
    phase: 'spawned',
    committedSha: null,
    pr: null,
    notes: [],
  };
  const merged = { ...current, ...patch, contract: RUN_META_CONTRACT };
  atomicWrite(paths.runMeta, JSON.stringify(merged, null, 2));
  return merged;
}

export function readRunMeta(paths) {
  if (!paths.runMeta) return null;
  try { return JSON.parse(fs.readFileSync(paths.runMeta, 'utf8')); } catch { return null; }
}

/**
 * Append one event to the run's verb log. A run-less (v1) path set has no log,
 * so this is a no-op there and callers need no mode check.
 */
export function appendRunVerb(paths, verb, detail = '') {
  if (!RUN_VERBS.includes(verb)) throw new Error(`Unknown run verb "${verb}".`);
  if (!paths.runStatusLog) return;
  // One event is always exactly one line, so a partial read can never merge
  // two events into one nor split one across two.
  const flat = String(detail).replace(/\s*\n+\s*/g, ' · ').trim();
  appendLine(paths.runStatusLog, `${new Date().toISOString()} ${verb}:${flat ? ` ${flat}` : ''}`);
}

const LOG_LINE_RE = /^(\S+)\s+([a-z-]+):\s?(.*)$/;

export function parseStatusLog(text) {
  const entries = [];
  for (const line of String(text || '').split('\n')) {
    const match = LOG_LINE_RE.exec(line.trim());
    if (!match) continue;
    const [, ts, verb, detail] = match;
    if (!RUN_VERBS.includes(verb)) continue;
    entries.push({ ts, verb, detail });
  }
  return entries;
}

export function readStatusLog(paths) {
  if (!paths.runStatusLog) return [];
  try { return parseStatusLog(fs.readFileSync(paths.runStatusLog, 'utf8')); } catch { return []; }
}

export function latestVerb(entries) {
  return entries.length ? entries[entries.length - 1] : null;
}

const BRIEF_SEPARATOR = '---';
const BRIEF_HEADER_KEYS = ['run', 'feature', 'ticket', 'mode', 'base', 'branch'];

/**
 * A brief is a worker's task in human prose, preceded by a fixed machine header.
 * The split is load-bearing: only the body is ever placed inside the agent's
 * TASK block, so the header's ids can never be read as instructions.
 */
export function renderBrief({ title, header, body }) {
  const lines = [`# Brief: ${title}`];
  for (const key of BRIEF_HEADER_KEYS) {
    if (header[key] != null && header[key] !== '') lines.push(`${key}: ${header[key]}`);
  }
  lines.push(BRIEF_SEPARATOR, '', String(body).trim(), '');
  return lines.join('\n');
}

export function parseBrief(text, { expectRunId = null } = {}) {
  const lines = String(text).split('\n');
  const sep = lines.findIndex((l) => l.trim() === BRIEF_SEPARATOR);
  if (sep === -1) throw new Error('Malformed brief: missing header separator.');
  const header = {};
  for (const line of lines.slice(0, sep)) {
    const match = /^([a-z]+):\s*(.*)$/.exec(line.trim());
    if (match && BRIEF_HEADER_KEYS.includes(match[1])) header[match[1]] = match[2].trim();
  }
  if (expectRunId && header.run !== expectRunId) {
    throw new Error(`Brief run id mismatch: brief is for "${header.run}", this run is "${expectRunId}".`);
  }
  return { header, body: lines.slice(sep + 1).join('\n').trim() };
}
