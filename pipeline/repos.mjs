// Repository discovery and diff assembly for the review artifact.
//
// The review diff used to be a single `git diff` at the run root. That misses
// the two layouts people actually work in:
//
//   1. A container folder holding sibling clones (`~/dev/product/{web,api}`).
//      The root is not a repo at all, so the reviewer got "diff unavailable"
//      and audited blind even though every change was in a subdirectory.
//   2. A repo with nested clones or submodules inside it. `git diff` at the
//      outer root reports a submodule as a one-line pointer bump and a nested
//      clone not at all, so the code the Coder wrote there was invisible.
//
// Discovery is depth-bounded and skips dependency/build trees, so pointing the
// pipeline at a large monorepo does not turn diff generation into a full
// filesystem crawl.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Git's canonical empty-tree object; diffing against it renders every tracked
// file as an addition, so a repo with no commits yet still yields a real diff.
export const GIT_EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export const DEFAULT_MAX_DEPTH = 4;

// Total artifact budget. The old single diff was unbounded, which was survivable
// when there was one repo; concatenating N of them is not. Truncation is
// announced in the artifact so the reviewer knows to fall back to reading source
// rather than assuming it saw everything.
export const DEFAULT_MAX_DIFF_BYTES = 2_000_000;

// Directories that never hold a repo worth reviewing but very often hold
// thousands of files — or vendored clones carrying their own .git.
export const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'bower_components', 'vendor', 'Pods',
  'dist', 'build', 'out', 'target', 'coverage',
  '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', '.parcel-cache',
  '.venv', 'venv', '__pycache__', '.tox', '.mypy_cache', '.pytest_cache',
  '.gradle', '.terraform', '.idea', '.vscode',
  '.pipeline', '.pipeline_sandbox',
]);

export function gitAt(cwd) {
  return (args) => spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/**
 * Every git work tree relevant to a run rooted at `rootDir`: the repo the root
 * itself belongs to (which may be an ancestor, when the run targets one package
 * of a monorepo) plus any repo roots found in its subdirectories.
 *
 * @returns {Array<{root: string, label: string, enclosing: boolean}>} ordered
 * with the enclosing repo first; `label` is the path relative to `rootDir`
 * ('.' for the root itself, '../..' for an ancestor, 'web' for a nested clone).
 */
export function discoverRepos(rootDir, { maxDepth = DEFAULT_MAX_DEPTH, skipDirs = SKIP_DIRS } = {}) {
  const found = new Map();
  // Labels and dedup keys are computed on resolved paths: `git rev-parse
  // --show-toplevel` reports the real path, and on macOS the run root usually
  // arrives via a symlink (/var -> /private/var). Comparing the two verbatim
  // labels the run's own repo as '../../../private/var/...' instead of '.'.
  const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
  const realRoot = real(rootDir);
  const add = (root, { enclosing = false } = {}) => {
    const key = real(root);
    if (found.has(key)) return;
    const rel = path.relative(realRoot, key);
    found.set(key, { root: key, label: rel === '' ? '.' : rel, enclosing });
  };

  const top = gitAt(rootDir)(['rev-parse', '--show-toplevel']);
  if (top.status === 0 && top.stdout.trim()) add(top.stdout.trim(), { enclosing: true });

  walk(rootDir, 0, maxDepth, skipDirs, add);

  // Enclosing repo first — it is the run's primary repo and leads the diff;
  // nested clones follow in a stable, path-sorted order.
  return [...found.values()].sort(
    (a, b) => Number(b.enclosing) - Number(a.enclosing) || a.label.localeCompare(b.label),
  );
}

function walk(dir, depth, maxDepth, skipDirs, add) {
  if (depth > maxDepth) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    // isDirectory() is false for symlinks, which also keeps the walk free of
    // symlink cycles.
    if (!entry.isDirectory() || skipDirs.has(entry.name)) continue;
    const child = path.join(dir, entry.name);
    // `.git` is a directory in a clone and a file in a submodule/worktree.
    if (fs.existsSync(path.join(child, '.git'))) {
      // Stop here: this repo's own submodules are rendered by --submodule=diff,
      // and descending would report their contents twice.
      add(child);
      continue;
    }
    walk(child, depth + 1, maxDepth, skipDirs, add);
  }
}

/**
 * Record the commit each repo starts from, before any agent runs, so the review
 * diff stays scoped to this run even after an agent commits its work.
 */
export function captureBaseRefs(repos) {
  return repos.map((repo) => {
    const head = gitAt(repo.root)(['rev-parse', 'HEAD']);
    return { ...repo, baseRef: head.status === 0 ? head.stdout.trim() : null };
  });
}

export function resolveDiffBaseRef(git, captured) {
  // 1. Prefer the commit the run started from (captures committed + uncommitted work).
  if (captured && git(['cat-file', '-e', `${captured}^{commit}`]).status === 0) return captured;
  // 2. Fall back to the merge-base with a default branch (for legacy runs missing baseRef).
  for (const branch of ['main', 'master']) {
    const mb = git(['merge-base', 'HEAD', branch]);
    if (mb.status === 0 && mb.stdout.trim()) return mb.stdout.trim();
  }
  // 3. If there is at least one commit, diff the working tree against HEAD.
  if (git(['rev-parse', '--verify', 'HEAD']).status === 0) return 'HEAD';
  // 4. No commit available (fresh repo): diff against the empty tree so all
  //    tracked/staged content is still shown to the reviewer.
  return GIT_EMPTY_TREE;
}

export function describeBaseRef(ref) {
  if (ref === 'HEAD') return 'HEAD (working tree)';
  if (ref === GIT_EMPTY_TREE) return 'empty tree (no commits yet)';
  return ref.slice(0, 12);
}

/**
 * @returns {{baseRef: string, patch: string}|null} null when `repo.root` is not
 * a git work tree (it was removed, or was never one).
 */
export function repoPatch(repo, { git = gitAt(repo.root) } = {}) {
  if (git(['rev-parse', '--is-inside-work-tree']).status !== 0) return null;
  const baseRef = resolveDiffBaseRef(git, repo.baseRef);
  // --submodule=diff: without it a submodule bump renders as a one-line pointer
  // change and the code written inside it never reaches the reviewer.
  let patch = git(['diff', '--submodule=diff', baseRef]).stdout || '';
  const untracked = (git(['ls-files', '--others', '--exclude-standard']).stdout || '')
    .split('\n').filter(Boolean);
  for (const f of untracked) {
    if (f.startsWith('.pipeline')) continue;
    // A trailing slash is an unignored directory git will not look inside — in
    // practice a nested clone, which gets a section of its own.
    if (f.endsWith('/')) continue;
    patch += git(['diff', '--no-index', '/dev/null', f]).stdout || '';
  }
  return { baseRef, patch };
}

const NO_REPO_NOTE = '# diff unavailable (no git repository)\n\nNo git work tree was found at the run root or in its subdirectories. Review the implementation directly from .pipeline/changes.md and the source files it references.\n';
const NO_CHANGES_NOTE = '# no changes detected\n\nNo diff against the run baseline in any discovered repository. Review the implementation directly from .pipeline/changes.md and the source files it references.\n';

/**
 * Assemble `.pipeline/diff.patch` from every discovered repo. `patchFor` is
 * injectable so the assembly rules can be tested without building fixtures for
 * every git edge case.
 */
export function buildDiffArtifact(repos, { maxBytes = DEFAULT_MAX_DIFF_BYTES, patchFor = repoPatch } = {}) {
  if (!repos.length) return NO_REPO_NOTE;

  const sections = [];
  const truncated = [];
  const omitted = [];
  let remaining = maxBytes;

  for (const repo of repos) {
    const result = patchFor(repo);
    if (!result) { omitted.push(`${repo.label} — not a git work tree`); continue; }
    if (!result.patch.trim()) { sections.push({ repo, baseRef: result.baseRef, body: '' }); continue; }
    if (remaining <= 0) { omitted.push(`${repo.label} — diff budget exhausted`); continue; }
    let body = result.patch;
    if (body.length > remaining) {
      body = `${body.slice(0, remaining)}\n[... truncated by the orchestrator]\n`;
      truncated.push(repo.label);
    }
    remaining -= body.length;
    sections.push({ repo, baseRef: result.baseRef, body });
  }

  const changed = sections.filter((s) => s.body);
  if (!changed.length) return NO_CHANGES_NOTE;

  // One repo, and it IS the run root: keep the original single-repo shape so
  // nothing downstream has to special-case the common case.
  if (sections.length === 1 && sections[0].repo.label === '.' && !omitted.length && !truncated.length) {
    return `# diff vs ${describeBaseRef(sections[0].baseRef)}\n\n${sections[0].body}`;
  }

  const out = [`# diff across ${sections.length} repositor${sections.length === 1 ? 'y' : 'ies'}`, ''];
  if (truncated.length || omitted.length) {
    out.push(
      '> **Incomplete diff.** This artifact does not show every change:',
      ...truncated.map((l) => `> - \`${l}\`: diff truncated at the size budget.`),
      ...omitted.map((l) => `> - ${l}.`),
      '> Read the affected source files directly before concluding anything about them.',
      '',
    );
  }
  for (const s of sections) {
    out.push(`## repo \`${s.repo.label}\` — diff vs ${describeBaseRef(s.baseRef)}`, '');
    out.push(s.body || '(no changes in this repository)', '');
  }
  return out.join('\n');
}
