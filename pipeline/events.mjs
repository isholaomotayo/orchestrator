// Normalize agent CLI streams and host/chat progress into one conversation
// schema the dashboard can render. Raw CLI bytes stay in the stage log;
// events.jsonl only records the structured blocks this module produces.
import fs from 'node:fs';
import path from 'node:path';
import { appendEvent, pipelinePaths } from './state.mjs';
import { CORE_STAGES, OPTIONAL_STAGES } from './stages.mjs';

export const AGENT_STAGES = [...CORE_STAGES, ...OPTIONAL_STAGES];
export const HOST_EVENT_KINDS = ['text', 'tool', 'sys', 'err', 'note'];
export const DASHBOARD_EVENT_TYPES = [
  'agent_output', 'agent_start', 'agent_parked', 'agent_retry', 'agent_timeout',
  'agent_end', 'checks_start', 'check_start', 'check_end', 'followup_applied',
  'chat_handoff',
];

const FRAGMENT_MAX = 40;
const TOOL_RESULT_MAX = 280;

const PROMPT_ECHO = /TRUST BOUNDARY|SYSTEM ROLE:|===== TASK BLOCK/i;

export function isPromptEcho(text) {
  return typeof text === 'string' && PROMPT_ECHO.test(text);
}

function stringField(value) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  return null;
}

function isFragment(text) {
  if (typeof text !== 'string' || !text.length) return false;
  if (text.includes('\n')) return false;
  if (text.length > FRAGMENT_MAX) return false;
  // Token deltas often start with a leading space and must be glued onto the
  // previous piece — even when the last piece ends a sentence.
  if (/^\s/.test(text)) return true;
  // A short complete sentence is a finished message, not a token.
  const trimmed = text.trim();
  if (/\s/.test(trimmed) && /[.!?]["')\]]?\s*$/.test(trimmed)) return false;
  return true;
}

function toolNameFromCursor(ev) {
  const call = ev.tool_call || ev.toolCall || {};
  const key = Object.keys(call).find((k) => /ToolCall$/.test(k));
  if (key) return key.replace(/ToolCall$/, '');
  return ev.tool || call.name || 'tool';
}

function toolArgsFromCursor(ev) {
  const call = ev.tool_call || ev.toolCall || {};
  const key = Object.keys(call).find((k) => /ToolCall$/.test(k));
  const inner = key ? call[key] : call;
  const args = inner?.args || inner?.input || {};
  return {
    file: args.path || args.file_path || args.notebook_path || null,
    cmd: args.command || args.pattern || args.query || args.description || inner?.description || null,
  };
}

function summarizeToolResult(ev) {
  const call = ev.tool_call || ev.toolCall || {};
  const key = Object.keys(call).find((k) => /ToolCall$/.test(k));
  const result = key ? call[key]?.result : call.result;
  const success = result?.success || result;
  if (!success) return null;
  const err = success.error || result?.error;
  if (err) return { kind: 'err', text: stringField(err.error || err.message || err) || 'tool failed' };
  return null;
}

function parseAssistantContent(content) {
  if (typeof content === 'string') {
    const text = content.trim();
    return text && !isPromptEcho(text) ? [{ kind: 'text', role: 'assistant', text }] : [];
  }
  const blocks = [];
  for (const block of content || []) {
    // Keep leading/trailing spaces on token deltas so the stream parser can
    // glue "I" + " should" + " inspect." back into one sentence.
    if (block.type === 'text' && typeof block.text === 'string' && block.text.length && !isPromptEcho(block.text)) {
      blocks.push({ kind: 'text', role: 'assistant', text: block.text });
    }
    if (block.type === 'tool_use') {
      const input = block.input || {};
      blocks.push({
        kind: 'tool',
        tool: block.name,
        status: 'started',
        file: input.file_path || input.path || input.notebook_path || null,
        cmd: input.command || input.pattern || input.query || null,
      });
    }
  }
  return blocks;
}

/**
 * Turn one stdout line from an agent CLI into zero or more conversation blocks.
 * Unknown JSON is dropped rather than dumped raw — the stage log keeps the bytes.
 */
export function parseAgentEvent(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed) return [];

  let ev;
  try { ev = JSON.parse(trimmed); } catch {
    return isPromptEcho(trimmed) ? [] : [{ kind: 'text', role: 'assistant', text: trimmed }];
  }
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) {
    return [{ kind: 'text', role: 'assistant', text: trimmed }];
  }

  if (ev.type === 'system' && ev.subtype === 'init') {
    return [{ kind: 'sys', subtype: 'session', text: `session started · model ${ev.model || '?'}` }];
  }
  if (ev.type === 'system' || ev.type === 'user' || ev.type === 'thinking' || ev.subtype === 'thinking') return [];
  if (ev.type === 'tool_result') return [];

  if (ev.type === 'connection') {
    const attempt = ev.attempt ? ` (attempt ${ev.attempt})` : '';
    const label = ev.subtype === 'reconnected' ? 'reconnected' : `reconnecting${attempt}`;
    return [{ kind: 'sys', subtype: ev.subtype || 'connection', text: label }];
  }
  if (ev.type === 'retry') {
    const attempt = ev.attempt ? ` (attempt ${ev.attempt})` : '';
    return [{ kind: 'sys', subtype: 'retry', text: `retrying${attempt}` }];
  }

  if (ev.type === 'assistant') {
    if (typeof ev.message === 'string') {
      return isPromptEcho(ev.message) ? [] : [{ kind: 'text', role: 'assistant', text: ev.message }];
    }
    return parseAssistantContent(ev.message?.content || ev.content);
  }

  if (ev.type === 'result') {
    return [{
      kind: 'sys',
      subtype: 'done',
      text: `done · ${ev.subtype || ''} · ${ev.num_turns ?? '?'} turns · $${ev.total_cost_usd?.toFixed?.(4) ?? '?'}`,
      costUsd: typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : undefined,
      turns: ev.num_turns,
    }];
  }

  if (ev.type === 'tool_call') {
    const tool = toolNameFromCursor(ev);
    const { file, cmd } = toolArgsFromCursor(ev);
    if (ev.subtype === 'completed') {
      const failed = summarizeToolResult(ev);
      if (failed) return [failed];
      return [{ kind: 'tool', tool, status: 'completed', file, cmd }];
    }
    return [{ kind: 'tool', tool, status: 'started', file, cmd }];
  }

  if (ev.type === 'thread.started' || ev.type === 'turn.started') return [];
  if (ev.type === 'error' || ev.type === 'turn.failed') {
    const nested = ev.error?.error?.message || ev.error?.message || ev.message;
    const text = stringField(nested) || 'agent error';
    return [{ kind: 'err', text }];
  }
  if (ev.type === 'item.completed' && stringField(ev.item?.text)) {
    return [{ kind: 'text', role: 'assistant', text: ev.item.text.trim() }];
  }

  const text = stringField(ev.text) || stringField(ev.message) || stringField(ev.content);
  if (text && !isPromptEcho(text)) return [{ kind: 'text', role: 'assistant', text }];
  return [];
}

/** Line-oriented parser that coalesces token-sized assistant fragments. */
export function createStreamParser() {
  let pending = '';
  const flushPending = () => {
    const text = pending.trim();
    pending = '';
    return text ? [{ kind: 'text', role: 'assistant', text }] : [];
  };
  return {
    pushLine(line) {
      const blocks = parseAgentEvent(line);
      const out = [];
      for (const block of blocks) {
        if (block.kind === 'text' && block.role !== 'human' && isFragment(block.text)) {
          pending += block.text;
          continue;
        }
        out.push(...flushPending());
        out.push(block);
      }
      return out;
    },
    flush: flushPending,
  };
}

export function blockToLogLine(b) {
  if (b.kind === 'tool') return `[tool] ${b.tool || 'tool'}${b.status ? ` ${b.status}` : ''} ${b.file || b.cmd || ''}`.trim();
  if (b.kind === 'sys') return `[session] ${b.text}`;
  if (b.kind === 'err') return `[stderr] ${b.text}`;
  if (b.kind === 'note') return `[note] ${b.text}`;
  return b.text;
}

export function remapCheckerEvent(ev) {
  if (ev?.stage !== 'checker') return ev;
  return { ...ev, stage: 'coder' };
}

export function shouldIndexEvent(ev) {
  return DASHBOARD_EVENT_TYPES.includes(ev?.type);
}

function followupDir(paths) {
  return path.join(paths.dir, 'followups');
}

export function queueStageNote(paths, stage, text) {
  if (!AGENT_STAGES.includes(stage)) throw new Error(`Unknown stage "${stage}".`);
  const body = String(text || '').trim();
  if (!body) throw new Error('Note text is required.');
  const dir = followupDir(paths);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, `${stage}.txt`), `${body}\n`);
  appendEvent(paths, {
    stage, type: 'agent_output', kind: 'note', role: 'human',
    text: body, noteStatus: 'pending',
  });
  return { ok: true, stage, queued: true };
}

export function readStageNotes(dir) {
  const out = {};
  for (const stage of AGENT_STAGES) {
    try {
      const t = fs.readFileSync(path.join(dir, 'followups', `${stage}.txt`), 'utf8').trim();
      if (t) out[stage] = t;
    } catch { /* no note queued */ }
  }
  return out;
}

function loadStatus(paths) {
  try { return JSON.parse(fs.readFileSync(paths.status, 'utf8')); } catch { return null; }
}

function stageIsActive(status, stage) {
  if (!status) return false;
  if (status.awaitingStage === stage) return true;
  const row = (status.stages || []).find((s) => s.name === stage);
  return ['running', 'awaiting_host'].includes(row?.status);
}

/**
 * Record a host/chat progress line. Validates run + stage so a confused agent
 * cannot write into another run's transcript.
 */
export function recordHostProgress(paths, { stage, kind = 'text', text = '', tool = null, file = null, cmd = null, role = null } = {}) {
  if (!AGENT_STAGES.includes(stage)) throw new Error(`Unknown stage "${stage}".`);
  if (!HOST_EVENT_KINDS.includes(kind)) throw new Error(`Unknown event kind "${kind}".`);
  const status = loadStatus(paths);
  if (!status) throw new Error('No run is recorded at this path.');
  if (!stageIsActive(status, stage)) {
    throw new Error(`Stage "${stage}" is not the active stage for this run.`);
  }
  const body = String(text || '').trim();
  if ((kind === 'text' || kind === 'note' || kind === 'err' || kind === 'sys') && !body) {
    throw new Error('Event text is required.');
  }
  const event = {
    stage,
    type: 'agent_output',
    kind,
    role: role || (kind === 'note' ? 'human' : 'assistant'),
    host: true,
    text: body || undefined,
    tool: tool || undefined,
    file: file || undefined,
    cmd: cmd || undefined,
    status: kind === 'tool' ? 'started' : undefined,
  };
  appendEvent(paths, event);
  return { ok: true, stage, kind };
}

export function hostEventCommand({ runId = null, stage }) {
  const runFlag = runId ? ` --run-id ${runId}` : '';
  return `node pipeline/host-event.mjs${runFlag} --stage ${stage} --kind text --text "<progress>"`;
}

export function parseHostEventArgs(argv) {
  const out = { runId: null, stage: null, kind: 'text', text: '', tool: null, file: null, cmd: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--run-id') out.runId = next();
    else if (a === '--stage') out.stage = next();
    else if (a === '--kind') out.kind = next();
    else if (a === '--text') out.text = next();
    else if (a === '--tool') out.tool = next();
    else if (a === '--file') out.file = next();
    else if (a === '--cmd') out.cmd = next();
  }
  return out;
}

export function runHostEventCli(argv, { cwd = process.cwd() } = {}) {
  const args = parseHostEventArgs(argv);
  const paths = pipelinePaths(cwd, { runId: args.runId });
  return recordHostProgress(paths, args);
}

export { TOOL_RESULT_MAX };
