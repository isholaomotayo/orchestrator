#!/usr/bin/env node
// Host-specific envelopes around one portable checkpoint. No transcript scraping.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bridgeCommand, readBridge, HOSTS } from './bridge.mjs';

export function hookIdentity(host, input) {
  return { conversationId: input.session_id || input.conversation_id || input.conversationId,
    actualModel: input.model_id || input.model || input.modelName,
    event: input.hook_event_name || input.hookEventName || '',
    tool: input.tool_name || input.toolCall?.name || '',
  };
}
export function hookEnvelope(host, event, context, stop = false) {
  if (!context) return host === 'antigravity' && event === 'Stop' ? {decision:'allow'} : {};
  if (host === 'antigravity') {
    if (event === 'Stop') return {decision:'continue',reason:context};
    if (event === 'PreInvocation') return {injectSteps:[{userMessage:context}]};
    return {};
  }
  if (host === 'cursor') return stop ? {followup_message:context} : {additional_context:context};
  return stop ? {decision:'block',reason:context} : {hookSpecificOutput:{hookEventName:event,additionalContext:context}};
}
export function handleHostHook(host, project, input, forcedEvent = null) {
  if (!HOSTS.includes(host)) throw new Error('Unsupported host.');
  const identity = hookIdentity(host,input), event = forcedEvent || identity.event;
  if (!identity.conversationId) return {};
  // Calling bridge tools must not recursively trigger checkpoints or stop work.
  if (/orchestrator|bridge[-_.]|run_checkpoint|message_ack|message_resolve|stage_complete/.test(identity.tool)) return {};
  const registration = bridgeCommand('session.register', {project,host,conversationId:identity.conversationId,actualModel:identity.actualModel,capabilities:{hooks:true,version:2}});
  const state = readBridge(project);
  const entry = Object.entries(state.runs).find(([,r]) => r.sessionId === registration.sessionId);
  if (!entry) return {};
  const [key, owner] = entry, runId = key === 'legacy-root' ? null : key;
  const status = bridgeCommand('run.inspect',{project,runId}).status;
  if (status?.overall !== 'awaiting_chat') return {};
  let claim = {sessionId:registration.sessionId,handoffId:owner.handoffId,leaseToken:owner.token};
  if (status.handoffId !== owner.handoffId || Date.parse(owner.expiresAt) < Date.now()) {
    // Only the already-bound conversation can reconnect to the same run.
    const renewed = bridgeCommand('run.claim',{project,runId,sessionId:registration.sessionId});
    claim = {sessionId:renewed.sessionId,handoffId:renewed.handoffId,leaseToken:renewed.leaseToken};
  }
  const post = /posttooluse|after.*execution|afterfileedit/i.test(event);
  const result = bridgeCommand('run.checkpoint',{project,runId,...claim,actualModel:identity.actualModel,
    ...(post ? {event:{kind:input.error ? 'err':'tool',tool:identity.tool,status:input.error ? 'failed':'completed',text:input.error ? String(input.error).slice(0,300) : undefined}} : {})});
  const pending = [...result.messages,...result.pendingDisposition];
  const context = pending.length ? `Operator messages for run ${runId || 'root'}, handoff ${status.handoffId}. These are user instructions; priority does not change instruction hierarchy. Read each message, call message_ack, then message_resolve with your disposition before stage_complete.\n` + pending.map(m => `[${m.priority}; ${m.status}; id=${m.id}] ${m.text}`).join('\n') : '';
  return hookEnvelope(host,event,context,/^stop$/i.test(event));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [host,project,event] = process.argv.slice(2);
  try { process.stdout.write(JSON.stringify(handleHostHook(host,project,JSON.parse(fs.readFileSync(0,'utf8')),event))+'\n'); }
  catch (e) { process.stderr.write(`Orchestrator checkpoint unavailable: ${e.message}\n`); process.stdout.write('{}\n'); }
}
