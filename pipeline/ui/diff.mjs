// Splitting and rendering unified diffs.
//
// A run's diff can span several repositories and hundreds of files, so it is
// split per file and rendered collapsed unless it is small enough to read at a
// glance.

import { esc } from './md.mjs';

export function diffLineHtml(line) {
  let cls = '';
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) cls = 'meta';
  else if (line.startsWith('@@')) cls = 'hunk';
  else if (line.startsWith('+')) cls = 'add';
  else if (line.startsWith('-')) cls = 'del';
  return `<div class="dl ${cls}">${esc(line) || ' '}</div>`;
}

// Split a patch into per-file sections. A flat render of a large diff builds one
// enormous DOM and gives no way to find the file you care about; collapsed
// sections with +/- counts make a big review navigable.

export function splitDiffFiles(patch) {
  const files = [];
  let current = null;
  let repo = null;
  for (const line of patch.split('\n')) {
    // A multi-repo diff carries one "## repo `<label>` — diff vs <ref>" heading
    // per repository. Break the card stream there, or the heading disappears
    // into the tail of the previous file and two repos' identically-named files
    // render as indistinguishable cards.
    const section = line.match(/^##\s+repo\s+`(.+?)`/);
    if (section) {
      repo = section[1] === '.' ? null : section[1];
      current = { name: null, lines: [line], add: 0, del: 0 };
      files.push(current);
      continue;
    }
    const header = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (header) {
      current = { name: repo ? repo + '/' + header[2] : header[2], lines: [line], add: 0, del: 0 };
      files.push(current);
      continue;
    }
    if (!current) {
      // Preamble (e.g. the "# diff vs <ref>" banner the orchestrator writes).
      current = { name: null, lines: [], add: 0, del: 0 };
      files.push(current);
    }
    current.lines.push(line);
    if (line.startsWith('+') && !line.startsWith('+++')) current.add++;
    else if (line.startsWith('-') && !line.startsWith('---')) current.del++;
  }
  return files.filter((f) => f.lines.some((l) => l.trim()));
}

const DIFF_AUTO_OPEN_LINES = 400; // keep small diffs expanded, collapse big ones
export function renderDiff(patch) {
  const files = splitDiffFiles(patch);
  const named = files.filter((f) => f.name);
  if (!named.length) {
    // No git file headers (e.g. the "no changes detected" note) — render as-is.
    return `<div class="diff-body">${patch.split('\n').map(diffLineHtml).join('')}</div>`;
  }
  const total = named.reduce((n, f) => n + f.lines.length, 0);
  const openByDefault = total <= DIFF_AUTO_OPEN_LINES;
  return files.map((f) => {
    const body = `<div class="diff-body">${f.lines.map(diffLineHtml).join('')}</div>`;
    if (!f.name) return body;
    return `<details class="diff-file"${openByDefault ? ' open' : ''}>
      <summary>
        <span class="fname">${esc(f.name)}</span>
        <span class="diff-stat"><span class="plus">+${f.add}</span> <span class="minus">-${f.del}</span></span>
      </summary>${body}</details>`;
  }).join('');
}
