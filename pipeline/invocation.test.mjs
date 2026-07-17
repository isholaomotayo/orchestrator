import test from 'node:test';
import assert from 'node:assert/strict';
import { detectInvocationMode, detectHostClient, normalizeHostClient } from './invocation.mjs';

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

test('--host-client implies chat mode', () => {
  assert.deepEqual(
    detectInvocationMode({ env: {}, argv: ['--host-client', 'antigravity'] }),
    { mode: 'chat', source: 'host-client-flag' },
  );
});

test('PIPELINE_HOST_CLIENT implies chat mode and outranks CI', () => {
  assert.deepEqual(
    detectInvocationMode({ env: { PIPELINE_HOST_CLIENT: 'antigravity', CI: 'true' }, argv: [] }),
    { mode: 'chat', source: 'host-client-env' },
  );
});

test('explicit --mode cli still outranks host-client signals', () => {
  assert.deepEqual(
    detectInvocationMode({ env: { PIPELINE_HOST_CLIENT: 'antigravity' }, argv: ['--mode', 'cli', '--host-client', 'antigravity'] }),
    { mode: 'cli', source: 'flag' },
  );
});

test('any ANTIGRAVITY* env var means chat mode', () => {
  assert.deepEqual(
    detectInvocationMode({ env: { ANTIGRAVITY_AGENT: '1' }, argv: [] }),
    { mode: 'chat', source: 'antigravity' },
  );
});

test('normalizeHostClient trims, lowercases, and maps aliases', () => {
  assert.equal(normalizeHostClient(' AGY '), 'antigravity');
  assert.equal(normalizeHostClient('claude-code'), 'claude');
  assert.equal(normalizeHostClient('cursor-agent'), 'cursor');
  assert.equal(normalizeHostClient('Antigravity'), 'antigravity');
  assert.equal(normalizeHostClient(''), null);
  assert.equal(normalizeHostClient(null), null);
});

test('detectHostClient precedence: flag > env var > env signals', () => {
  assert.equal(detectHostClient({ env: { PIPELINE_HOST_CLIENT: 'cursor' }, argv: ['--host-client', 'antigravity'] }), 'antigravity');
  assert.equal(detectHostClient({ env: { PIPELINE_HOST_CLIENT: 'AGY', CURSOR_AGENT: '1' }, argv: [] }), 'antigravity');
  assert.equal(detectHostClient({ env: { ANTIGRAVITY_WORKSPACE: '/x', CURSOR_AGENT: '1' }, argv: [] }), 'antigravity');
  assert.equal(detectHostClient({ env: { CURSOR_TRACE_ID: 'abc' }, argv: [] }), 'cursor');
  assert.equal(detectHostClient({ env: { CLAUDECODE: '1' }, argv: [] }), 'claude');
  assert.equal(detectHostClient({ env: { CODEX_IN_IDE: '1' }, argv: [] }), 'codex');
  assert.equal(detectHostClient({ env: { GEMINI_CLI_IDE: '1' }, argv: [] }), 'gemini');
  assert.equal(detectHostClient({ env: { VSCODE_PID: '123' }, argv: [] }), 'vscode');
  assert.equal(detectHostClient({ env: {}, argv: [] }), null);
});
