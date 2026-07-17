import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveModelProfile, parseModelsJson, modelForStage, modelNote, mergeModelProfiles, DEFAULT_MODEL_PROFILES, MODEL_CATALOG, CURRENT_CHAT_MODEL } from './models.mjs';

const config = { modelProfiles: DEFAULT_MODEL_PROFILES };

test('resolveModelProfile auto picks per-runner defaults', () => {
  const res = resolveModelProfile({ config, runner: 'claude', profile: 'auto' });
  assert.equal(res.selection, 'auto');
  assert.equal(res.runner, 'claude');
  assert.equal(res.stages.planner, 'opus-4.8');
  assert.equal(res.stages.coder, 'sonnet-5');
});

test('resolveModelProfile auto picks gpt-5.5 for codex', () => {
  const res = resolveModelProfile({ config, runner: 'codex', profile: 'auto' });
  assert.equal(res.stages.planner, 'gpt-5.5');
  assert.equal(res.stages.coder, 'gpt-5.5');
  assert.equal(res.stages.tester, 'gpt-5.5');
  assert.equal(res.stages.reviewer, 'gpt-5.5');
});

test('MODEL_CATALOG groups providers with valid entries', () => {
  for (const provider of ['anthropic', 'openai', 'google', 'xai']) {
    assert.ok(Array.isArray(MODEL_CATALOG[provider]), `missing provider group: ${provider}`);
    assert.ok(MODEL_CATALOG[provider].length > 0, `empty provider group: ${provider}`);
    for (const entry of MODEL_CATALOG[provider]) {
      assert.equal(typeof entry.id, 'string');
      assert.ok(entry.id.trim(), 'catalog entry has empty id');
      assert.equal(typeof entry.label, 'string');
      assert.ok(entry.label.trim(), 'catalog entry has empty label');
    }
  }
  const ids = Object.values(MODEL_CATALOG).flat().map((m) => m.id);
  for (const expected of ['opus-4.8', 'sonnet-5', 'gpt-5.5', 'gemini-3.5-flash', 'gemini-3.1-pro', 'grok-4.5', 'grok-4.3']) {
    assert.ok(ids.includes(expected), `catalog missing expected model: ${expected}`);
  }
});

test('resolveModelProfile normalizes auto/undefined runner to host', () => {
  const res = resolveModelProfile({ config, runner: 'auto', profile: 'auto' });
  assert.equal(res.runner, 'host');
  // Unknown host environment: never assume a vendor's models exist there.
  assert.equal(res.stages.planner, CURRENT_CHAT_MODEL);
});

test('host runner with a known hostClient uses that ecosystem profile', () => {
  const antigravity = resolveModelProfile({ config, runner: 'host', profile: 'auto', hostClient: 'antigravity' });
  assert.equal(antigravity.stages.planner, 'gemini-3.1-pro');
  assert.equal(antigravity.stages.coder, 'gemini-3.5-flash');
  assert.equal(antigravity.stages.handoff, 'gemini-3.1-flash-lite');

  const claude = resolveModelProfile({ config, runner: 'host', profile: 'auto', hostClient: 'claude' });
  assert.equal(claude.stages.planner, 'opus-4.8');
  assert.equal(claude.stages.coder, 'sonnet-5');

  const codex = resolveModelProfile({ config, runner: 'host', profile: 'auto', hostClient: 'codex' });
  assert.equal(codex.stages.planner, 'gpt-5.5');
});

test('host runner with unknown/absent hostClient falls back to current-chat for all stages', () => {
  for (const hostClient of [null, undefined, 'vscode', 'mystery-ide']) {
    const res = resolveModelProfile({ config, runner: 'host', profile: 'auto', hostClient });
    for (const stage of ['planner', 'designer', 'coder', 'tester', 'reviewer', 'handoff']) {
      assert.equal(res.stages[stage], CURRENT_CHAT_MODEL, `stage ${stage} for hostClient ${hostClient}`);
    }
  }
});

test('non-host runners ignore hostClient', () => {
  const res = resolveModelProfile({ config, runner: 'codex', profile: 'auto', hostClient: 'antigravity' });
  assert.equal(res.stages.planner, 'gpt-5.5');
});

test('MODEL_CATALOG offers the current-chat sentinel in the host group', () => {
  assert.ok(MODEL_CATALOG.host.some((m) => m.id === CURRENT_CHAT_MODEL));
});

test('modelNote handles the current-chat sentinel and real models', () => {
  assert.match(modelNote(CURRENT_CHAT_MODEL), /active chat model/i);
  const note = modelNote('opus-4.8');
  assert.match(note, /opus-4\.8/);
  assert.match(note, /if available in this environment/i);
  assert.match(note, /actualModel/);
});

test('mergeModelProfiles honors a config antigravity override', () => {
  const merged = mergeModelProfiles({ modelProfiles: { auto: { antigravity: { coder: 'custom-model' } } } });
  assert.equal(merged.auto.antigravity.coder, 'custom-model');
  assert.equal(merged.auto.antigravity.planner, 'gemini-3.1-pro'); // untouched defaults survive
  const res = resolveModelProfile({ config: { modelProfiles: merged }, runner: 'host', profile: 'auto', hostClient: 'antigravity' });
  assert.equal(res.stages.coder, 'custom-model');
});

test('resolveModelProfile manual requires all four stages', () => {
  assert.throws(() => resolveModelProfile({ config, runner: 'host', profile: 'manual', manualStages: { planner: 'a' } }));
  const ok = resolveModelProfile({
    config, runner: 'host', profile: 'manual',
    manualStages: { planner: 'a', coder: 'b', tester: 'c', reviewer: 'd' },
  });
  assert.equal(ok.selection, 'manual');
  assert.deepEqual(ok.stages, { planner: 'a', coder: 'b', tester: 'c', reviewer: 'd', designer: 'a', handoff: 'd' });
});

test('parseModelsJson validates shape', () => {
  assert.equal(parseModelsJson(null), null);
  assert.throws(() => parseModelsJson('{ not json'));
  assert.throws(() => parseModelsJson('{"planner":"a"}'));
  assert.deepEqual(
    parseModelsJson('{"planner":"a","coder":"b","tester":"c","reviewer":"d"}'),
    { planner: 'a', coder: 'b', tester: 'c', reviewer: 'd', designer: 'a', handoff: 'd' },
  );
});

test('modelForStage reads the resolved stage map', () => {
  const models = { stages: { planner: 'opus', coder: 'sonnet' } };
  assert.equal(modelForStage(models, 'planner'), 'opus');
  assert.equal(modelForStage(models, 'missing'), null);
  assert.equal(modelForStage(null, 'planner'), null);
});

test('auto profiles include designer and handoff for every runner', () => {
  for (const runner of ['host', 'claude', 'cursor', 'codex', 'gemini']) {
    const m = resolveModelProfile({ config: {}, runner, profile: 'auto' });
    assert.ok(m.stages.designer, `${runner} missing designer`);
    assert.ok(m.stages.handoff, `${runner} missing handoff`);
  }
});

test('manual models accepts the 4 core stages and derives optional ones', () => {
  const m = resolveModelProfile({
    config: {}, runner: 'claude', profile: 'manual',
    manualStages: { planner: 'p-model', coder: 'c-model', tester: 't-model', reviewer: 'r-model' },
  });
  assert.equal(m.stages.designer, 'p-model'); // planner tier: architecture work
  assert.equal(m.stages.handoff, 'r-model');  // reviewer tier: summarisation
});

test('manual models honors explicit designer/handoff entries', () => {
  const m = resolveModelProfile({
    config: {}, runner: 'claude', profile: 'manual',
    manualStages: { planner: 'p', coder: 'c', tester: 't', reviewer: 'r', designer: 'd', handoff: 'h' },
  });
  assert.equal(m.stages.designer, 'd');
  assert.equal(m.stages.handoff, 'h');
});

test('manual models still rejects a missing core stage', () => {
  assert.throws(() => resolveModelProfile({
    config: {}, runner: 'claude', profile: 'manual',
    manualStages: { planner: 'p', coder: 'c', tester: 't' },
  }), /reviewer/);
});
