import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveModelProfile, parseModelsJson, modelForStage, effortForStage, modelNote, mergeModelProfiles, resolveModelId, isKnownFamily, normalizeEffort, unknownFamilies, DEFAULT_MODEL_PROFILES, DEFAULT_STAGE_EFFORT, EFFORT_LEVELS, MODEL_CATALOG, CURRENT_CHAT_MODEL } from './models.mjs';

const config = { modelProfiles: DEFAULT_MODEL_PROFILES };

test('resolveModelProfile auto picks per-runner defaults', () => {
  const res = resolveModelProfile({ config, runner: 'claude', profile: 'auto' });
  assert.equal(res.selection, 'auto');
  assert.equal(res.runner, 'claude');
  assert.equal(res.stages.planner, 'opus-5');
  assert.equal(res.stages.coder, 'sonnet-5');
});

test('resolveModelProfile auto picks the OpenAI ladder for codex', () => {
  const res = resolveModelProfile({ config, runner: 'codex', profile: 'auto' });
  assert.equal(res.stages.planner, 'gpt-5.6-sol');
  assert.equal(res.stages.coder, 'gpt-5.5');
  assert.equal(res.stages.tester, 'gpt-5.5');
  assert.equal(res.stages.reviewer, 'gpt-5.6-sol');
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
  for (const expected of ['opus-5', 'sonnet-5', 'haiku-4.5', 'fable-5', 'gpt-5.5', 'gemini-3.5-flash', 'gemini-3.1-pro', 'grok-4.5']) {
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
  assert.equal(antigravity.stages.coder, 'gemini-3.6-flash');
  assert.equal(antigravity.stages.handoff, 'gemini-3.5-flash');

  const claude = resolveModelProfile({ config, runner: 'host', profile: 'auto', hostClient: 'claude' });
  assert.equal(claude.stages.planner, 'opus-5');
  assert.equal(claude.stages.coder, 'sonnet-5');

  const codex = resolveModelProfile({ config, runner: 'host', profile: 'auto', hostClient: 'codex' });
  assert.equal(codex.stages.planner, 'gpt-5.6-sol');
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
  assert.equal(res.stages.planner, 'gpt-5.6-sol');
});

test('MODEL_CATALOG offers the current-chat sentinel in the host group', () => {
  assert.ok(MODEL_CATALOG.host.some((m) => m.id === CURRENT_CHAT_MODEL));
});

test('modelNote handles the current-chat sentinel and real models', () => {
  assert.match(modelNote(CURRENT_CHAT_MODEL), /active chat model/i);
  const note = modelNote('opus-5');
  assert.match(note, /opus-5/);
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

// ---- Runner-native model id resolution (Wave 1) ----

test('resolveModelId maps families to claude CLI aliases', () => {
  assert.equal(resolveModelId('opus-5', 'claude'), 'opus');
  assert.equal(resolveModelId('sonnet-5', 'claude'), 'sonnet');
  assert.equal(resolveModelId('haiku-4.5', 'claude'), 'haiku');
  assert.equal(resolveModelId('fable-5', 'claude'), 'fable');
});

test('resolveModelId maps families to cursor-agent model ids', () => {
  assert.equal(resolveModelId('opus-5', 'cursor'), 'claude-opus-5');
  assert.equal(resolveModelId('sonnet-5', 'cursor'), 'claude-sonnet-5');
  assert.equal(resolveModelId('gpt-5.5', 'cursor'), 'gpt-5.5-high');
});

test('resolveModelId encodes effort in the cursor model id', () => {
  assert.equal(resolveModelId('opus-5', 'cursor', 'low'), 'claude-opus-5-low');
  assert.equal(resolveModelId('opus-5', 'cursor', 'high'), 'claude-opus-5-thinking-high');
  assert.equal(resolveModelId('opus-5', 'cursor', 'xhigh'), 'claude-opus-5-thinking-xhigh');
  // A family with no per-effort variant falls back to its base id.
  assert.equal(resolveModelId('gemini-3.1-pro', 'cursor', 'high'), 'gemini-3.1-pro');
});

test('resolveModelId passes unknown ids through verbatim', () => {
  assert.equal(resolveModelId('my-org/custom-model', 'claude'), 'my-org/custom-model');
  assert.equal(resolveModelId('gpt-5.5', 'codex'), 'gpt-5.5'); // identity runner
});

test('resolveModelId returns null for the current-chat sentinel', () => {
  assert.equal(resolveModelId(CURRENT_CHAT_MODEL, 'claude'), null);
  assert.equal(resolveModelId(null, 'claude'), null);
});

test('isKnownFamily flags ids absent from the catalog', () => {
  assert.ok(isKnownFamily('opus-5'));
  assert.ok(isKnownFamily(CURRENT_CHAT_MODEL));
  assert.ok(!isKnownFamily('opus-4.8')); // the stale pre-Wave-1 id
  assert.deepEqual(unknownFamilies({ planner: 'opus-5', coder: 'made-up' }), ['made-up']);
});

// ---- Reasoning effort (Wave 1) ----

test('normalizeEffort accepts the ladder and rejects anything else', () => {
  for (const level of EFFORT_LEVELS) assert.equal(normalizeEffort(level), level);
  assert.equal(normalizeEffort('HIGH'), 'high');
  assert.equal(normalizeEffort('turbo'), null);
  assert.equal(normalizeEffort(undefined), null);
});

test('resolveModelProfile attaches a per-stage effort map', () => {
  const res = resolveModelProfile({ config, runner: 'claude', profile: 'auto' });
  assert.equal(res.effort.planner, 'high');
  assert.equal(res.effort.coder, 'medium');
  assert.equal(res.effort.handoff, 'low');
  assert.deepEqual(Object.keys(res.effort).sort(), Object.keys(res.stages).sort());
});

test('config.stageEffort overrides the default ladder, invalid values ignored', () => {
  const res = resolveModelProfile({
    config: { ...config, stageEffort: { coder: 'xhigh', tester: 'nonsense' } },
    runner: 'claude', profile: 'auto',
  });
  assert.equal(res.effort.coder, 'xhigh');
  assert.equal(res.effort.tester, DEFAULT_STAGE_EFFORT.tester);
});

test('effortForStage falls back to the default ladder', () => {
  assert.equal(effortForStage({ effort: { planner: 'max' } }, 'planner'), 'max');
  assert.equal(effortForStage(null, 'reviewer'), DEFAULT_STAGE_EFFORT.reviewer);
});

test('modelNote mentions the effort target when one is set', () => {
  assert.match(modelNote('opus-5', 'high'), /effort: high/i);
  assert.match(modelNote(CURRENT_CHAT_MODEL, 'low'), /effort: low/i);
  assert.doesNotMatch(modelNote('opus-5'), /effort/i);
});
