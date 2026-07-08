// Regression + security-vector coverage locking in the production-readiness
// fixes from .pipeline/changes.md. Each test maps to a specific finding.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isTrustedRequest } from './http-guard.mjs';
import { buildInvocation } from './adapters.mjs';
import { loadConfig, atomicWrite, newStatus } from './state.mjs';
import { mergeModelProfiles, DEFAULT_MODEL_PROFILES } from './models.mjs';

// ---- P0-3: origin guard — security vectors ---------------------------------

test('[P0-3] IPv6 loopback Host is trusted', () => {
  assert.equal(isTrustedRequest({ host: '[::1]:4600' }, 4600), true);
});

test('[P0-3] Origin "null" (opaque, e.g. file://) falls back to Host check', () => {
  assert.equal(isTrustedRequest({ host: '127.0.0.1:4600', origin: 'null' }, 4600), true);
});

test('[P0-3] malformed Origin is rejected', () => {
  assert.equal(isTrustedRequest({ host: '127.0.0.1:4600', origin: ':://not a url' }, 4600), false);
});

test('[P0-3] rebinding to a subdomain of localhost is rejected', () => {
  assert.equal(isTrustedRequest({ host: 'localhost.evil.com:4600' }, 4600), false);
});

test('[P0-3] https loopback origin on default 443 is rejected against port 4600', () => {
  assert.equal(isTrustedRequest({ host: '127.0.0.1:4600', origin: 'https://127.0.0.1' }, 4600), false);
});

// ---- P0-2: read-only never leaks a write flag ------------------------------

const base = { systemPrompt: 's', task: 't', config: {}, model: null };

test('[P0-2] no read-only invocation contains an auto-approve/write flag', () => {
  for (const runner of ['claude', 'cursor', 'codex', 'gemini']) {
    const inv = buildInvocation({ ...base, runner, readOnly: true });
    const joined = inv.args.join(' ');
    assert.ok(!joined.includes('--force'), `${runner} leaked --force`);
    assert.ok(!joined.includes('--full-auto'), `${runner} leaked --full-auto`);
    assert.ok(!joined.includes('--yolo'), `${runner} leaked --yolo`);
    assert.ok(!joined.includes('acceptEdits'), `${runner} leaked acceptEdits`);
  }
});

test('[P0-2] custom runner substitutes {task}/{readOnly} placeholders', () => {
  const config = { customRunners: { my: { command: 'mytool', args: ['--in', '{task}', '--ro', '{readOnly}'] } } };
  const inv = buildInvocation({ systemPrompt: 's', task: 'hello', config, runner: 'my', readOnly: true });
  assert.equal(inv.bin, 'mytool');
  assert.deepEqual(inv.args, ['--in', 'hello', '--ro', 'true']);
  assert.equal(inv.readOnlyEnforced, false);
});

// ---- P1-1: atomic writes never leave partial content -----------------------

test('[P1-1] atomicWrite result is always complete and parseable JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-'));
  const file = path.join(dir, 'status.json');
  const big = JSON.stringify(newStatus('x'.repeat(5000)), null, 2);
  atomicWrite(file, big);
  const readBack = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(readBack.overall, 'running');
  assert.equal(readBack.stages.length, 4);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- P2: config robustness -------------------------------------------------

test('[P2] loadConfig merges custom checks while keeping defaults', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ checks: { test: 'pytest -q' } }));
  const cfg = loadConfig({ config: cfgPath });
  assert.equal(cfg.checks.test, 'pytest -q');
  assert.match(cfg.checks.lint, /--if-present/); // default preserved
  fs.rmSync(dir, { recursive: true, force: true });
});

test('[P2] loadConfig tolerates malformed JSON and returns defaults', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, '{ this is not json');
  const cfg = loadConfig({ config: cfgPath });
  assert.equal(cfg.uiPort, 4600);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('[P2] mergeModelProfiles overlays config overrides onto defaults', () => {
  const merged = mergeModelProfiles({ modelProfiles: { auto: { claude: { planner: 'opus-custom' } } } });
  assert.equal(merged.auto.claude.planner, 'opus-custom');
  assert.equal(merged.auto.claude.coder, DEFAULT_MODEL_PROFILES.auto.claude.coder); // untouched
  assert.equal(merged.auto.host.planner, DEFAULT_MODEL_PROFILES.auto.host.planner);
});

// ---- newStatus shape guard -------------------------------------------------

test('newStatus initializes a 4-stage running pipeline with coder budget', () => {
  const s = newStatus('do a thing');
  assert.equal(s.task, 'do a thing');
  assert.equal(s.overall, 'running');
  assert.deepEqual(s.stages.map((x) => x.name), ['planner', 'coder', 'tester', 'reviewer']);
  assert.equal(s.stages.find((x) => x.name === 'coder').maxCycles, 5);
});
