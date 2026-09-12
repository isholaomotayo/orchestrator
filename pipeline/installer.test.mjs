import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  MANAGED, listManaged, planUpdate, applyUpdate, nextManifestFiles,
  manifestFilesAfterInstall, shouldCheck, resolveEngineEntry, summarize, isValidSource, CHECK_TTL_MS,
  firstExisting, listTrustAnchors, verifyFetchedTree, refreshInstalledTrustAnchor, DEFAULT_REF, VERIFIER_RELS, MANIFEST_RELS,
  RELEASE_MANIFEST_REL, RELEASE_VERIFIER_REL, remoteLatestTag, resolveTargetRef,
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
function emptyHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orch-home-empty-'));
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

test('the default fetch ref is a pinned tag, never a branch', () => {
  assert.match(DEFAULT_REF, /^v\d+\.\d+\.\d+$/, 'DEFAULT_REF must be an immutable release tag');
  for (const bad of ['main', 'master', 'HEAD', 'develop']) {
    assert.notEqual(DEFAULT_REF, bad);
  }
});

test('firstExisting picks the first candidate that is present', () => {
  assert.equal(firstExisting('/r', ['a', 'b'], (p) => p === path.join('/r', 'b')), path.join('/r', 'b'));
  assert.equal(firstExisting('/r', ['a', 'b'], () => false), null);
});

// The trust anchor must come from the consumer project, never from the tree
// being checked — these paths are what bootstrap.sh actually installs.
test('the verifier and manifest are looked up outside the fetched tree', () => {
  for (const rel of [...VERIFIER_RELS, ...MANIFEST_RELS]) {
    assert.ok(
      rel.startsWith('.agents/') || rel.startsWith('.gemini/') || rel.startsWith('.cursor/'),
      `${rel} must be an installed-skill path`,
    );
    assert.ok(!rel.startsWith('skills/'), `${rel} must not use the self-guard marker path`);
  }
});

// A project installed before manifests existed has no trusted hash to compare
// against. That must not hard-fail an existing working install, but it must be
// reported rather than silently treated as verified.
test('verifyFetchedTree reports unverifiable when no manifest is installed', () => {
  const repoRoot = tmpDir('orch-repo-');
  const result = verifyFetchedTree({ repoRoot, srcRoot: tmpDir('orch-src-'), homeDir: emptyHome() });
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'unverifiable');
  assert.match(result.detail, /manifest/i);
});

test('verifyFetchedTree runs the installed verifier and passes on a clean tree', () => {
  const repoRoot = tmpDir('orch-repo-');
  const srcRoot = tmpDir('orch-src-', { 'pipeline/orchestrator.mjs': 'engine' });
  // Stand-in verifier: asserts it was handed the fetched tree and the manifest.
  write(repoRoot, VERIFIER_RELS[0], `
    const a = process.argv.slice(2);
    if (a[0] !== '--verify' || !a[1] || a[2] !== '--manifest' || !a[3]) process.exit(2);
    process.exit(0);
  `);
  write(repoRoot, MANIFEST_RELS[0], '{"ref":"v1.0.0","files":{}}');
  const result = verifyFetchedTree({ repoRoot, srcRoot, homeDir: emptyHome() });
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'verified');
});

test('verifyFetchedTree fails closed when the installed verifier rejects the tree', () => {
  const repoRoot = tmpDir('orch-repo-');
  const srcRoot = tmpDir('orch-src-', { 'pipeline/orchestrator.mjs': 'tampered' });
  write(repoRoot, VERIFIER_RELS[0], 'console.error("modified (1): pipeline/orchestrator.mjs"); process.exit(1);');
  write(repoRoot, MANIFEST_RELS[0], '{"ref":"v1.0.0","files":{}}');
  const result = verifyFetchedTree({ repoRoot, srcRoot, homeDir: emptyHome() });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'mismatch');
  assert.match(result.detail, /orchestrator\.mjs/);
});

test('verifyFetchedTree self-verifies via the release manifest when the local one is stale', () => {
  const releaseManifest = '{"ref":"v2.0.0","files":{"pipeline/events.mjs":"abc"}}';
  const releaseVerifier = `
    const a = process.argv.slice(2);
    if (a[0] !== '--verify' || !a[1] || a[2] !== '--manifest' || !a[3]) process.exit(2);
    process.exit(0);
  `;
  const repoRoot = tmpDir('orch-repo-');
  const srcRoot = tmpDir('orch-src-', {
    'pipeline/events.mjs': 'new runtime',
    [RELEASE_MANIFEST_REL]: releaseManifest,
    [RELEASE_VERIFIER_REL]: releaseVerifier,
  });
  write(repoRoot, VERIFIER_RELS[0], 'console.error("modified (43): pipeline/events.mjs"); process.exit(1);');
  write(repoRoot, MANIFEST_RELS[0], '{"ref":"v1.0.1","files":{}}');
  const result = verifyFetchedTree({ repoRoot, srcRoot, homeDir: emptyHome() });
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'verified-release-manifest');
  assert.equal(read(repoRoot, MANIFEST_RELS[0]), releaseManifest);
  assert.equal(read(repoRoot, VERIFIER_RELS[0]), releaseVerifier);
});

test('verifyFetchedTree accepts a Cursor Skill Manager global manifest when the project copy is stale', () => {
  const releaseManifest = '{"ref":"v2.0.0","files":{"pipeline/events.mjs":"abc"}}';
  const passVerifier = `
    const a = process.argv.slice(2);
    if (a[0] !== '--verify' || !a[1] || a[2] !== '--manifest' || !a[3]) process.exit(2);
    process.exit(0);
  `;
  const failVerifier = 'console.error("modified (43): pipeline/events.mjs"); process.exit(1);';
  const repoRoot = tmpDir('orch-repo-');
  const homeDir = tmpDir('orch-home-');
  const srcRoot = tmpDir('orch-src-', {
    'pipeline/events.mjs': 'new runtime',
    [RELEASE_MANIFEST_REL]: releaseManifest,
    [RELEASE_VERIFIER_REL]: passVerifier,
  });
  write(repoRoot, MANIFEST_RELS[0], '{"ref":"v1.0.1","files":{}}');
  write(repoRoot, VERIFIER_RELS[0], failVerifier);
  write(homeDir, '.cursor/skills/orchestrate/scripts/scaffold.sha256', releaseManifest);
  write(homeDir, '.cursor/skills/orchestrate/scripts/scaffold-manifest.mjs', passVerifier);
  const result = verifyFetchedTree({ repoRoot, srcRoot, homeDir });
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'verified-global-skill');
  assert.equal(read(repoRoot, MANIFEST_RELS[0]), releaseManifest);
});

test('listTrustAnchors prefers the global Cursor skill before stale project copies', () => {
  const repoRoot = tmpDir('orch-repo-');
  const homeDir = tmpDir('orch-home-');
  write(repoRoot, MANIFEST_RELS[0], '{"ref":"v1"}');
  write(repoRoot, VERIFIER_RELS[0], 'local');
  write(homeDir, '.cursor/skills/orchestrate/scripts/scaffold.sha256', '{"ref":"v2.0.0"}');
  write(homeDir, '.cursor/skills/orchestrate/scripts/scaffold-manifest.mjs', 'global');
  const anchors = listTrustAnchors(repoRoot, { homeDir });
  assert.equal(anchors[0].scope, 'global-cursor');
  assert.match(anchors[0].manifest, /\.cursor\/skills\/orchestrate/);
});

test('refreshInstalledTrustAnchor copies the release trust anchor into installed skill paths', () => {
  const repoRoot = tmpDir('orch-repo-');
  const srcRoot = tmpDir('orch-src-', {
    [RELEASE_MANIFEST_REL]: '{"ref":"v2.0.0","files":{}}',
    [RELEASE_VERIFIER_REL]: 'verifier v2',
  });
  assert.equal(refreshInstalledTrustAnchor(repoRoot, srcRoot), true);
  assert.equal(read(repoRoot, MANIFEST_RELS[0]), '{"ref":"v2.0.0","files":{}}');
  assert.equal(read(repoRoot, VERIFIER_RELS[0]), 'verifier v2');
});

test('the manifest, verifier, and bootstrap script are engine-class, so a local edit can never preserve a stale trust anchor', () => {
  const src = sources();
  write(src, 'skills/orchestrate/scripts/scaffold-manifest.mjs', 'verifier v2');
  write(src, 'skills/orchestrate/scripts/scaffold.sha256', '{"ref":"v2","files":{}}');
  write(src, 'skills/orchestrate/scripts/bootstrap.sh', '#!/bin/bash\n# bootstrap v2');
  const managed = listManaged(src);
  for (const rel of ['scaffold-manifest.mjs', 'scaffold.sha256', 'bootstrap.sh']) {
    const entry = managed.find((m) => m.dest === `.agents/skills/orchestrate/scripts/${rel}`);
    assert.ok(entry, `${rel} must be managed`);
    assert.equal(entry.cls, 'engine', `${rel} must always be overwritten, not preserved as a user edit`);
  }
});

test('the coordinator skills are delivered to consumers, never at the source path', () => {
  // skills/orchestrate/SKILL.md is a self-target guard marker: writing any
  // skill to the source path would make a consumer look like this repository.
  const repoRoot = path.dirname(new URL('.', import.meta.url).pathname);
  const dests = listManaged(repoRoot).map((m) => m.dest);
  for (const name of ['digest', 'catchup', 'unattended', 'notes']) {
    assert.ok(dests.includes(`.agents/skills/${name}/SKILL.md`), `${name} is not delivered`);
    assert.ok(dests.includes(`.gemini/skills/${name}/SKILL.md`), `${name} is not delivered to gemini`);
  }
  assert.ok(!dests.some((d) => d.startsWith('skills/')), 'nothing may be written to the source skills path');
});

test('the pinned release ref matches the version being shipped', () => {
  // A hardcoded string-equals-string here (the previous form of this test)
  // proves nothing: it still passes even when a release bumps package.json
  // and tags a new commit but forgets to move this pin, which is exactly
  // what happened for v3.0.0 — every consumer's --update kept re-fetching
  // v2.0.1 forever, silently, with "already up to date" as the only signal.
  // Deriving the expected value from package.json is what actually catches
  // that class of mistake on the next release too.
  const repoRoot = path.dirname(new URL('.', import.meta.url).pathname);
  const version = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;
  assert.equal(DEFAULT_REF, `v${version}`);
});

test("bootstrap.sh's own ORCHESTRATOR_REF default is kept in sync with installer.mjs's DEFAULT_REF", () => {
  // bootstrap.sh cannot import DEFAULT_REF (there is no installed installer.mjs
  // yet on a first-ever bootstrap), so it carries its own copy of the same
  // pin — the two are only ever kept honest by a test like this one.
  const repoRoot = path.dirname(new URL('.', import.meta.url).pathname);
  const script = fs.readFileSync(path.join(repoRoot, 'skills/orchestrate/scripts/bootstrap.sh'), 'utf8');
  const match = /ORCHESTRATOR_REF="\$\{ORCHESTRATOR_REF:-(v[\d.]+)\}"/.exec(script);
  assert.ok(match, 'bootstrap.sh must declare an ORCHESTRATOR_REF default in the expected form');
  assert.equal(match[1], DEFAULT_REF);
});

test('resolveTargetRef prefers the trust anchor ref when one is installed', () => {
  const repo = tmpDir('orch-target-ref-');
  write(repo, '.agents/skills/orchestrate/scripts/scaffold.sha256', JSON.stringify({ ref: 'v3.9.9' }));
  write(repo, '.agents/skills/orchestrate/scripts/scaffold-manifest.mjs', 'verifier');
  const ref = resolveTargetRef(repo, 'https://example.com/orch.git', { homeDir: emptyHome() });
  assert.equal(ref, 'v3.9.9');
  fs.rmSync(repo, { recursive: true, force: true });
});

test('resolveTargetRef falls back to DEFAULT_REF when no anchor has a ref and remote fails', () => {
  const repo = tmpDir('orch-target-ref-empty-');
  const ref = resolveTargetRef(repo, 'https://invalid-host-that-does-not-exist.local/repo.git', { homeDir: emptyHome() });
  assert.equal(ref, DEFAULT_REF);
  fs.rmSync(repo, { recursive: true, force: true });
});
