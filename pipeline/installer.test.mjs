import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  MANAGED, listManaged, planUpdate, applyUpdate, nextManifestFiles,
  manifestFilesAfterInstall, shouldCheck, resolveEngineEntry, summarize, isValidSource, CHECK_TTL_MS,
} from './installer.mjs';
import { SELF_MARKERS } from './self-guard.mjs';

function tmpDir(prefix, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  for (const [rel, body] of Object.entries(files)) write(dir, rel, body);
  return dir;
}
function write(root, rel, body) {
  fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), body);
}
function read(root, rel) {
  try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return null; }
}

// A minimal source tree covering one file of each class plus both skill copies.
const SRC_FILES = {
  'pipeline/orchestrator.mjs': 'engine v2',
  'pipeline/state.mjs': 'state v2',
  '.pipeline/orchestrate.sh': 'entrypoint v2',
  '.pipeline/skill.json': '{"v":2}',
  '.pipeline/prompts/coder_prompt.txt': 'coder v2',
  '.pipeline/prompts/tester_prompt.txt': 'tester v2',
  'skills/orchestrate/SKILL.md': 'skill v2',
  'skills/orchestrate/REFERENCE.md': 'reference v2',
  'skills/orchestrate/scripts/bootstrap.sh': 'bootstrap v2',
  '.cursorrules': 'cursor v2',
  'package.json': '{"version":"2.0.0"}',
};

function sources() { return tmpDir('orch-src-', SRC_FILES); }

test('listManaged maps the skill out of the self-guard marker path', () => {
  const src = sources();
  const dests = listManaged(src).map((m) => m.dest);
  // Regression guard: writing skills/orchestrate/SKILL.md into a consumer would
  // make it look like the orchestrator source repo to self-guard.mjs.
  assert.ok(!dests.includes('skills/orchestrate/SKILL.md'));
  assert.ok(dests.includes('.agents/skills/orchestrate/SKILL.md'));
  assert.ok(dests.includes('.gemini/skills/orchestrate/SKILL.md'));
  assert.ok(dests.includes('pipeline/orchestrator.mjs'));
  for (const marker of SELF_MARKERS.filter((m) => m.startsWith('skills/'))) {
    assert.ok(!dests.includes(marker), `must not deliver marker ${marker}`);
  }
});

test('.gemini copy receives only the docs, not the scripts', () => {
  const dests = listManaged(sources()).map((m) => m.dest);
  assert.ok(dests.includes('.gemini/skills/orchestrate/REFERENCE.md'));
  assert.ok(!dests.includes('.gemini/skills/orchestrate/scripts/bootstrap.sh'));
  assert.ok(dests.includes('.agents/skills/orchestrate/scripts/bootstrap.sh'));
});

test('config.json and run state are outside the managed set entirely', () => {
  const managed = MANAGED.flatMap((m) => [m.src, m.dest]);
  for (const untouchable of ['.pipeline/config.json', '.pipeline/status.json', '.pipeline/runs', 'AGENTS.md', 'CLAUDE.md', 'package.json']) {
    assert.ok(!managed.includes(untouchable), `${untouchable} must never be managed`);
  }
});

test('missing files are installed', () => {
  const src = sources();
  const repo = tmpDir('orch-repo-');
  const plan = planUpdate({ repoRoot: repo, srcRoot: src, manifest: null });
  assert.equal(plan.overwrite.length, 0);
  assert.ok(plan.install.some((i) => i.dest === 'pipeline/orchestrator.mjs'));
  applyUpdate(plan, { repoRoot: repo, srcRoot: src });
  assert.equal(read(repo, 'pipeline/orchestrator.mjs'), 'engine v2');
  assert.equal(read(repo, '.pipeline/prompts/coder_prompt.txt'), 'coder v2');
});

test('an unmodified tunable file is overwritten; an edited one is preserved with .new beside it', () => {
  const src = sources();
  const repo = tmpDir('orch-repo-', {
    'pipeline/orchestrator.mjs': 'engine v1',
    '.pipeline/prompts/coder_prompt.txt': 'coder v1 with my tuning',
    '.pipeline/prompts/tester_prompt.txt': 'tester v1',
  });
  // Manifest says we delivered v1 for both prompts; the coder one was then edited.
  const manifest = { files: {
    '.pipeline/prompts/coder_prompt.txt': 'deadbeef',        // no longer matches disk
    '.pipeline/prompts/tester_prompt.txt': manifestHash(repo, '.pipeline/prompts/tester_prompt.txt'),
  } };
  const plan = planUpdate({ repoRoot: repo, srcRoot: src, manifest });
  assert.ok(plan.preserve.some((i) => i.dest === '.pipeline/prompts/coder_prompt.txt'));
  assert.ok(plan.overwrite.some((i) => i.dest === '.pipeline/prompts/tester_prompt.txt'));

  applyUpdate(plan, { repoRoot: repo, srcRoot: src });
  assert.equal(read(repo, '.pipeline/prompts/coder_prompt.txt'), 'coder v1 with my tuning');
  assert.equal(read(repo, '.pipeline/prompts/coder_prompt.txt.new'), 'coder v2');
  assert.equal(read(repo, '.pipeline/prompts/tester_prompt.txt'), 'tester v2');
});

test('engine files overwrite even when locally modified', () => {
  const src = sources();
  const repo = tmpDir('orch-repo-', {
    'pipeline/orchestrator.mjs': 'engine v1 hand-hacked',
    '.pipeline/orchestrate.sh': 'entrypoint v1 hand-hacked',
  });
  const plan = planUpdate({ repoRoot: repo, srcRoot: src, manifest: { files: {} } });
  assert.ok(plan.overwrite.some((i) => i.dest === 'pipeline/orchestrator.mjs'));
  assert.ok(plan.overwrite.some((i) => i.dest === '.pipeline/orchestrate.sh'));
  applyUpdate(plan, { repoRoot: repo, srcRoot: src });
  assert.equal(read(repo, 'pipeline/orchestrator.mjs'), 'engine v2');
  assert.equal(read(repo, 'pipeline/orchestrator.mjs.new'), null, 'engine files update in place, no .new');
});

test('with no manifest at all, only engine files are updated', () => {
  const src = sources();
  const repo = tmpDir('orch-repo-', {
    'pipeline/orchestrator.mjs': 'engine v1',
    '.pipeline/prompts/coder_prompt.txt': 'coder v1',
    '.cursorrules': 'cursor v1',
  });
  const plan = planUpdate({ repoRoot: repo, srcRoot: src, manifest: null });
  const overwritten = plan.overwrite.map((i) => i.dest);
  assert.deepEqual(overwritten.sort(), ['pipeline/orchestrator.mjs']);
  assert.ok(plan.preserve.some((i) => i.dest === '.pipeline/prompts/coder_prompt.txt'));
  assert.ok(plan.preserve.some((i) => i.dest === '.cursorrules'));
});

test('--force overwrites edited tunable files too', () => {
  const src = sources();
  const repo = tmpDir('orch-repo-', { '.pipeline/prompts/coder_prompt.txt': 'coder v1 tuned' });
  const plan = planUpdate({ repoRoot: repo, srcRoot: src, manifest: null, force: true });
  assert.ok(plan.overwrite.some((i) => i.dest === '.pipeline/prompts/coder_prompt.txt'));
  assert.equal(plan.preserve.length, 0);
});

test('identical files are a no-op', () => {
  const src = sources();
  const repo = tmpDir('orch-repo-', { 'pipeline/orchestrator.mjs': 'engine v2' });
  const plan = planUpdate({ repoRoot: repo, srcRoot: src, manifest: null });
  assert.ok(plan.unchanged.some((i) => i.dest === 'pipeline/orchestrator.mjs'));
  assert.ok(!plan.overwrite.some((i) => i.dest === 'pipeline/orchestrator.mjs'));
});

test('a file dropped upstream is removed when untouched, kept when edited', () => {
  const src = sources();
  const repo = tmpDir('orch-repo-', {
    'pipeline/retired.mjs': 'old module',
    'pipeline/retired-but-edited.mjs': 'my version',
  });
  const manifest = { files: {
    'pipeline/retired.mjs': manifestHash(repo, 'pipeline/retired.mjs'),
    'pipeline/retired-but-edited.mjs': 'deadbeef',
  } };
  const plan = planUpdate({ repoRoot: repo, srcRoot: src, manifest });
  assert.deepEqual(plan.remove.map((i) => i.dest), ['pipeline/retired.mjs']);
  assert.deepEqual(plan.keepStale.map((i) => i.dest), ['pipeline/retired-but-edited.mjs']);
  applyUpdate(plan, { repoRoot: repo, srcRoot: src });
  assert.equal(read(repo, 'pipeline/retired.mjs'), null);
  assert.equal(read(repo, 'pipeline/retired-but-edited.mjs'), 'my version');
});

test('a bogus source is rejected, and never reads as "upstream deleted everything"', () => {
  // Regression: pointing --src at an unrelated directory made every manifest
  // entry look dropped upstream, and the update deleted the whole scaffold.
  const empty = tmpDir('orch-empty-');
  assert.equal(isValidSource(empty), false);
  assert.equal(isValidSource(sources()), true);

  const repo = tmpDir('orch-repo-', {
    'pipeline/orchestrator.mjs': 'engine v1',
    '.pipeline/prompts/coder_prompt.txt': 'coder v1',
  });
  const manifest = { files: {
    'pipeline/orchestrator.mjs': manifestHash(repo, 'pipeline/orchestrator.mjs'),
    '.pipeline/prompts/coder_prompt.txt': manifestHash(repo, '.pipeline/prompts/coder_prompt.txt'),
  } };
  const plan = planUpdate({ repoRoot: repo, srcRoot: empty, manifest });
  assert.deepEqual(plan.remove, [], 'an empty source must not schedule deletions');
  assert.deepEqual(plan.keepStale, []);
});

test('a preserved file stops being re-offered once its .new is current', () => {
  const src = sources();
  const repo = tmpDir('orch-repo-', { '.pipeline/prompts/coder_prompt.txt': 'coder v1 tuned' });
  const first = planUpdate({ repoRoot: repo, srcRoot: src, manifest: null });
  assert.ok(first.preserve.some((i) => i.dest === '.pipeline/prompts/coder_prompt.txt'));
  applyUpdate(first, { repoRoot: repo, srcRoot: src });

  const second = planUpdate({ repoRoot: repo, srcRoot: src, manifest: null });
  assert.ok(!second.preserve.some((i) => i.dest === '.pipeline/prompts/coder_prompt.txt'));
  assert.ok(second.alreadyOffered.some((i) => i.dest === '.pipeline/prompts/coder_prompt.txt'));
  // …and it must not leak into the manifest as if we had delivered it.
  const files = nextManifestFiles(second, { srcRoot: src, previous: {} });
  assert.equal(files['.pipeline/prompts/coder_prompt.txt'], undefined);
});

test('the manifest records delivered upstream bytes, so a preserved edit stays protected', () => {
  const src = sources();
  const repo = tmpDir('orch-repo-', { '.pipeline/prompts/coder_prompt.txt': 'coder v1 tuned' });
  const previous = { '.pipeline/prompts/coder_prompt.txt': 'hash-of-v1' };
  const plan = planUpdate({ repoRoot: repo, srcRoot: src, manifest: { files: previous } });
  const files = nextManifestFiles(plan, { srcRoot: src, previous });
  // Preserved: the entry must NOT advance to v2 (we never delivered it) and must
  // NOT become the user's own hash (that would look pristine next time).
  assert.equal(files['.pipeline/prompts/coder_prompt.txt'], 'hash-of-v1');
  assert.notEqual(files['pipeline/orchestrator.mjs'], undefined);

  // Second update with the same source: never silently clobbered.
  applyUpdate(plan, { repoRoot: repo, srcRoot: src });
  const again = planUpdate({ repoRoot: repo, srcRoot: src, manifest: { files } });
  assert.ok(!again.overwrite.some((i) => i.dest === '.pipeline/prompts/coder_prompt.txt'));
  assert.equal(read(repo, '.pipeline/prompts/coder_prompt.txt'), 'coder v1 tuned');
});

test('manifestFilesAfterInstall records only what actually landed', () => {
  const src = sources();
  const repo = tmpDir('orch-repo-', {
    'pipeline/orchestrator.mjs': 'engine v2',   // delivered
    '.cursorrules': 'pre-existing, bootstrap skipped it',
  });
  const files = manifestFilesAfterInstall(repo, src);
  assert.ok(files['pipeline/orchestrator.mjs']);
  assert.equal(files['.cursorrules'], undefined);
  assert.equal(files['pipeline/state.mjs'], undefined);
});

test('shouldCheck rate-limits to the TTL', () => {
  const now = Date.parse('2026-08-13T12:00:00.000Z');
  assert.equal(shouldCheck(null, now), true, 'no cache -> check');
  assert.equal(shouldCheck({ checkedAt: 'not a date' }, now), true);
  assert.equal(shouldCheck({ checkedAt: new Date(now - 1000).toISOString() }, now), false);
  assert.equal(shouldCheck({ checkedAt: new Date(now - CHECK_TTL_MS).toISOString() }, now), true);
  assert.equal(shouldCheck({ checkedAt: new Date(now - CHECK_TTL_MS + 1).toISOString() }, now), false);
});

test('resolveEngineEntry prefers the target project, falls back to the host', () => {
  const inProject = resolveEngineEntry({
    repoRoot: '/repo/b', hostDir: '/repo/a/pipeline',
    exists: (p) => p === path.join('/repo/b', 'pipeline', 'orchestrator.mjs'),
  });
  assert.equal(inProject.source, 'project');
  assert.equal(inProject.entry, path.join('/repo/b', 'pipeline', 'orchestrator.mjs'));

  const hostFallback = resolveEngineEntry({ repoRoot: '/repo/b', hostDir: '/repo/a/pipeline', exists: () => false });
  assert.equal(hostFallback.source, 'host');
  assert.equal(hostFallback.entry, path.join('/repo/a/pipeline', 'orchestrator.mjs'));
});

test('summarize reports every outcome, and says so when there is nothing to do', () => {
  assert.match(summarize({ installed: [], updated: [], preserved: [], removed: [], kept: [] }), /already up to date/);
  const text = summarize({ installed: ['a'], updated: ['b'], preserved: ['c'], removed: ['d'], kept: ['e'] });
  for (const f of ['a', 'b', 'c', 'd', 'e']) assert.ok(text.includes(f), `missing ${f}`);
  assert.match(text, /\.new/);
});

function manifestHash(root, rel) {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(root, rel))).digest('hex');
}
