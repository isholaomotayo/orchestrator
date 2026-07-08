import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInvocation } from './adapters.mjs';

const base = { systemPrompt: 'sys', task: 'do it', config: {}, model: null };

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
