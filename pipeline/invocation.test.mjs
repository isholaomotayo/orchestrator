import test from 'node:test';
import assert from 'node:assert/strict';
import { detectInvocationMode } from './invocation.mjs';

test('detectInvocationMode honors an explicit --mode flag', () => {
  assert.deepEqual(detectInvocationMode({ env: {}, argv: ['--mode', 'chat'] }), { mode: 'chat', source: 'flag' });
  assert.deepEqual(detectInvocationMode({ env: {}, argv: ['--mode', 'cli'] }), { mode: 'cli', source: 'flag' });
});

test('detectInvocationMode honors PIPELINE_INVOCATION env', () => {
  assert.equal(detectInvocationMode({ env: { PIPELINE_INVOCATION: 'chat' }, argv: [] }).mode, 'chat');
  assert.equal(detectInvocationMode({ env: { PIPELINE_INVOCATION: 'cli' }, argv: [] }).mode, 'cli');
});

test('detectInvocationMode forces cli under CI', () => {
  const res = detectInvocationMode({ env: { CI: 'true' }, argv: [] });
  assert.equal(res.mode, 'cli');
  assert.equal(res.source, 'ci');
});

test('detectInvocationMode detects IDE chat signals', () => {
  const res = detectInvocationMode({ env: { CURSOR_AGENT: '1' }, argv: [] });
  assert.equal(res.mode, 'chat');
  assert.equal(res.source, 'cursor_agent');
});
