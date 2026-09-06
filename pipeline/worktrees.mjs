// Per-run git worktrees: the isolation primitive that lets many workers edit
// one repository at once without seeing each other's half-finished work.
//
// The tricky part is `.pipeline` itself. Stage prompts hardcode paths like
// `.pipeline/specs.md`, so an agent working inside a worktree must find ITS
// run's artifacts there. We therefore replace the worktree's `.pipeline`
// directory with a symlink to the run dir. Two consequences are handled here:
//
//   1. `.pipeline/**` is usually tracked (prompts, config.json), so removing the
//      real directory would make git report every one of those files as deleted,
//      polluting `git status`, the review diff, and any commit. `skip-worktree`
//      tells git to stop comparing those paths in this worktree, which keeps it
//      clean without touching the index of any other worktree.
//   2. The prompts and config are SHARED, not per-run, so the run dir links them
//      back out to the repo-level copies.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function git(cwd, args, { check = true } = {}) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (check && res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${(res.stderr || res.stdout || '').trim()}`);
  }
  return { status: res.status, stdout: (res.stdout || '').trim(), stderr: (res.stderr || '').trim() };
}

export function currentSha(cwd, ref = 'HEAD') {
  return git(cwd, ['rev-parse', ref]).stdout;
}

export function isAncestor(cwd, maybeAncestor, descendant) {
  return git(cwd, ['merge-base', '--is-ancestor', maybeAncestor, descendant], { check: false }).status === 0;
}

export function branchExists(cwd, branch) {
  return git(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { check: false }).status === 0;
}

/**
 * Create the run's worktree and point its `.pipeline` at the run dir.
 *
 * @param {object} o
 * @param {string} o.repoRoot     the primary repository
 * @param {string} o.runDir       `.pipeline/runs/<runId>` — becomes the link target
 * @param {string} o.worktreePath `.pipeline/worktrees/<runId>`
 * @param {string} o.branch       new branch for this run's commits
 * @param {string} o.baseRef      commit or branch the work starts from
 */
export function createRunWorktree({ repoRoot, runDir, worktreePath, branch, baseRef = 'HEAD' }) {
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  fs.mkdirSync(runDir, { recursive: true });
  // Clear any remnant of a previous run with this id before reusing the path.
  git(repoRoot, ['worktree', 'remove', worktreePath, '--force'], { check: false });
  git(repoRoot, ['worktree', 'prune'], { check: false });
  if (branchExists(repoRoot, branch)) git(repoRoot, ['branch', '-D', branch], { check: false });
  git(repoRoot, ['worktree', 'add', worktreePath, '-b', branch, baseRef]);

  hidePipelineFromGit(worktreePath);

  const linked = path.join(worktreePath, '.pipeline');
  fs.rmSync(linked, { recursive: true, force: true });
  fs.symlinkSync(path.resolve(runDir), linked, 'dir');
  // skip-worktree stops git tracking the files that used to be there, but the
  // symlink we just put in their place is a brand-new untracked entry. Exclude
  // it in this worktree only, so `git status` is genuinely clean and a dirty
  // check before cleanup means what it says.
  excludeInWorktree(worktreePath, '/.pipeline');

  // Prompts and config are shared inputs, not run state: link them back out so
  // `.pipeline/prompts/...` resolves for an agent working inside the worktree.
  linkShared(runDir, path.join(repoRoot, '.pipeline'), ['prompts', 'config.json', 'ui.url', 'skills']);
  return { worktreePath, branch, baseRef };
}

// Stop git comparing tracked .pipeline paths in THIS worktree, so replacing the
// directory with a symlink does not read as "the agent deleted the pipeline".
function hidePipelineFromGit(worktreePath) {
  const tracked = git(worktreePath, ['ls-files', '-z', '.pipeline'], { check: false }).stdout;
  if (!tracked) return;
  const res = spawnSync('git', ['update-index', '-z', '--skip-worktree', '--stdin'], {
    cwd: worktreePath, input: tracked.endsWith('\0') ? tracked : `${tracked}\0`, encoding: 'utf8',
  });
  if (res.status !== 0) {
    throw new Error(`Could not hide .pipeline from git in ${worktreePath}: ${(res.stderr || '').trim()}`);
  }
}

// Append a pattern to this worktree's private exclude file. It lives in the
// worktree's own git dir, so it never touches the consumer's .gitignore or any
// other worktree.
function excludeInWorktree(worktreePath, pattern) {
  const rel = git(worktreePath, ['rev-parse', '--git-path', 'info/exclude'], { check: false }).stdout;
  if (!rel) return;
  const file = path.isAbsolute(rel) ? rel : path.join(worktreePath, rel);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (current.split('\n').some((l) => l.trim() === pattern)) return;
    fs.appendFileSync(file, `${current && !current.endsWith('\n') ? '\n' : ''}${pattern}\n`);
  } catch { /* best-effort: a noisy status is survivable, a crash here is not */ }
}

function linkShared(runDir, sharedDir, names) {
  for (const name of names) {
    const target = path.join(sharedDir, name);
    const link = path.join(runDir, name);
    if (!fs.existsSync(target) || fs.existsSync(link)) continue;
    try {
      fs.symlinkSync(target, link, fs.statSync(target).isDirectory() ? 'dir' : 'file');
    } catch { /* best-effort: a missing link only costs the agent a lookup */ }
  }
}

/**
 * Files this run changed relative to its base, excluding the control plane.
 * Used both for the ticket scheduler's overlap heuristic and for reporting.
 */
export function changedFiles(worktreePath, baseRef) {
  const tracked = git(worktreePath, ['diff', '--name-only', baseRef], { check: false }).stdout;
  const untracked = git(worktreePath, ['ls-files', '--others', '--exclude-standard'], { check: false }).stdout;
  const all = [...tracked.split('\n'), ...untracked.split('\n')]
    .map((f) => f.trim())
    .filter((f) => f && !f.startsWith('.pipeline'));
  return [...new Set(all)].sort();
}

/**
 * Commit everything this run produced, except the control plane. The engine
 * never committed before; branches cannot be merged until it does.
 */
export function commitRunWork({ worktreePath, message, author = null }) {
  git(worktreePath, ['add', '-A', '--', '.']);
  // Belt and braces: the per-worktree exclude already keeps `.pipeline` out of
  // `add`, but that write is best-effort, and a run's control plane must never
  // reach a commit. Unstaging is unconditional and cheap.
  git(worktreePath, ['reset', '-q', '--', '.pipeline'], { check: false });
  const staged = git(worktreePath, ['diff', '--cached', '--name-only'], { check: false }).stdout;
  if (!staged) return { sha: null, nothingToCommit: true, files: [] };
  const args = [];
  if (author?.name) args.push('-c', `user.name=${author.name}`);
  if (author?.email) args.push('-c', `user.email=${author.email}`);
  git(worktreePath, [...args, 'commit', '-q', '-m', message]);
  return { sha: currentSha(worktreePath), nothingToCommit: false, files: staged.split('\n').filter(Boolean) };
}

/**
 * Remove a run's worktree — fail-closed.
 *
 * Refuses when the tree is dirty or the branch holds commits that are not
 * contained in `integratedInto`. Losing an agent's unmerged work to a cleanup
 * pass is unrecoverable, so a refusal is reported and left for a human.
 */
export function removeRunWorktree({ repoRoot, worktreePath, branch, integratedInto = null, force = false }) {
  if (!fs.existsSync(worktreePath)) {
    git(repoRoot, ['worktree', 'prune'], { check: false });
    return { ok: true, reason: 'already gone' };
  }
  if (!force) {
    const dirty = git(worktreePath, ['status', '--porcelain'], { check: false }).stdout
      .split('\n').map((l) => l.trim()).filter(Boolean)
      .filter((l) => !l.slice(3).startsWith('.pipeline'));
    if (dirty.length) {
      return { ok: false, reason: `worktree is dirty (${dirty.length} uncommitted path(s))`, dirty };
    }
    if (branch && integratedInto && branchExists(repoRoot, branch)) {
      const merged = isAncestor(repoRoot, branch, integratedInto);
      if (!merged) {
        return { ok: false, reason: `branch ${branch} has commits not yet merged into ${integratedInto}` };
      }
    }
  }
  git(repoRoot, ['worktree', 'remove', worktreePath, '--force']);
  if (branch && branchExists(repoRoot, branch)) {
    git(repoRoot, ['branch', force ? '-D' : '-d', branch], { check: false });
  }
  git(repoRoot, ['worktree', 'prune'], { check: false });
  return { ok: true, reason: 'removed' };
}

/** Files two ticket file-lists have in common — the parallel-safety heuristic. */
export function fileOverlap(a, b) {
  const set = new Set(b || []);
  return [...new Set((a || []).filter((f) => set.has(f)))].sort();
}
