import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pipelinePaths, appendEvent, readLock, pidAlive, STAGE_ARTIFACT_FILES } from './state.mjs';
import { isValidRunId } from './run-registry.mjs';
import { validateArtifactFile } from './artifacts.mjs';
import { transact, commandState } from './commands.mjs';

export const BRIDGE_VERSION = 2;
export const HOSTS = ['codex', 'claude', 'cursor', 'antigravity'];
export const LEASE_MS = 120000;
const CLOSED = new Set(['addressed', 'deferred', 'rejected', 'cancelled']);
const rootOf = project => {
  if (!project || !path.isAbsolute(project)) throw new Error('An explicit absolute project path is required.');
  return fs.realpathSync(project);
};
export function bridgePaths(project, runId) {
  const root = rootOf(project);
  if (runId != null && runId !== '' && !isValidRunId(runId)) throw new Error('Invalid runId.');
  const p = pipelinePaths(root, { runId: runId || null });
  if (runId && fs.existsSync(p.dir) && !fs.realpathSync(p.dir).startsWith(fs.realpathSync(p.runs) + path.sep)) throw new Error('Run path escapes project.');
  return p;
}
export function readBridge(project) { return commandState(bridgePaths(project).control); }
function loadStatus(p) {
  try { return JSON.parse(fs.readFileSync(p.status, 'utf8')); } catch { throw new Error('Missing or unreadable run status.'); }
}
const keyOf = runId => runId || 'legacy-root';
function owned(state, args, status, now) {
  const owner = state.runs[keyOf(args.runId)];
  if (!owner || owner.sessionId !== args.sessionId || owner.token !== args.leaseToken) throw new Error('This session does not own the run.');
  if (owner.handoffId !== status.handoffId || args.handoffId !== status.handoffId) throw new Error('Stale handoff.');
  if (Date.parse(owner.expiresAt) <= now) throw new Error('Ownership lease expired; reconnect or explicitly reassign.');
  return owner;
}
function relevant(m, args, status) { return m.runId === (args.runId || null) && m.handoffId === status.handoffId; }
function messageView(m) { return { ...m }; }
export function inspectBridge(project, runId = null, { now = Date.now() } = {}) {
  const state = readBridge(project), p = bridgePaths(project, runId);
  let status = null; try { status = loadStatus(p); } catch {}
  const owner = state.runs[keyOf(runId)];
  const session = owner && state.sessions[owner.sessionId];
  const capability = !owner ? 'disconnected' : Date.parse(owner.expiresAt) <= now ? 'disconnected'
    : session?.capabilities?.hooks ? 'connected' : 'checkpoint-only';
  return { revision: state.revision, status, owner: owner ? { sessionId: owner.sessionId, handoffId: owner.handoffId, expiresAt: owner.expiresAt, lastActivityAt: owner.lastActivityAt, lastCheckpointAt: owner.lastCheckpointAt, host: session?.host, conversationId: session?.conversationId, actualModel: session?.actualModel, capability } : null,
    capability, messages: state.messages.filter(m => m.runId === (runId || null)).map(messageView) };
}
export function bridgeCommand(command, args, { now = Date.now() } = {}) {
  const p = bridgePaths(args.project, args.runId);
  if (command === 'run.inspect') return inspectBridge(args.project, args.runId, { now });
  if (command !== 'session.register' && command !== 'bridge.inspect' && !Object.hasOwn(args, 'runId')) throw new Error('runId is required (null for a legacy root run).');
  if (command === 'bridge.inspect') {
    const s = readBridge(args.project);
    return { revision: s.revision, sessions: Object.values(s.sessions), messages: s.messages, runs: Object.keys(s.runs).map(k => inspectBridge(args.project, k === 'legacy-root' ? null : k, { now })) };
  }
  const stamp = new Date(now).toISOString();
  const input = { ...args }; delete input.commandId; delete input.expectedRevision;
  return transact(p.control, command, input, state => {
    if (command === 'session.register') {
      if (!HOSTS.includes(args.host) || !args.conversationId?.trim()) throw new Error('host and conversationId are required.');
      const sessionId = crypto.createHash('sha256').update(`${p.root}\0${args.host}\0${args.conversationId}`).digest('hex').slice(0, 24);
      const prev = state.sessions[sessionId];
      state.sessions[sessionId] = { ...prev, sessionId, host: args.host, conversationId: args.conversationId, project: p.root, capabilities: args.capabilities || prev?.capabilities || {}, actualModel: args.actualModel || prev?.actualModel || null, modelSource: args.actualModel ? 'host-observed' : prev?.modelSource || 'unknown', registeredAt: prev?.registeredAt || stamp, connectedAt: stamp };
      return { sessionId, capabilities: state.sessions[sessionId].capabilities };
    }
    const status = loadStatus(p);
    const key = keyOf(args.runId);
    if (command === 'message.queue') {
      if (['done', 'halted'].includes(status.overall)) throw new Error('Run is terminal; resume or request changes before sending.');
      if (!args.text?.trim() || args.text.length > 32000) throw new Error('Message must contain 1–32000 characters.');
      const stage = status.awaitingStage || status.stages?.find(s => s.status === 'running')?.name;
      if (args.stage && args.stage !== stage) throw new Error(`Stage ${args.stage} is not active (active: ${stage}).`);
      if (args.handoffId && args.handoffId !== status.handoffId) throw new Error('Stale handoff; refresh before sending.');
      if (!['priority', 'normal'].includes(args.priority || 'priority')) throw new Error('Invalid message priority.');
      const message = { id: crypto.randomUUID(), runId: args.runId || null, handoffId: status.handoffId || null, stage, text: args.text.trim(), priority: args.priority || 'priority', author: 'operator', sequence: state.messages.length + 1, createdAt: stamp, status: 'queued', deliveries: [] };
      state.messages.push(message); return { message };
    }
    if (command === 'run.claim') {
      if (status.overall !== 'awaiting_chat' || !status.handoffId) throw new Error('Run is not awaiting a managed handoff; migrate legacy handoffs explicitly.');
      if (!state.sessions[args.sessionId]) throw new Error('Register the session first.');
      const prev = state.runs[key];
      if (prev && prev.sessionId !== args.sessionId && (!args.reassign || Date.parse(prev.expiresAt) > now)) throw new Error('Run already owned. Reassignment requires an expired lease and explicit reassign.');
      if (prev && prev.sessionId !== args.sessionId && pidAlive(readLock(p)?.pid)) throw new Error('Run engine is still active.');
      if (Object.entries(state.runs).some(([k, r]) => k !== key && r.sessionId === args.sessionId && Date.parse(r.expiresAt) > now)) throw new Error('Release the other run before claiming this one.');
      const same = prev?.sessionId === args.sessionId && prev.handoffId === status.handoffId && Date.parse(prev.expiresAt) > now;
      const owner = { sessionId: args.sessionId, handoffId: status.handoffId, token: same ? prev.token : crypto.randomUUID(), generation: same ? prev.generation : (prev?.generation || 0) + 1, claimedAt: same ? prev.claimedAt : stamp, expiresAt: new Date(now + LEASE_MS).toISOString(), lastActivityAt: same ? prev.lastActivityAt : null, lastCheckpointAt: stamp };
      state.runs[key] = owner;
      const handoff = JSON.parse(fs.readFileSync(p.stageHandoff, 'utf8'));
      return { runId: args.runId, sessionId: args.sessionId, handoffId: owner.handoffId, leaseToken: owner.token, expiresAt: owner.expiresAt, handoff, worktree: status.worktree ? path.resolve(p.root, status.worktree) : p.root };
    }
    const owner = owned(state, args, status, now);
    if (command === 'run.release') { delete state.runs[key]; return { released: true }; }
    if (command === 'run.checkpoint' || command === 'run.report') {
      owner.expiresAt = new Date(now + LEASE_MS).toISOString(); owner.lastCheckpointAt = stamp;
      if (args.text || args.event) owner.lastActivityAt = stamp;
      if (args.actualModel) { const session = state.sessions[args.sessionId]; session.actualModel = args.actualModel; session.modelSource = 'host-observed'; }
      if (args.text || args.event) appendEvent(p, { type: 'agent_output', host: true, stage: status.awaitingStage, handoffId: status.handoffId, sessionId: args.sessionId, kind: args.event?.kind || 'text', text: String(args.text || args.event?.text || '').slice(0, 2000), tool: args.event?.tool, status: args.event?.status, file: args.event?.file });
      const messages = state.messages.filter(m => relevant(m, args, status) && ['queued', 'delivered'].includes(m.status)).sort((a,b) => (a.priority === 'priority' ? 0 : 1) - (b.priority === 'priority' ? 0 : 1) || a.sequence - b.sequence);
      for (const m of messages) { m.status = 'delivered'; m.deliveries.push({ sessionId: args.sessionId, at: stamp }); }
      return { messages, expiresAt: owner.expiresAt, pendingDisposition: state.messages.filter(m => relevant(m, args, status) && m.status === 'acknowledged') };
    }
    if (command === 'message.ack' || command === 'message.resolve') {
      const m = state.messages.find(m => m.id === args.messageId && relevant(m, args, status));
      if (!m) throw new Error('Message does not belong to this handoff.');
      if (command === 'message.ack') {
        if (m.status === 'queued') throw new Error('Message has not been delivered.');
        if (!CLOSED.has(m.status)) { m.status = 'acknowledged'; m.acknowledgedAt = stamp; m.acknowledgedBy = args.sessionId; }
      } else {
        if (m.status !== 'acknowledged') throw new Error('Acknowledge the message before resolving it.');
        if (!['addressed', 'deferred', 'rejected'].includes(args.disposition) || !args.reason?.trim()) throw new Error('A disposition and reason are required.');
        m.status = args.disposition; m.reason = args.reason; m.resolvedAt = stamp;
      }
      return { message: m };
    }
    if (command === 'stage.prepare') {
      assertMessagesSettled(state, args.runId, status.handoffId);
      const file = path.join(p.dir, STAGE_ARTIFACT_FILES[status.awaitingStage] || 'invalid');
      const check = validateArtifactFile(status.awaitingStage, file);
      if (!check.ok) throw new Error(`Stage artifact is not ready: ${check.reason}`);
      owner.completion = { id: args.commandId || crypto.randomUUID(), handoffId: status.handoffId, artifactHash: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), preparedAt: stamp };
      return { completion: owner.completion };
    }
    throw new Error(`Unknown bridge command ${command}`);
  }, { commandId: args.commandId, expectedRevision: args.expectedRevision });
}
export function assertMessagesSettled(state, runId, handoffId) {
  const pending = state.messages.filter(m => m.runId === (runId || null) && m.handoffId === handoffId && m.priority === 'priority' && !CLOSED.has(m.status));
  if (pending.length) throw new Error(`Priority messages require acknowledgment and disposition: ${pending.map(m => m.id).join(', ')}`);
}
export function validateCompletion(project, runId, status, credentials) {
  const p = bridgePaths(project, runId), state = readBridge(project);
  const owner = owned(state, { ...credentials, runId }, status, Date.now());
  assertMessagesSettled(state, runId, status.handoffId);
  const file = path.join(p.dir, STAGE_ARTIFACT_FILES[status.awaitingStage] || 'invalid');
  const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (!owner.completion || owner.completion.id !== credentials.completionId || owner.completion.artifactHash !== hash) throw new Error('Stage completion was not prepared for this artifact.');
}
export function completeStage(args) {
  const p = bridgePaths(args.project, args.runId);
  const commandId = args.commandId || crypto.randomUUID();
  // A previously committed handoff completion is replayable after a crash.
  const before = loadStatus(p);
  if (before.completedHandoffs?.[args.handoffId]) return before.completedHandoffs[args.handoffId];
  const prepared = bridgeCommand('stage.prepare', { ...args, commandId });
  const credentials = { sessionId: args.sessionId, leaseToken: args.leaseToken, handoffId: args.handoffId, completionId: prepared.completion.id };
  const result = spawnSync(process.execPath, [path.join(p.root, 'pipeline/orchestrator.mjs'), '--continue', ...(args.runId ? ['--run-id', args.runId] : [])], { cwd: p.root, encoding: 'utf8', timeout: 600000, maxBuffer: 1024 * 1024, env: { ...process.env, ORCHESTRATOR_COMPLETION: JSON.stringify(credentials) } });
  const after = loadStatus(p);
  if (after.completedHandoffs?.[args.handoffId]) return after.completedHandoffs[args.handoffId];
  return { ok: false, overall: after.overall, error: result.error?.message || result.stderr?.slice(-2000) || 'Stage did not advance; inspect run state.' };
}

// Called by the engine at the transition boundary after its checks. Sharing the
// inbox lock makes a simultaneous message either block this completion or belong
// to the next handoff, never vanish between the two.
export function commitCompletion(project, runId, previous, credentials, next) {
  const p = bridgePaths(project, runId);
  return transact(p.control, 'stage.commit', { runId, handoffId: previous.handoffId }, state => {
    const owner = state.runs[keyOf(runId)];
    if (!owner || owner.token !== credentials.leaseToken || owner.sessionId !== credentials.sessionId || owner.handoffId !== previous.handoffId) throw new Error('Completion ownership changed.');
    assertMessagesSettled(state, runId, previous.handoffId);
    const result = { ok: true, runId, handoffId: previous.handoffId, completedAt: new Date().toISOString() };
    next.completedHandoffs = { ...next.completedHandoffs, [previous.handoffId]: result };
    next.handoffId = null;
    fs.writeFileSync(p.status, JSON.stringify(next, null, 2));
    return result;
  }, { commandId: `commit-${previous.handoffId}` });
}
export function bindHandoff(project, runId, handoffId, stage) {
  const p = bridgePaths(project, runId);
  return transact(p.control, 'handoff.bind', { runId, handoffId }, state => {
    for (const m of state.messages) if (m.runId === (runId || null) && !m.handoffId && !CLOSED.has(m.status)) { m.handoffId = handoffId; m.stage = stage; }
    return { ok: true };
  });
}
