import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pipelinePaths } from './state.mjs';
import {
  createRunWorktree, removeRunWorktree, commitRunWork,
  changedFiles, fileOverlap, isAncestor, currentSha,
} from './worktrees.mjs';

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

// A repo shaped like a real consumer: a tracked .pipeline/ (prompts + config),
// which is exactly what makes the worktree symlink swap tricky.
function tmpRepo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-')));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  fs.mkdirSync(path.join(root, '.pipeline', 'prompts'), { recursive: true });
  fs.writeFileSync(path.join(root, '.pipeline', 'config.json'), '{}\n');
  fs.writeFileSync(path.join(root, '.pipeline', 'prompts', 'coder_prompt.txt'), 'be a coder\n');
  fs.writeFileSync(path.join(root, 'app.js'), 'export const v = 1;\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  return root;
}

function setupRun(root, runId = 'r1', branch = 'pipeline/F1/r1') {
  const paths = pipelinePaths(root, { runId });
  fs.mkdirSync(paths.dir, { recursive: true });
  const baseRef = currentSha(root);
  createRunWorktree({ repoRoot: root, runDir: paths.dir, worktreePath: paths.worktree, branch, baseRef });
  return { paths, baseRef };
}

test('a run worktree is created on its own branch from the given base', () => {
  const root = tmpRepo();
  const { paths, baseRef } = setupRun(root);
  assert.ok(fs.existsSync(path.join(paths.worktree, 'app.js')));
  assert.equal(git(paths.worktree, 'rev-parse', '--abbrev-ref', 'HEAD'), 'pipeline/F1/r1');
  assert.equal(currentSha(paths.worktree), baseRef);
  fs.rmSync(root, { recursive: true, force: true });
});

test('the worktree .pipeline resolves to this run dir, so agent artifact paths land per-run', () => {
  const root = tmpRepo();
  const { paths } = setupRun(root);
  const linked = path.join(paths.worktree, '.pipeline');
  assert.equal(fs.lstatSync(linked).isSymbolicLink(), true);
  assert.equal(fs.realpathSync(linked), fs.realpathSync(paths.dir));
  // An agent writing `.pipeline/specs.md` from inside the worktree writes the run's copy.
  fs.writeFileSync(path.join(linked, 'specs.md'), 'spec');
  assert.equal(fs.readFileSync(paths.specs, 'utf8'), 'spec');
  assert.ok(!fs.existsSync(path.join(root, '.pipeline', 'specs.md')));
  fs.rmSync(root, { recursive: true, force: true });
});

test('shared prompts and config stay readable through the worktree link', () => {
  const root = tmpRepo();
  const { paths } = setupRun(root);
  const wt = paths.worktree;
  assert.equal(fs.readFileSync(path.join(wt, '.pipeline', 'prompts', 'coder_prompt.txt'), 'utf8'), 'be a coder\n');
  assert.equal(fs.readFileSync(path.join(wt, '.pipeline', 'config.json'), 'utf8'), '{}\n');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a fresh worktree is clean: swapping .pipeline for a link reports no deletions', () => {
  const root = tmpRepo();
  const { paths } = setupRun(root);
  // Without skip-worktree, git would report every tracked .pipeline file as deleted,
  // which is the pre-existing sandbox bug this replaces.
  assert.equal(git(paths.worktree, 'status', '--porcelain'), '');
  fs.rmSync(root, { recursive: true, force: true });
});

test('changedFiles reports the run work and never the pipeline control plane', () => {
  const root = tmpRepo();
  const { paths, baseRef } = setupRun(root);
  fs.writeFileSync(path.join(paths.worktree, 'app.js'), 'export const v = 2;\n');
  fs.writeFileSync(path.join(paths.worktree, 'added.js'), 'new\n');
  fs.writeFileSync(paths.specs, 'a spec written during the run');
  const changed = changedFiles(paths.worktree, baseRef);
  assert.deepEqual(changed.sort(), ['added.js', 'app.js']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('commitRunWork commits tracked and new files but excludes .pipeline', () => {
  const root = tmpRepo();
  const { paths, baseRef } = setupRun(root);
  fs.writeFileSync(path.join(paths.worktree, 'app.js'), 'export const v = 2;\n');
  fs.writeFileSync(path.join(paths.worktree, 'added.js'), 'new\n');
  fs.writeFileSync(paths.specs, 'spec');
  const res = commitRunWork({ worktreePath: paths.worktree, message: 'feat: change' });
  assert.ok(res.sha);
  assert.equal(git(paths.worktree, 'status', '--porcelain'), '');
  const files = git(paths.worktree, 'diff', '--name-only', baseRef, 'HEAD').split('\n').sort();
  assert.deepEqual(files, ['added.js', 'app.js']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('commitRunWork reports nothing to commit rather than creating an empty commit', () => {
  const root = tmpRepo();
  const { paths } = setupRun(root);
  const res = commitRunWork({ worktreePath: paths.worktree, message: 'feat: nothing' });
  assert.equal(res.nothingToCommit, true);
  assert.equal(res.sha, null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('removeRunWorktree refuses a dirty worktree instead of discarding the work', () => {
  const root = tmpRepo();
  const { paths } = setupRun(root);
  fs.writeFileSync(path.join(paths.worktree, 'app.js'), 'uncommitted edit\n');
  const res = removeRunWorktree({ repoRoot: root, worktreePath: paths.worktree, branch: 'pipeline/F1/r1', integratedInto: 'main' });
  assert.equal(res.ok, false);
  assert.match(res.reason, /dirty/i);
  assert.ok(fs.existsSync(paths.worktree));
  fs.rmSync(root, { recursive: true, force: true });
});

test('removeRunWorktree refuses to drop a branch whose commits are not merged', () => {
  const root = tmpRepo();
  const { paths } = setupRun(root);
  fs.writeFileSync(path.join(paths.worktree, 'app.js'), 'export const v = 2;\n');
  commitRunWork({ worktreePath: paths.worktree, message: 'feat: change' });
  const res = removeRunWorktree({ repoRoot: root, worktreePath: paths.worktree, branch: 'pipeline/F1/r1', integratedInto: 'main' });
  assert.equal(res.ok, false);
  assert.match(res.reason, /not (yet )?merged|unmerged/i);
  assert.ok(fs.existsSync(paths.worktree));
  fs.rmSync(root, { recursive: true, force: true });
});

test('removeRunWorktree cleans up once the work is merged', () => {
  const root = tmpRepo();
  const { paths } = setupRun(root);
  fs.writeFileSync(path.join(paths.worktree, 'app.js'), 'export const v = 2;\n');
  commitRunWork({ worktreePath: paths.worktree, message: 'feat: change' });
  git(root, 'merge', '--no-ff', '--no-edit', '-q', 'pipeline/F1/r1');
  const res = removeRunWorktree({ repoRoot: root, worktreePath: paths.worktree, branch: 'pipeline/F1/r1', integratedInto: 'main' });
  assert.equal(res.ok, true);
  assert.ok(!fs.existsSync(paths.worktree));
  assert.ok(!git(root, 'branch', '--list', 'pipeline/F1/r1'));
  // The run's own state survives cleanup — it is the audit trail.
  assert.ok(fs.existsSync(paths.dir));
  fs.rmSync(root, { recursive: true, force: true });
});

test('a clean worktree with no commits of its own is removable', () => {
  const root = tmpRepo();
  const { paths } = setupRun(root);
  const res = removeRunWorktree({ repoRoot: root, worktreePath: paths.worktree, branch: 'pipeline/F1/r1', integratedInto: 'main' });
  assert.equal(res.ok, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('two runs get independent worktrees and artifact dirs', () => {
  const root = tmpRepo();
  const a = setupRun(root, 'r1', 'pipeline/F1/r1');
  const b = setupRun(root, 'r2', 'pipeline/F1/r2');
  fs.writeFileSync(a.paths.specs, 'spec A');
  fs.writeFileSync(b.paths.specs, 'spec B');
  assert.equal(fs.readFileSync(path.join(a.paths.worktree, '.pipeline', 'specs.md'), 'utf8'), 'spec A');
  assert.equal(fs.readFileSync(path.join(b.paths.worktree, '.pipeline', 'specs.md'), 'utf8'), 'spec B');
  fs.rmSync(root, { recursive: true, force: true });
});

test('fileOverlap finds shared files and ignores disjoint sets', () => {
  assert.deepEqual(fileOverlap(['a.js', 'b.js'], ['b.js', 'c.js']), ['b.js']);
  assert.deepEqual(fileOverlap(['a.js'], ['b.js']), []);
  assert.deepEqual(fileOverlap([], ['b.js']), []);
});

test('isAncestor answers containment both ways', () => {
  const root = tmpRepo();
  const first = currentSha(root);
  fs.writeFileSync(path.join(root, 'app.js'), 'v2\n');
  git(root, 'commit', '-qam', 'second');
  const second = currentSha(root);
  assert.equal(isAncestor(root, first, second), true);
  assert.equal(isAncestor(root, second, first), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('an already-prepared worktree is adopted, not rebuilt', () => {
  // The supervisor merges ticket branches into the feature worktree before the
  // integration worker starts. Recreating it there would discard that merge.
  const root = tmpRepo();
  const paths = pipelinePaths(root, { runId: 'int1' });
  fs.mkdirSync(paths.dir, { recursive: true });
  const branch = 'pipeline/feature/F1';
  createRunWorktree({ repoRoot: root, runDir: paths.dir, worktreePath: paths.worktree, branch, baseRef: currentSha(root) });
  fs.writeFileSync(path.join(paths.worktree, 'merged.js'), 'from a ticket\n');
  commitRunWork({ worktreePath: paths.worktree, message: 'merge ticket work' });
  const afterMerge = currentSha(paths.worktree);

  const again = createRunWorktree({ repoRoot: root, runDir: paths.dir, worktreePath: paths.worktree, branch, baseRef: 'HEAD' });
  assert.equal(again.adopted, true);
  assert.equal(currentSha(paths.worktree), afterMerge, 'the prepared commits must survive');
  assert.ok(fs.existsSync(path.join(paths.worktree, 'merged.js')));
  assert.equal(fs.realpathSync(path.join(paths.worktree, '.pipeline')), fs.realpathSync(paths.dir));
  fs.rmSync(root, { recursive: true, force: true });
});

test('a worktree on a different branch is refused rather than force-rebuilt', () => {
  const root = tmpRepo();
  const paths = pipelinePaths(root, { runId: 'r9' });
  fs.mkdirSync(paths.dir, { recursive: true });
  createRunWorktree({ repoRoot: root, runDir: paths.dir, worktreePath: paths.worktree, branch: 'pipeline/work/a', baseRef: currentSha(root) });
  // Recovery must never force-remove an existing worktree or delete its branch
  // merely to reuse a run ID — a mismatched branch means a human must inspect
  // and recover it explicitly, not have it silently discarded and rebuilt.
  assert.throws(
    () => createRunWorktree({ repoRoot: root, runDir: paths.dir, worktreePath: paths.worktree, branch: 'pipeline/work/b', baseRef: currentSha(root) }),
    /Refusing to replace an existing worktree or branch/,
  );
  assert.equal(git(paths.worktree, 'rev-parse', '--abbrev-ref', 'HEAD'), 'pipeline/work/a', 'the original worktree is untouched');
  fs.rmSync(root, { recursive: true, force: true });
});
