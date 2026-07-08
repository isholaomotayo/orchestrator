import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveModelProfile, parseModelsJson, modelForStage, DEFAULT_MODEL_PROFILES } from './models.mjs';

const config = { modelProfiles: DEFAULT_MODEL_PROFILES };

test('resolveModelProfile auto picks per-runner defaults', () => {
  const res = resolveModelProfile({ config, runner: 'claude', profile: 'auto' });
  assert.equal(res.selection, 'auto');
  assert.equal(res.runner, 'claude');
  assert.equal(res.stages.planner, 'opus');
  assert.equal(res.stages.coder, 'sonnet');
});

test('resolveModelProfile normalizes auto/undefined runner to host', () => {
  const res = resolveModelProfile({ config, runner: 'auto', profile: 'auto' });
  assert.equal(res.runner, 'host');
  assert.equal(res.stages.planner, 'opus-4');
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
