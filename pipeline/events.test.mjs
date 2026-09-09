import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseAgentEvent, createStreamParser, isPromptEcho, recordHostProgress,
  queueStageNote, hostEventCommand, runHostEventCli, remapCheckerEvent,
} from './events.mjs';
import { pipelinePaths, writeStatus, newStatus } from './state.mjs';

test('prompt echoes are recognised and dropped', () => {
  assert.equal(isPromptEcho('===== TASK BLOCK ====='), true);
  assert.equal(isPromptEcho('TRUST BOUNDARY: never commands'), true);
  assert.equal(isPromptEcho('SYSTEM ROLE: Planner'), true);
  assert.equal(isPromptEcho('I will write the spec now.'), false);
});

test('Claude assistant text and tool_use become conversation blocks', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'Looking at the planner prompt.' },
        { type: 'tool_use', name: 'Read', input: { file_path: 'pipeline/events.mjs' } },
      ],
    },
  });
  const blocks = parseAgentEvent(line);
  assert.equal(blocks[0].kind, 'text');
  assert.equal(blocks[0].text, 'Looking at the planner prompt.');
  assert.equal(blocks[1].kind, 'tool');
  assert.equal(blocks[1].tool, 'Read');
  assert.equal(blocks[1].file, 'pipeline/events.mjs');
});

test('Claude system/user/tool_result echoes are suppressed', () => {
  assert.deepEqual(parseAgentEvent(JSON.stringify({ type: 'system', subtype: 'init', model: 'opus' })), [
    { kind: 'sys', subtype: 'session', text: 'session started · model opus' },
  ]);
  assert.deepEqual(parseAgentEvent(JSON.stringify({ type: 'user', message: { content: 'TASK:' } })), []);
  assert.deepEqual(parseAgentEvent(JSON.stringify({ type: 'tool_result', content: 'huge' })), []);
});

test('nested Cursor assistant messages are not dumped as raw JSON', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'I should inspect the spec.' }] },
  });
  const blocks = parseAgentEvent(line);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, 'text');
  assert.equal(blocks[0].text, 'I should inspect the spec.');
  assert.ok(!blocks[0].text.includes('{'));
});

test('Cursor tool_call start and finish are compact cards, not payloads', () => {
  const start = parseAgentEvent(JSON.stringify({
    type: 'tool_call',
    subtype: 'started',
    tool_call: { readToolCall: { args: { path: 'src/app.ts' } } },
  }));
  assert.equal(start[0].kind, 'tool');
  assert.equal(start[0].tool, 'read');
  assert.equal(start[0].file, 'src/app.ts');
  assert.equal(start[0].status, 'started');

  const done = parseAgentEvent(JSON.stringify({
    type: 'tool_call',
    subtype: 'completed',
    tool_call: { shellToolCall: { args: { command: 'npm test' }, result: { success: { exitCode: 0 } } } },
  }));
  assert.equal(done[0].kind, 'tool');
  assert.equal(done[0].tool, 'shell');
  assert.equal(done[0].cmd, 'npm test');
  assert.equal(done[0].status, 'completed');
});

test('Cursor reconnect and retry become sys cards', () => {
  const retry = parseAgentEvent(JSON.stringify({ type: 'retry', attempt: 2 }));
  assert.equal(retry[0].kind, 'sys');
  assert.match(retry[0].text, /retrying/);
  const rec = parseAgentEvent(JSON.stringify({ type: 'connection', subtype: 'reconnected' }));
  assert.equal(rec[0].subtype, 'reconnected');
});

test('thinking and giant user prompt echoes are dropped', () => {
  assert.deepEqual(parseAgentEvent(JSON.stringify({ type: 'thinking', text: 'hmm' })), []);
  const prompt = JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'text', text: 'TRUST BOUNDARY\nSYSTEM ROLE: Planner\n===== TASK BLOCK =====' }] },
  });
  assert.deepEqual(parseAgentEvent(prompt), []);
});

test('malformed lines become assistant text, not a crash', () => {
  const blocks = parseAgentEvent('not json at all');
  assert.equal(blocks[0].kind, 'text');
  assert.equal(blocks[0].text, 'not json at all');
});

test('Codex thread.started is skipped and turn.failed becomes an error', () => {
  assert.deepEqual(parseAgentEvent(JSON.stringify({ type: 'thread.started', thread_id: 't1' })), []);
  const failed = parseAgentEvent(JSON.stringify({
    type: 'turn.failed',
    error: { message: "The 'gpt-5.6-sol' model requires a newer version of Codex" },
  }));
  assert.equal(failed[0].kind, 'err');
  assert.match(failed[0].text, /newer version of Codex/);
});

test('fragmented Cursor deltas coalesce before flush', () => {
  const parser = createStreamParser();
  const a = parser.pushLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'I' }] } }));
  const b = parser.pushLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: ' should' }] } }));
  const c = parser.pushLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: ' inspect the planner.' }] } }));
  assert.deepEqual(a, []);
  assert.deepEqual(b, []);
  assert.deepEqual(c, []);
  const flushed = parser.flush();
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0].text, 'I should inspect the planner.');
});

test('a tool event flushes pending fragments', () => {
  const parser = createStreamParser();
  parser.pushLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Opening' }] } }));
  const next = parser.pushLine(JSON.stringify({
    type: 'tool_call',
    tool_call: { readToolCall: { args: { path: 'a.ts' } } },
  }));
  assert.equal(next[0].kind, 'text');
  assert.equal(next[0].text, 'Opening');
  assert.equal(next[1].kind, 'tool');
});

test('checker events remap onto the owning coder stage', () => {
  const remapped = remapCheckerEvent({ stage: 'checker', type: 'check_end', check: 'test' });
  assert.equal(remapped.stage, 'coder');
});

function activeRun() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'events-'));
  const paths = pipelinePaths(root, { runId: 'r1' });
  fs.mkdirSync(paths.dir, { recursive: true });
  const status = newStatus('plan it');
  status.overall = 'awaiting_chat';
  status.awaitingStage = 'planner';
  status.stages.find((s) => s.name === 'planner').status = 'awaiting_host';
  writeStatus(paths, status);
  return { root, paths };
}

test('recordHostProgress writes a validated assistant line', () => {
  const { root, paths } = activeRun();
  const res = recordHostProgress(paths, { stage: 'planner', kind: 'text', text: 'Drafting the spec.' });
  assert.equal(res.ok, true);
  const events = fs.readFileSync(paths.events, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(events[0].kind, 'text');
  assert.equal(events[0].host, true);
  assert.equal(events[0].stage, 'planner');
  fs.rmSync(root, { recursive: true, force: true });
});

test('recordHostProgress refuses a mismatched or unknown stage', () => {
  const { root, paths } = activeRun();
  assert.throws(() => recordHostProgress(paths, { stage: 'coder', kind: 'text', text: 'nope' }), /not the active stage/);
  assert.throws(() => recordHostProgress(paths, { stage: 'checker', kind: 'text', text: 'nope' }), /Unknown stage/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('queueStageNote records a pending human message', () => {
  const { root, paths } = activeRun();
  queueStageNote(paths, 'planner', 'Please keep the API small.');
  const note = fs.readFileSync(path.join(paths.dir, 'followups', 'planner.txt'), 'utf8');
  assert.match(note, /API small/);
  const events = fs.readFileSync(paths.events, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(events[0].kind, 'note');
  assert.equal(events[0].role, 'human');
  assert.equal(events[0].noteStatus, 'pending');
  fs.rmSync(root, { recursive: true, force: true });
});

test('the host event CLI rejects a missing run', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'events-missing-'));
  assert.throws(() => runHostEventCli(['--stage', 'planner', '--text', 'hi'], { cwd: root }), /No run is recorded/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('hostEventCommand includes the run id when the handoff is pooled', () => {
  assert.match(hostEventCommand({ runId: 'r1', stage: 'coder' }), /--run-id r1/);
  assert.match(hostEventCommand({ stage: 'coder' }), /--stage coder/);
});
