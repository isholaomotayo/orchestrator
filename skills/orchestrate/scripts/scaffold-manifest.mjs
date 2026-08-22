#!/usr/bin/env node
// Integrity manifest for the scaffold that bootstrap.sh installs.
//
// WHY THIS EXISTS
// The bootstrap fetches the scaffold over the network and then copies engine
// code, entrypoint scripts and stage prompts into a consumer project, where
// they execute and steer coding agents. Pinning the fetch to a tag is not by
// itself integrity: a tag can be moved, a repo can be hijacked, a proxy can
// rewrite a response. So the fetched tree is compared, file by file, against
// sha256 hashes recorded when the release was cut.
//
// WHY THE MANIFEST TRAVELS WITH THE SKILL, NOT WITH THE CLONE
// A manifest fetched alongside the code it describes proves nothing — whoever
// controlled the code controlled the manifest. `scaffold.sha256` therefore
// ships inside the skill bundle (installed via `npx skills add`), arriving
// out-of-band from the clone it validates. For the same reason this verifier
// must be run from the *installed skill's* directory and must never import
// anything out of the tree it is checking.
//
// A hash mismatch, a missing file, or an unexpected extra file under a covered
// root all fail closed: the install aborts rather than proceeding with code
// that is not the reviewed release.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Directory roots and individual files the bootstrap copies into a consumer.
// Everything here either executes (engine code, entrypoint scripts, npm
// scripts) or instructs an agent (stage prompts, skill docs, editor rules), so
// all of it is covered. Extra files appearing under a covered ROOT are treated
// as tampering: `npm test` globs `pipeline/*.test.mjs`, so an unexpected file
// dropped there would run.
export const COVERED_ROOTS = ['pipeline', '.pipeline', 'skills'];
export const COVERED_FILES = [
  'package.json',
  'AGENTS.md', 'CLAUDE.md', 'GEMINI.md',
  '.cursorrules',
  '.cursor/commands/orchestrate.md',
  '.agents/workflows/orchestrate.md',
  '.agent/rules/orchestrate.md',
];

// The manifest cannot record its own hash, so it is the one covered path left
// out. Nothing executes it; it is data read by this verifier.
export const MANIFEST_REL = 'skills/orchestrate/scripts/scaffold.sha256';

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function walk(root, rel, out) {
  let entries;
  try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return out; }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(root, child, out);
    else if (entry.isFile()) out.push(child);
  }
  return out;
}

/** Every covered path present in `srcRoot`, sorted, excluding the manifest. */
export function coveredPaths(srcRoot) {
  const out = [];
  for (const root of COVERED_ROOTS) walk(srcRoot, root, out);
  for (const file of COVERED_FILES) {
    if (fs.existsSync(path.join(srcRoot, file))) out.push(file);
  }
  return out.filter((p) => p !== MANIFEST_REL).sort();
}

/** @returns {{ref: string, files: Record<string,string>}} */
export function generateManifest(srcRoot, ref) {
  const files = {};
  for (const rel of coveredPaths(srcRoot)) files[rel] = sha256(path.join(srcRoot, rel));
  return { ref, files };
}

/**
 * Compare a fetched tree against a recorded manifest.
 * @returns {{ok: boolean, mismatched: string[], missing: string[], extra: string[]}}
 */
export function verifyManifest(srcRoot, manifest) {
  const recorded = manifest?.files || {};
  const mismatched = [];
  const missing = [];
  for (const [rel, hash] of Object.entries(recorded)) {
    const abs = path.join(srcRoot, rel);
    if (!fs.existsSync(abs)) { missing.push(rel); continue; }
    if (sha256(abs) !== hash) mismatched.push(rel);
  }
  const extra = coveredPaths(srcRoot).filter((rel) => !(rel in recorded));
  return {
    ok: !mismatched.length && !missing.length && !extra.length,
    mismatched: mismatched.sort(), missing: missing.sort(), extra,
  };
}

export function describeFailure(result) {
  const lines = [];
  if (result.mismatched.length) lines.push(`  modified (${result.mismatched.length}): ${result.mismatched.slice(0, 10).join(', ')}${result.mismatched.length > 10 ? ', …' : ''}`);
  if (result.missing.length) lines.push(`  missing (${result.missing.length}): ${result.missing.slice(0, 10).join(', ')}${result.missing.length > 10 ? ', …' : ''}`);
  if (result.extra.length) lines.push(`  unexpected (${result.extra.length}): ${result.extra.slice(0, 10).join(', ')}${result.extra.length > 10 ? ', …' : ''}`);
  return lines.join('\n');
}

// ---- CLI -------------------------------------------------------------------

function flag(argv, name, fallback = null) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

function main(argv) {
  const genRoot = flag(argv, '--generate');
  const verifyRoot = flag(argv, '--verify');

  if (genRoot) {
    const ref = flag(argv, '--ref');
    if (!ref) { console.error('--generate requires --ref <tag>'); return 2; }
    const manifest = generateManifest(path.resolve(genRoot), ref);
    const out = flag(argv, '--out');
    const text = JSON.stringify(manifest, null, 2) + '\n';
    if (out) {
      fs.writeFileSync(out, text);
      console.error(`[manifest] ${Object.keys(manifest.files).length} files recorded for ${ref} -> ${out}`);
    } else process.stdout.write(text);
    return 0;
  }

  if (verifyRoot) {
    const manifestPath = flag(argv, '--manifest');
    if (!manifestPath) { console.error('--verify requires --manifest <file>'); return 2; }
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
    catch (err) { console.error(`[manifest] Cannot read manifest ${manifestPath}: ${err.message}`); return 2; }
    const result = verifyManifest(path.resolve(verifyRoot), manifest);
    if (result.ok) {
      console.error(`[manifest] Verified ${Object.keys(manifest.files).length} files against ${manifest.ref}.`);
      return 0;
    }
    console.error(`[manifest] INTEGRITY CHECK FAILED for ${manifest.ref}:`);
    console.error(describeFailure(result));
    return 1;
  }

  console.error('Usage: scaffold-manifest.mjs --generate <srcRoot> --ref <tag> [--out <file>]');
  console.error('       scaffold-manifest.mjs --verify <srcRoot> --manifest <file>');
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main(process.argv.slice(2)));
