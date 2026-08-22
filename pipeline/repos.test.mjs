import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  discoverRepos, resolveDiffBaseRef, describeBaseRef, buildDiffArtifact,
  GIT_EMPTY_TREE,
} from './repos.mjs';

function tmpDir(prefix = 'repos-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  return dir;
}

function labels(repos) { return repos.map((r) => r.label); }

// ---- discovery -------------------------------------------------------------

test('a container folder of sibling clones yields one repo per clone', () => {
  // The layout that used to produce "diff unavailable (no git repository)".
  const root = tmpDir();
  initRepo(path.join(root, 'web'));
  initRepo(path.join(root, 'api'));
  const repos = discoverRepos(root);
  assert.deepEqual(labels(repos), ['api', 'web']);
  assert.equal(repos.some((r) => r.enclosing), false);
});

test('a repo at the run root is labelled "." and leads the list', () => {
  const root = initRepo(tmpDir());
  initRepo(path.join(root, 'packages', 'nested'));
  const repos = discoverRepos(root);
  assert.deepEqual(labels(repos), ['.', 'packages/nested']);
  assert.equal(repos[0].enclosing, true);
});

test('a run root inside a larger repo reports the enclosing repo, not the subdirectory', () => {
  const root = initRepo(tmpDir());
  const sub = path.join(root, 'packages', 'app');
  fs.mkdirSync(sub, { recursive: true });
  const repos = discoverRepos(sub);
  assert.equal(repos.length, 1);
  assert.equal(repos[0].enclosing, true);
  // Labelled relative to the run root, so the artifact shows where it sits.
  assert.equal(repos[0].label, path.join('..', '..'));
});

test('dependency and build trees are never scanned for repos', () => {
  const root = tmpDir();
  initRepo(path.join(root, 'node_modules', 'vendored-clone'));
  initRepo(path.join(root, 'dist', 'stale-clone'));
  initRepo(path.join(root, 'real'));
  assert.deepEqual(labels(discoverRepos(root)), ['real']);
});

test('discovery stops at the depth bound', () => {
  const root = tmpDir();
  initRepo(path.join(root, 'a', 'b', 'c', 'deep'));
  assert.deepEqual(labels(discoverRepos(root, { maxDepth: 1 })), []);
  assert.deepEqual(labels(discoverRepos(root, { maxDepth: 4 })), [path.join('a', 'b', 'c', 'deep')]);
});

test('a repo is not descended into, so its submodules are not double-reported', () => {
  const root = tmpDir();
  const outer = initRepo(path.join(root, 'outer'));
  // A submodule checkout: `.git` is a file, and its content is rendered by
  // --submodule=diff inside the outer repo's own patch.
  const inner = path.join(outer, 'vendor-lib');
  fs.mkdirSync(inner, { recursive: true });
  fs.writeFileSync(path.join(inner, '.git'), 'gitdir: ../.git/modules/vendor-lib\n');
  assert.deepEqual(labels(discoverRepos(root)), ['outer']);
});

test('an unreadable directory does not abort the whole scan', () => {
  const root = tmpDir();
  const blocked = path.join(root, 'blocked');
  fs.mkdirSync(blocked);
  fs.chmodSync(blocked, 0o000);
  initRepo(path.join(root, 'readable'));
  try {
    assert.deepEqual(labels(discoverRepos(root)), ['readable']);
  } finally {
    fs.chmodSync(blocked, 0o755);
  }
});

// ---- base ref resolution ---------------------------------------------------

function fakeGit(responses) {
  return (args) => {
    const key = args.join(' ');
    for (const [prefix, res] of Object.entries(responses)) {
      if (key.startsWith(prefix)) return { status: res.status ?? 0, stdout: res.stdout ?? '' };
    }
    return { status: 1, stdout: '' };
  };
}

test('the captured base ref wins when it still exists', () => {
  const git = fakeGit({ 'cat-file': { status: 0 } });
  assert.equal(resolveDiffBaseRef(git, 'abc123'), 'abc123');
});

test('a captured ref that no longer exists falls back to the merge base', () => {
  const git = fakeGit({
    'cat-file': { status: 1 },
    'merge-base HEAD main': { status: 0, stdout: 'deadbeef\n' },
  });
  assert.equal(resolveDiffBaseRef(git, 'gone'), 'deadbeef');
});

test('with no captured ref and no default branch, the working tree is diffed against HEAD', () => {
  const git = fakeGit({ 'rev-parse --verify HEAD': { status: 0 } });
  assert.equal(resolveDiffBaseRef(git, null), 'HEAD');
});

test('a repo with no commits falls back to the empty tree', () => {
  assert.equal(resolveDiffBaseRef(fakeGit({}), null), GIT_EMPTY_TREE);
  assert.equal(describeBaseRef(GIT_EMPTY_TREE), 'empty tree (no commits yet)');
});

// ---- artifact assembly -----------------------------------------------------

const repo = (label, enclosing = false) => ({ root: `/tmp/${label}`, label, enclosing, baseRef: 'a'.repeat(40) });

test('no repositories at all still tells the reviewer how to proceed', () => {
  const out = buildDiffArtifact([]);
  assert.match(out, /^# diff unavailable/);
  assert.match(out, /changes\.md/);
});

test('a single repo at the run root keeps the original single-diff shape', () => {
  const out = buildDiffArtifact([repo('.', true)], {
    patchFor: () => ({ baseRef: 'abc123def4567', patch: 'diff --git a/x b/x\n' }),
  });
  assert.equal(out, '# diff vs abc123def456\n\ndiff --git a/x b/x\n');
});

test('multiple repos are reported as separate labelled sections', () => {
  const out = buildDiffArtifact([repo('.', true), repo('api')], {
    patchFor: (r) => ({ baseRef: 'abc123def4567', patch: `diff --git a/${r.label}/x b/${r.label}/x\n` }),
  });
  assert.match(out, /# diff across 2 repositories/);
  assert.match(out, /## repo `\.` — diff vs abc123def456/);
  assert.match(out, /## repo `api` — diff vs abc123def456/);
  assert.match(out, /a\/api\/x/);
});

test('a repo with no changes is listed but not mistaken for the whole run being empty', () => {
  const out = buildDiffArtifact([repo('.', true), repo('api')], {
    patchFor: (r) => ({ baseRef: 'abc123def4567', patch: r.label === 'api' ? 'diff --git a/y b/y\n' : '' }),
  });
  assert.match(out, /\(no changes in this repository\)/);
  assert.match(out, /diff --git a\/y b\/y/);
});

test('nothing changed anywhere reads as no changes, not as an empty diff', () => {
  const out = buildDiffArtifact([repo('.', true), repo('api')], {
    patchFor: () => ({ baseRef: 'abc', patch: '' }),
  });
  assert.match(out, /^# no changes detected/);
});

test('a truncated diff says so loudly instead of looking complete', () => {
  const out = buildDiffArtifact([repo('.', true), repo('api')], {
    maxBytes: 40,
    patchFor: (r) => ({ baseRef: 'abc', patch: `${r.label}-`.repeat(100) }),
  });
  assert.match(out, /\*\*Incomplete diff\.\*\*/);
  assert.match(out, /truncated by the orchestrator/);
  // The second repo gets no budget at all — that must be stated, not silent.
  assert.match(out, /`api`: |api — diff budget exhausted/);
  assert.match(out, /Read the affected source files directly/);
});

test('a repo that is no longer a work tree is reported as omitted', () => {
  const out = buildDiffArtifact([repo('.', true), repo('gone')], {
    patchFor: (r) => (r.label === 'gone' ? null : { baseRef: 'abc', patch: 'diff --git a/x b/x\n' }),
  });
  assert.match(out, /gone — not a git work tree/);
  assert.match(out, /\*\*Incomplete diff\.\*\*/);
});
