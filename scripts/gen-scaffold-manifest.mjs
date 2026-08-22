#!/usr/bin/env node
// Regenerate skills/orchestrate/scripts/scaffold.sha256 for a release.
//
// Release procedure:
//   1. npm run release:manifest -- --ref vX.Y.Z   (records hashes of HEAD's tree)
//   2. commit the regenerated manifest
//   3. git tag vX.Y.Z at that commit, and push the tag
//
// The manifest deliberately does not hash itself, so step 1 producing a new
// manifest does not invalidate the manifest — that is what makes a same-commit
// pin possible at all. Consumers get this file out-of-band via the skill
// bundle and use it to verify whatever the tag resolves to.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const manifestScript = path.join(repoRoot, 'skills/orchestrate/scripts/scaffold-manifest.mjs');
const out = path.join(repoRoot, 'skills/orchestrate/scripts/scaffold.sha256');

const argv = process.argv.slice(2);
const refIdx = argv.indexOf('--ref');
const ref = refIdx >= 0 ? argv[refIdx + 1] : null;
if (!ref) {
  console.error('Usage: npm run release:manifest -- --ref vX.Y.Z');
  process.exit(2);
}

const res = spawnSync(process.execPath, [manifestScript, '--generate', repoRoot, '--ref', ref, '--out', out], { stdio: 'inherit' });
process.exit(res.status === null ? 1 : res.status);
