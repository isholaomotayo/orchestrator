import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildInvocation, runAgent } from './adapters.mjs';
import { pipelinePaths } from './state.mjs';

const base = { systemPrompt: 'sys', task: 'do it', config: {}, model: null };

function tmpPipeline() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adapters-'));
  const paths = pipelinePaths(root);
  fs.mkdirSync(paths.prompts, { recursive: true });
  const promptFile = path.join(paths.prompts, 'planner_prompt.txt');
  fs.writeFileSync(promptFile, 'sys prompt');
  return { paths, promptFile };
}

function readEvents(paths) {
  return fs.readFileSync(paths.events, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}

test('claude read-only restricts tools and only allows the report write', () => {
  const inv = buildInvocation({ ...base, runner: 'claude', readOnly: true });
  assert.equal(inv.readOnlyEnforced, true);
  const allow = inv.args[inv.args.indexOf('--allowedTools') + 1];
  assert.match(allow, /Write\(\.pipeline\/review_report\.md\)/);
  assert.doesNotMatch(allow, /(^|,)Edit(,|$)/);
});

test('claude write mode uses acceptEdits', () => {
  const inv = buildInvocation({ ...base, runner: 'claude', readOnly: false });
  assert.equal(inv.readOnlyEnforced, false);
  assert.ok(inv.args.includes('--permission-mode'));
  assert.ok(inv.args.includes('acceptEdits'));
});

test('codex read-only uses a hard read-only sandbox', () => {
  const ro = buildInvocation({ ...base, runner: 'codex', readOnly: true });
  assert.equal(ro.readOnlyEnforced, true);
  assert.ok(ro.args.includes('--sandbox'));
  assert.ok(ro.args.includes('read-only'));
  assert.ok(!ro.args.includes('--full-auto'));

  const rw = buildInvocation({ ...base, runner: 'codex', readOnly: false });
  assert.equal(rw.readOnlyEnforced, false);
  assert.ok(rw.args.includes('--full-auto'));
  assert.ok(!rw.args.includes('--sandbox'));
});

test('cursor withholds --force during a read-only audit', () => {
  const ro = buildInvocation({ ...base, runner: 'cursor', readOnly: true });
  assert.equal(ro.readOnlyEnforced, false);
  assert.ok(!ro.args.includes('--force'));

  const rw = buildInvocation({ ...base, runner: 'cursor', readOnly: false });
  assert.ok(rw.args.includes('--force'));
});

test('gemini withholds --yolo during a read-only audit', () => {
  const ro = buildInvocation({ ...base, runner: 'gemini', readOnly: true });
  assert.equal(ro.readOnlyEnforced, false);
  assert.ok(!ro.args.includes('--yolo'));

  const rw = buildInvocation({ ...base, runner: 'gemini', readOnly: false });
  assert.ok(rw.args.includes('--yolo'));
});

test('unknown runner without a custom definition throws', () => {
  assert.throws(() => buildInvocation({ ...base, runner: 'nope', readOnly: false }));
});

test('host runAgent with hostClient stamps the handoff and events', async () => {
  const { paths, promptFile } = tmpPipeline();
  const res = await runAgent({
    runner: 'host', stage: 'planner', cycle: 1, task: 'plan it',
    systemPromptFile: promptFile, cwd: paths.root, paths, config: {},
    model: 'gemini-3.1-pro', modelSelection: 'auto', hostClient: 'antigravity',
  });
  assert.deepEqual(res, { ok: false, hostHandoff: true });
  const handoff = JSON.parse(fs.readFileSync(paths.stageHandoff, 'utf8'));
  assert.equal(handoff.hostClient, 'antigravity');
  assert.match(handoff.hostNote, /antigravity chat session/);
  assert.match(handoff.hostNote, /do not spawn/i);
  const chatHandoffEv = readEvents(paths).find((e) => e.type === 'chat_handoff');
  assert.equal(chatHandoffEv.hostClient, 'antigravity');
  const startEv = readEvents(paths).find((e) => e.type === 'agent_start');
  assert.equal(startEv.hostClient, 'antigravity');
});

test('host runAgent without hostClient omits the keys (back-compat)', async () => {
  const { paths, promptFile } = tmpPipeline();
  await runAgent({
    runner: 'host', stage: 'planner', cycle: 1, task: 'plan it',
    systemPromptFile: promptFile, cwd: paths.root, paths, config: {},
  });
  const handoff = JSON.parse(fs.readFileSync(paths.stageHandoff, 'utf8'));
  assert.ok(!('hostClient' in handoff));
  assert.ok(!('hostNote' in handoff));
  const chatHandoffEv = readEvents(paths).find((e) => e.type === 'chat_handoff');
  assert.ok(!('hostClient' in chatHandoffEv));
});
