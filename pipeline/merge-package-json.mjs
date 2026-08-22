#!/usr/bin/env node
// Merge the scaffold's package.json scripts/description into a consumer's
// existing package.json, without touching anything else in it. Invoked by
// bootstrap.sh — kept as a checked-in file (not an inline `node -e` one-liner)
// so it is reviewable and versioned like the rest of pipeline/.
import fs from 'node:fs';
import path from 'node:path';

const [, , srcRoot, repoRoot] = process.argv;
if (!srcRoot || !repoRoot) {
  console.error('Usage: node merge-package-json.mjs <srcRoot> <repoRoot>');
  process.exit(2);
}

const src = JSON.parse(fs.readFileSync(path.join(srcRoot, 'package.json'), 'utf8'));
const dstPath = path.join(repoRoot, 'package.json');
const dst = fs.existsSync(dstPath) ? JSON.parse(fs.readFileSync(dstPath, 'utf8')) : {};

dst.scripts = { ...(dst.scripts || {}), ...(src.scripts || {}) };
if (!dst.description && src.description) dst.description = src.description;

fs.writeFileSync(dstPath, JSON.stringify(dst, null, 2) + '\n');
