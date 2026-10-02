// Agent instructions tell chat sessions to run `node pipeline/<x>.mjs ...`.
// Two of those (pool.mjs, skills.mjs) were libraries with no CLI entry, so the
// self-invocation guard and "pin it again" advice silently printed nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = [
  'AGENTS.md', 'CLAUDE.md', 'GEMINI.md', 'README.md', '.cursorrules',
  '.cursor/commands/orchestrate.md', '.agent/rules/orchestrate.md',
  ...fs.readdirSync(path.join(ROOT, 'skills')).flatMap((d) => {
    const dir = path.join('skills', d);
    return fs.statSync(path.join(ROOT, dir)).isDirectory()
      ? fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith('.md')).map((f) => path.join(dir, f))
      : [];
  }),
].filter((f) => fs.existsSync(path.join(ROOT, f)));

test('every `node pipeline/<x>.mjs` command in agent instructions is a real entry point', () => {
  const broken = [];
  for (const doc of DOCS) {
    const text = fs.readFileSync(path.join(ROOT, doc), 'utf8');
    for (const [, name] of text.matchAll(/node pipeline\/([a-z-]+\.mjs)/g)) {
      const file = path.join(ROOT, 'pipeline', name);
      const src = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      // An entry point reads its argv or starts a server; a library does neither.
      if (!/process\.argv|\.listen\(/.test(src)) broken.push(`${doc}: node pipeline/${name}`);
    }
  }
  assert.deepEqual([...new Set(broken)], []);
});
