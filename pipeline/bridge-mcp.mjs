#!/usr/bin/env node
// A stdio MCP tools server. Each transport is pinned to its configured project;
// it does not expose arbitrary shell execution, merge approval, or filesystem IO.
import readline from 'node:readline';
import fs from 'node:fs';
import { executeBridge } from './bridge-cli.mjs';

const projectIndex = process.argv.indexOf('--project');
const project = fs.realpathSync(projectIndex >= 0 ? process.argv[projectIndex + 1] : process.cwd());
const definitions = {
  'session.register': ['Register this host conversation before claiming work.', ['host', 'conversationId']],
  'run.claim': ['Claim an explicit run; retain the returned handoffId and leaseToken for all subsequent calls.', ['runId', 'sessionId']],
  'run.release': ['Release this session’s owned handoff.', ['runId', 'sessionId', 'handoffId', 'leaseToken']],
  'run.checkpoint': ['Required before work and after tool batches. Returns priority operator messages. Read them, acknowledge each, and record disposition before completion.', ['runId', 'sessionId', 'handoffId', 'leaseToken']],
  'run.report': ['Record concise operational activity without private reasoning or secrets.', ['runId', 'sessionId', 'handoffId', 'leaseToken']],
  'message.ack': ['Explicitly acknowledge a delivered operator message after reading it.', ['runId', 'sessionId', 'handoffId', 'leaseToken', 'messageId']],
  'message.resolve': ['Record how an acknowledged message was addressed, deferred, or rejected, with a reason.', ['runId', 'sessionId', 'handoffId', 'leaseToken', 'messageId', 'disposition', 'reason']],
  'stage.complete': ['Validate and complete the owned stage. Required artifacts, integrity, checks and pending priority messages are enforced by the engine.', ['runId', 'sessionId', 'handoffId', 'leaseToken', 'commandId']],
  'run.inspect': ['Inspect an explicit run and message delivery state.', ['runId']],
  'run.wait': ['Wait up to 60 seconds for a bridge revision change.', ['runId']],
  'run.dismiss': ['Dismiss and archive an abandoned, stuck, or dead run.', ['runId']],
};
const properties = Object.fromEntries(['host','conversationId','sessionId','handoffId','leaseToken','messageId','disposition','reason','text','actualModel','commandId'].map(k => [k,{ type:'string' }]));
Object.assign(properties, { project: {type:'string'}, runId: {type:['string','null']}, capabilities: {type:'object'}, event: {type:'object'}, reassign: {type:'boolean'}, expectedRevision: {type:'integer'}, afterRevision: {type:'integer'}, timeoutMs: {type:'integer'} });
const tools = Object.entries(definitions).map(([name,[description,required]]) => ({ name: name.replace('.', '_'), description, inputSchema: { type:'object', properties, required, additionalProperties:false } }));
const write = value => process.stdout.write(JSON.stringify(value) + '\n');
async function handle(request) {
  if (request.id == null) return;
  try {
    let result;
    if (request.method === 'initialize') result = { protocolVersion: request.params?.protocolVersion || '2024-11-05', capabilities: {tools:{}}, serverInfo: {name:'orchestrator',version:'2.1.0'} };
    else if (request.method === 'ping') result = {};
    else if (request.method === 'tools/list') result = {tools};
    else if (request.method === 'tools/call') {
      const tool = tools.find(t => t.name === request.params?.name);
      if (!tool) throw new Error('Unknown tool.');
      const args = request.params.arguments || {};
      for (const key of tool.inputSchema.required) if (!Object.hasOwn(args,key)) throw new Error(`Missing ${key}`);
      if (args.project && fs.realpathSync(args.project) !== project) throw new Error('This MCP connection belongs to another project.');
      const command = Object.keys(definitions).find(n => n.replace('.', '_') === tool.name);
      try {
        const value = await executeBridge(command, {...args, project});
        result = { content:[{type:'text',text:JSON.stringify(value)}], isError:value.ok === false };
      } catch (e) { result = { content:[{type:'text',text:e.message}], isError:true }; }
    } else { write({jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'Method not found'}}); return; }
    write({jsonrpc:'2.0',id:request.id,result});
  } catch (e) { write({jsonrpc:'2.0',id:request.id,error:{code:-32602,message:e.message}}); }
}
const input = readline.createInterface({input:process.stdin,crlfDelay:Infinity});
for await (const line of input) {
  if (line.length > 65536) { write({jsonrpc:'2.0',id:null,error:{code:-32600,message:'Request too large'}}); continue; }
  try { await handle(JSON.parse(line)); } catch { write({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Invalid JSON'}}); }
}
