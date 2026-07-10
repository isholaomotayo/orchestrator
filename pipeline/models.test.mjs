import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveModelProfile, parseModelsJson, modelForStage, DEFAULT_MODEL_PROFILES, MODEL_CATALOG } from './models.mjs';

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
  assert.equal(res.stages.planner, 'opus-4.8');
});

test('resolveModelProfile manual requires all four stages', () => {
  assert.throws(() => resolveModelProfile({ config, runner: 'host', profile: 'manual', manualStages: { planner: 'a' } }));
  const ok = resolveModelProfile({
    config, runner: 'host', profile: 'manual',
    manualStages: { planner: 'a', coder: 'b', tester: 'c', reviewer: 'd' },
  });
  assert.equal(ok.selection, 'manual');
  assert.deepEqual(ok.stages, { planner: 'a', coder: 'b', tester: 'c', reviewer: 'd' });
});

test('parseModelsJson validates shape', () => {
  assert.equal(parseModelsJson(null), null);
  assert.throws(() => parseModelsJson('{ not json'));
  assert.throws(() => parseModelsJson('{"planner":"a"}'));
  assert.deepEqual(
    parseModelsJson('{"planner":"a","coder":"b","tester":"c","reviewer":"d"}'),
    { planner: 'a', coder: 'b', tester: 'c', reviewer: 'd' },
  );
});

test('modelForStage reads the resolved stage map', () => {
  const models = { stages: { planner: 'opus', coder: 'sonnet' } };
  assert.equal(modelForStage(models, 'planner'), 'opus');
  assert.equal(modelForStage(models, 'missing'), null);
  assert.equal(modelForStage(null, 'planner'), null);
});
