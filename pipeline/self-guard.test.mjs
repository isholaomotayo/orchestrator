import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SELF_MARKERS, isOrchestratorSourceRepo, selfTargetAllowed, selfGuardMessage } from './self-guard.mjs';

function tmpRepo(files = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-guard-'));
  for (const f of files) {
    fs.mkdirSync(path.join(dir, path.dirname(f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), 'x');
  }
  return dir;
}

test('source repo layout (both markers) is detected', () => {
  const dir = tmpRepo(SELF_MARKERS);
  assert.equal(isOrchestratorSourceRepo(dir), true);
});

test('consumer layout (no root skills/) is not the source repo', () => {
  const dir = tmpRepo(['pipeline/orchestrator.mjs', '.pipeline/orchestrate.sh']);
  assert.equal(isOrchestratorSourceRepo(dir), false);
});

test('consumer after bootstrap (.agents/.gemini skill copies) is not the source repo', () => {
  // Regression test: the installed skill copies live under .agents/skills/ and
  // .gemini/skills/ — NOT the marker path skills/orchestrate/SKILL.md.
  const dir = tmpRepo([
    'pipeline/orchestrator.mjs',
    '.pipeline/orchestrate.sh',
    '.agents/skills/orchestrate/SKILL.md',
    '.agents/workflows/orchestrate.md',
    '.agent/rules/orchestrate.md',
    '.gemini/skills/orchestrate/SKILL.md',
  ]);
  assert.equal(isOrchestratorSourceRepo(dir), false);
});

test('empty directory is not the source repo', () => {
  const dir = tmpRepo([]);
  assert.equal(isOrchestratorSourceRepo(dir), false);
});

test('selfTargetAllowed honors the flag, the env var, and neither', () => {
  assert.equal(selfTargetAllowed({ env: {}, allowSelfFlag: true }), true);
  assert.equal(selfTargetAllowed({ env: { ORCH_ALLOW_SELF: '1' }, allowSelfFlag: false }), true);
  assert.equal(selfTargetAllowed({ env: { ORCH_ALLOW_SELF: '0' }, allowSelfFlag: false }), false);
  assert.equal(selfTargetAllowed({ env: {}, allowSelfFlag: false }), false);
});

test('selfGuardMessage names both overrides and the markers', () => {
  const msg = selfGuardMessage('/some/repo');
  assert.match(msg, /--allow-self/);
  assert.match(msg, /ORCH_ALLOW_SELF=1/);
  for (const marker of SELF_MARKERS) assert.ok(msg.includes(marker), `message missing marker ${marker}`);
});
