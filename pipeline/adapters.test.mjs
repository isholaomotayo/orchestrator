import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildInvocation, runAgent, detectRunner, agentEnv, resolvePoolRunner, checkRunnerAvailable, RUNNER_BINS, resolveExecutionSurface, isHostSurface, resolveChatSafeRunner, reconcileChatRunner } from './adapters.mjs';
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

test('antigravity includes --dangerously-skip-permissions even during a read-only audit to prevent headless hang', () => {
  const ro = buildInvocation({ ...base, runner: 'antigravity', readOnly: true });
  assert.equal(ro.bin, 'agy');
  assert.equal(ro.readOnlyEnforced, false);
  assert.ok(ro.args.includes('--dangerously-skip-permissions'));
  assert.ok(!ro.args.includes('--yolo'));

  const rw = buildInvocation({ ...base, runner: 'antigravity', readOnly: false });
  assert.equal(rw.bin, 'agy');
  assert.ok(rw.args.includes('--dangerously-skip-permissions'));
  assert.ok(!rw.args.includes('--yolo'));
});

test('gemini runner is a deprecated alias for antigravity (agy)', () => {
  const ro = buildInvocation({ ...base, runner: 'gemini', readOnly: true });
  const agy = buildInvocation({ ...base, runner: 'antigravity', readOnly: true });
  assert.equal(ro.bin, 'agy');
  assert.deepEqual(ro.args, agy.args);
  assert.ok(!ro.args.includes('--yolo'));

  const rw = buildInvocation({ ...base, runner: 'gemini', readOnly: false });
  assert.ok(rw.args.includes('--dangerously-skip-permissions'));
});

test('antigravity passes --effort and --model to agy', () => {
  const inv = buildInvocation({
    ...base, runner: 'antigravity', readOnly: false,
    model: 'gemini-3.1-pro', effort: 'high',
  });
  assert.ok(inv.args.includes('--model'));
  assert.equal(inv.args[inv.args.indexOf('--model') + 1], 'gemini-3.1-pro');
  assert.ok(inv.args.includes('--effort'));
  assert.equal(inv.args[inv.args.indexOf('--effort') + 1], 'high');

  const collapsed = buildInvocation({
    ...base, runner: 'antigravity', readOnly: false, effort: 'xhigh',
  });
  assert.equal(collapsed.args[collapsed.args.indexOf('--effort') + 1], 'high');
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
  assert.match(handoff.eventCommand, /host-event\.mjs/);
  assert.match(handoff.eventCommand, /--stage planner/);
  const parked = readEvents(paths).find((e) => e.type === 'agent_parked');
  assert.equal(parked.hostHandoff, true);
  assert.equal(parked.ok, true);
  assert.ok(!readEvents(paths).some((e) => e.type === 'agent_end' && e.hostHandoff));
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

// ---- Model + effort flag emission (Wave 1) ----

test('claude gets a CLI-valid model alias and an --effort flag', () => {
  const inv = buildInvocation({ ...base, runner: 'claude', readOnly: false, model: 'opus-5', effort: 'high' });
  assert.equal(inv.args[inv.args.indexOf('--model') + 1], 'opus');
  assert.equal(inv.args[inv.args.indexOf('--effort') + 1], 'high');
});

test('cursor encodes effort in the model id and emits no --effort flag', () => {
  const inv = buildInvocation({ ...base, runner: 'cursor', readOnly: false, model: 'opus-5', effort: 'low' });
  assert.equal(inv.args[inv.args.indexOf('--model') + 1], 'claude-opus-5-low');
  assert.ok(!inv.args.includes('--effort'));
});

test('codex passes reasoning effort as a -c config override', () => {
  const inv = buildInvocation({ ...base, runner: 'codex', readOnly: false, model: 'gpt-5.5', effort: 'xhigh' });
  assert.equal(inv.args[inv.args.indexOf('--model') + 1], 'gpt-5.5');
  assert.ok(inv.args.includes('-c'));
  assert.ok(inv.args.includes('model_reasoning_effort="xhigh"'));
});

test('an invalid effort level is dropped rather than passed to the CLI', () => {
  const inv = buildInvocation({ ...base, runner: 'claude', readOnly: false, model: 'opus-5', effort: 'turbo' });
  assert.ok(!inv.args.includes('--effort'));
});

test('the current-chat sentinel emits no --model flag', () => {
  const inv = buildInvocation({ ...base, runner: 'claude', readOnly: false, model: 'current-chat', effort: 'high' });
  assert.ok(!inv.args.includes('--model'));
});

test('host handoff records the requested effort for the chat session', async () => {
  const { paths, promptFile } = tmpPipeline();
  await runAgent({
    runner: 'host', stage: 'planner', cycle: 1, task: 'plan it',
    systemPromptFile: promptFile, cwd: paths.root, paths, config: {},
    model: 'opus-5', effort: 'high', modelSelection: 'auto',
  });
  const handoff = JSON.parse(fs.readFileSync(paths.stageHandoff, 'utf8'));
  assert.equal(handoff.effort, 'high');
  assert.match(handoff.modelNote, /effort: high/i);
});

test('a configured custom runner is accepted in cli mode without an auth probe', () => {
  const config = { runner: 'fake', customRunners: { fake: { command: 'node', args: ['agent.mjs'] } } };
  assert.deepEqual(detectRunner(config, { invocationMode: 'cli' }), { runner: 'fake', runnerRequested: null });
});

test('an unknown runner with no custom definition is still rejected', () => {
  assert.throws(() => detectRunner({ runner: 'nope' }, { invocationMode: 'cli' }), /Unknown runner/);
});

test('an unknown runner in chat mode still throws before any coercion, never silently becomes host', () => {
  assert.throws(() => detectRunner({ runner: 'nope' }, { invocationMode: 'chat' }), /Unknown runner/);
});

test('chat mode coerces a forced external runner to host and records what was requested', () => {
  assert.deepEqual(detectRunner({ runner: 'cursor' }, { invocationMode: 'chat' }), { runner: 'host', runnerRequested: 'cursor' });
});

test('chat mode with runner already "host" is a no-op — runnerRequested stays null', () => {
  assert.deepEqual(detectRunner({ runner: 'host' }, { invocationMode: 'chat' }), { runner: 'host', runnerRequested: null });
});

test('chat mode with no forced runner (auto/unset) resolves straight to host, unchanged', () => {
  assert.deepEqual(detectRunner({ runner: 'auto' }, { invocationMode: 'chat' }), { runner: 'host', runnerRequested: null });
  assert.deepEqual(detectRunner({}, { invocationMode: 'chat' }), { runner: 'host', runnerRequested: null });
});

test('cli mode with a forced external runner is untouched — still returns that runner, still probes auth', () => {
  const config = { runner: 'fake', customRunners: { fake: { command: 'node', args: ['agent.mjs'] } } };
  assert.deepEqual(detectRunner(config, { invocationMode: 'cli' }), { runner: 'fake', runnerRequested: null });
});

test('resolveChatSafeRunner coerces only in chat mode for a non-host request', () => {
  assert.deepEqual(resolveChatSafeRunner('cursor', 'chat'), { runner: 'host', runnerRequested: 'cursor' });
  assert.deepEqual(resolveChatSafeRunner('cursor', 'cli'), { runner: 'cursor', runnerRequested: null });
  assert.deepEqual(resolveChatSafeRunner('host', 'chat'), { runner: 'host', runnerRequested: null });
  assert.deepEqual(resolveChatSafeRunner(null, 'chat'), { runner: null, runnerRequested: null });
});

test('reconcileChatRunner self-heals a run whose status already carries a mismatched runner+chat surface', () => {
  // The exact incident shape: a chat-mode run whose status.json recorded
  // runner:"cursor" alongside chat-mode metadata, from before this coercion
  // existed. The next --continue/--resume must converge it onto host.
  const result = reconcileChatRunner({
    runner: 'cursor', statusInvocationMode: 'chat', statusExecutionSurface: 'host-handoff', currentInvocationMode: 'cli',
  });
  assert.deepEqual(result, { runner: 'host', executionSurface: 'host-handoff', invocationMode: 'chat', runnerRequested: 'cursor' });
});

test('reconcileChatRunner converges a fresh --resume invoked from a live chat session even when the prior status was plain cli', () => {
  const result = reconcileChatRunner({
    runner: 'cursor', statusInvocationMode: 'cli', statusExecutionSurface: 'cli-subprocess', currentInvocationMode: 'chat',
  });
  assert.deepEqual(result, { runner: 'host', executionSurface: 'host-handoff', invocationMode: 'chat', runnerRequested: 'cursor' });
});

test('reconcileChatRunner is a no-op for a genuine cli-subprocess run resumed from a genuine terminal', () => {
  const result = reconcileChatRunner({
    runner: 'cursor', statusInvocationMode: 'cli', statusExecutionSurface: 'cli-subprocess', currentInvocationMode: 'cli',
  });
  assert.equal(result, null);
});

test('verified skill instructions are appended after the stage prompt, never before it', () => {
  const skills = { promptSection: '===== AVAILABLE SKILLS =====\nuse the thing', allowances: [], active: [] };
  const inv = buildInvocation({ ...base, runner: 'claude', readOnly: true, skills });
  const prompt = inv.args[inv.args.indexOf('--append-system-prompt') + 1];
  assert.ok(prompt.indexOf('sys') < prompt.indexOf('AVAILABLE SKILLS'), 'the trust boundary is read first');
});

test('a read-only stage gains only the skill read-only commands it declared', () => {
  const skills = { promptSection: 'x', allowances: ['Bash(node /skills/archify/bin/archify.mjs validate:*)'], active: [] };
  const allow = buildInvocation({ ...base, runner: 'claude', readOnly: true, skills }).args.join(' ');
  assert.match(allow, /archify\.mjs validate/);
  assert.doesNotMatch(allow, /deliver/);
  // Still no general write access.
  assert.doesNotMatch(allow, /acceptEdits/);
});

test('resolvePoolRunner passes an explicit runner through untouched', () => {
  assert.equal(resolvePoolRunner('claude'), 'claude');
  assert.equal(resolvePoolRunner('host'), 'host');
});

test('resolvePoolRunner never throws for auto/unset and always resolves to a real runner or host', () => {
  for (const requested of ['auto', null, undefined]) {
    const resolved = resolvePoolRunner(requested);
    assert.ok(Object.keys(RUNNER_BINS).includes(resolved), `"${resolved}" should be a known runner`);
  }
});

test('checkRunnerAvailable always accepts host', () => {
  assert.deepEqual(checkRunnerAvailable('host'), { ok: true });
});

test('checkRunnerAvailable rejects an unknown runner name with a clear reason', () => {
  const result = checkRunnerAvailable('nope');
  assert.equal(result.ok, false);
  assert.match(result.reason, /Unknown runner/);
});

test('checkRunnerAvailable accepts a configured custom runner without an auth probe', () => {
  const config = { customRunners: { fake: { command: 'node', args: ['agent.mjs'] } } };
  assert.deepEqual(checkRunnerAvailable('fake', config), { ok: true });
});

test('an agent process never receives forge credentials', () => {
  const env = agentEnv({ PATH: '/usr/bin', GH_TOKEN: 'secret', GITHUB_TOKEN: 'secret', GITLAB_TOKEN: 'secret', HOME: '/home/x' });
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.GITLAB_TOKEN, undefined);
  assert.equal(env.PATH, '/usr/bin', 'the rest of the environment survives');
});

test('cursor and codex streams use the shared JSON parser, not raw jsonl-or-text', () => {
  assert.equal(buildInvocation({ ...base, runner: 'cursor', readOnly: false }).parse, 'stream-json');
  assert.equal(buildInvocation({ ...base, runner: 'codex', readOnly: false }).parse, 'stream-json');
  assert.equal(buildInvocation({ ...base, runner: 'claude', readOnly: false }).parse, 'claude-stream-json');
});

test('a host runner is always a host-handoff, even when the CLI flag said cli', () => {
  assert.equal(resolveExecutionSurface({ runner: 'host', invocationMode: 'cli' }), 'host-handoff');
  assert.equal(resolveExecutionSurface({ runner: 'claude', invocationMode: 'cli' }), 'cli-subprocess');
  assert.equal(resolveExecutionSurface({ runner: 'claude', invocationMode: 'chat' }), 'host-handoff');
  assert.equal(isHostSurface({ runner: 'host' }), true);
  assert.equal(isHostSurface({ executionSurface: 'cli-subprocess', runner: 'host' }), false);
});
