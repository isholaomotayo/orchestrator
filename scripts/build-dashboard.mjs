#!/usr/bin/env node
// Assemble pipeline/dashboard.html from pipeline/ui/*.
//
// The dashboard is served as exactly one file with no dependencies and no
// bundler, which is a product promise: it works offline, on a machine with no
// npm install, forever. But a single 2000-line file is miserable to edit and
// impossible to unit-test, so the source lives as ES modules and this script
// concatenates them into the served file.
//
// The output is committed. `--check` rebuilds into memory and compares, so a
// stale dashboard.html fails CI instead of shipping.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const UI = path.join(ROOT, 'pipeline', 'ui');
const OUT = path.join(ROOT, 'pipeline', 'dashboard.html');

// Dependency order. Explicit rather than resolved, because the whole point is
// that the output is predictable and reviewable in a diff.
const ORDER = ['md.mjs', 'diff.mjs', 'tabs.mjs', 'pool-tree.mjs', 'api.mjs', 'stages.mjs', 'feed.mjs', 'runs.mjs', 'main.mjs'];

const IMPORT_RE = /^\s*import\s[^;]*?from\s+['"]\.\/[^'"]+['"];?\s*$/gm;
const EXPORT_RE = /^export\s+(?=(const|let|var|function|async function|class))/gm;
const EXPORT_LIST_RE = /^export\s*\{[^}]*\};?\s*$/gm;

function inline(file) {
  const source = fs.readFileSync(path.join(UI, file), 'utf8');
  const stripped = source
    .replace(IMPORT_RE, '')          // modules are concatenated, not resolved
    .replace(EXPORT_LIST_RE, '')
    .replace(EXPORT_RE, '');
  return `\n// ===== ${file} =====\n${stripped.trim()}\n`;
}

function build() {
  const template = fs.readFileSync(path.join(UI, 'dashboard.src.html'), 'utf8');
  const script = ORDER.map(inline).join('\n');

  const declared = new Map();
  // A duplicate top-level name would silently shadow across modules once they
  // share a scope, so fail loudly at build time instead.
  for (const file of ORDER) {
    const source = fs.readFileSync(path.join(UI, file), 'utf8');
    for (const match of source.matchAll(/^(?:export\s+)?(?:const|let|function|async function|class)\s+([A-Za-z_$][\w$]*)/gm)) {
      const name = match[1];
      if (declared.has(name)) {
        throw new Error(`Duplicate top-level name "${name}" in ${file} and ${declared.get(name)} — the bundle shares one scope.`);
      }
      declared.set(name, file);
    }
  }
  if (!template.includes('<!--BUNDLE-->')) throw new Error('dashboard.src.html has no <!--BUNDLE--> placeholder.');

  return template.replace('<!--BUNDLE-->', () => `<script type="module">\n${script}\n</script>`);
}

const check = process.argv.includes('--check');
const html = build();
if (check) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (current !== html) {
    console.error('pipeline/dashboard.html is out of date. Run `npm run build:ui` and commit the result.');
    process.exit(1);
  }
  console.log('dashboard.html is up to date.');
} else {
  fs.writeFileSync(OUT, html);
  console.log(`Built pipeline/dashboard.html (${(html.length / 1024).toFixed(0)} KB) from ${ORDER.length} module(s).`);
}
