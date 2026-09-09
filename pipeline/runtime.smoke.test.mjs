import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pipelinePaths, writeStatus, newStatus } from './state.mjs';
import { runAgent } from './adapters.mjs';
import { recordHostProgress, parseAgentEvent, createStreamParser } from './events.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

test('a fake streamed CLI runner coalesces Cursor deltas and never dumps raw JSON into events', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-cli-'));
  const paths = pipelinePaths(root);
  fs.mkdirSync(paths.prompts, { recursive: true });
  const fake = path.join(root, 'fake-cursor.mjs');
  fs.writeFileSync(fake, `#!/usr/bin/env node
const lines = [
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'I' }] } }),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: ' should' }] } }),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: ' inspect the spec.' }] } }),
  JSON.stringify({ type: 'tool_call', subtype: 'started', tool_call: { readToolCall: { args: { path: 'src/a.ts' } } } }),
  JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'TRUST BOUNDARY\\nSYSTEM ROLE:' }] } }),
];
for (const line of lines) process.stdout.write(line + '\\n');
`);
  const promptFile = path.join(paths.prompts, 'planner_prompt.txt');
  fs.writeFileSync(promptFile, 'sys');
  const res = await runAgent({
    runner: 'fake-stream',
    stage: 'planner',
    cycle: 1,
    task: 'plan',
    systemPromptFile: promptFile,
    cwd: root,
    paths,
    config: {
      agentTimeoutMs: 5000,
      customRunners: { 'fake-stream': { command: process.execPath, args: [fake] } },
    },
  });
  assert.equal(res.ok, true);
  const events = fs.readFileSync(paths.events, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const texts = events.filter((e) => e.type === 'agent_output' && e.kind === 'text').map((e) => e.text);
  assert.deepEqual(texts, ['I should inspect the spec.']);
  assert.ok(!events.some((e) => typeof e.text === 'string' && e.text.includes('"type":"assistant"')));
  const raw = fs.readFileSync(path.join(paths.logs, 'planner.log'), 'utf8');
  assert.match(raw, /"type":"assistant"/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a host handoff records progress through the explicit event bridge', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-host-'));
  const paths = pipelinePaths(root, { runId: 'r-host' });
  fs.mkdirSync(paths.dir, { recursive: true });
  const status = newStatus('plan it');
  status.overall = 'awaiting_chat';
  status.awaitingStage = 'planner';
  status.stages.find((s) => s.name === 'planner').status = 'awaiting_host';
  writeStatus(paths, status);
  const cli = spawnSync(process.execPath, [
    path.join(HERE, 'host-event.mjs'),
    '--run-id', 'r-host',
    '--stage', 'planner',
    '--kind', 'text',
    '--text', 'Drafting the specification.',
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  const events = fs.readFileSync(paths.events, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(events[0].kind, 'text');
  assert.equal(events[0].host, true);
  assert.equal(events[0].text, 'Drafting the specification.');
  recordHostProgress(paths, { stage: 'planner', kind: 'tool', tool: 'read', file: 'specs.md' });
  fs.rmSync(root, { recursive: true, force: true });
});

test('the shared parser still understands a Claude assistant line', () => {
  const parser = createStreamParser();
  const blocks = parser.pushLine(JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'Claude wrote a paragraph.' }] },
  }));
  assert.equal(blocks[0].text, 'Claude wrote a paragraph.');
  assert.equal(parseAgentEvent('not-json')[0].kind, 'text');
});
