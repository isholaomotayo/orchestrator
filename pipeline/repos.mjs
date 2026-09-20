import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';

export function discoverRepos(workCwd, { maxDepth = 4 } = {}) {
  // Try to use find and git directly. Simplified for now.
  try {
    const repos = execSync(`find . -maxdepth ${maxDepth} -name ".git" -type d`, { cwd: workCwd, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .map(p => path.resolve(workCwd, path.dirname(p)));

    // Ensure workCwd is always returned if it's a repo
    if (fs.existsSync(path.join(workCwd, '.git')) && !repos.includes(path.resolve(workCwd))) {
        repos.unshift(path.resolve(workCwd));
    }

    // Sort to have the parent repos first
    repos.sort((a, b) => a.length - b.length);

    return repos.map(root => {
       const relPath = path.relative(workCwd, root);
       return {
         root,
         label: relPath === '' ? 'root' : relPath,
         enclosing: null, // Determine this properly if needed
         baseRef: null // Handled by captureBaseRefs
       }
    });

  } catch (err) {
    // If find fails, just check current dir
    if (fs.existsSync(path.join(workCwd, '.git'))) {
      return [{
         root: path.resolve(workCwd),
         label: 'root',
         enclosing: null,
         baseRef: null
       }];
    }
    return [];
  }
}

export function captureBaseRefs(repos) {
  return repos.map(repo => {
    try {
      const baseRef = execSync('git rev-parse HEAD', { cwd: repo.root, encoding: 'utf8' }).trim();
      return { ...repo, baseRef };
    } catch (err) {
      return { ...repo, baseRef: null };
    }
  });
}

export function buildDiffArtifact(repos, { maxDiffBytes } = {}) {
  // Simplified stub
  let diff = '';
  for (const repo of repos) {
    if (!repo.baseRef) continue;
    try {
       const repoDiff = execSync(`git diff ${repo.baseRef}`, { cwd: repo.root, encoding: 'utf8' });
       diff += repoDiff;
    } catch (e) {
       // Ignore
    }
  }
  return diff;
}
