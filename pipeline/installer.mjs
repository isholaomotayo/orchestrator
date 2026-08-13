#!/usr/bin/env node
// Scaffold installer/updater.
//
// The orchestrator is *copied* into each consumer project, so without a record
// of what was delivered there is no safe way to refresh it: overwriting blindly
// destroys tuned prompts and local config, and refusing to overwrite (what
// bootstrap.sh did) freezes every project at its install-day version forever.
//
// This module records a sha256 manifest of everything it delivers, which makes
// the three cases distinguishable on the next update:
//   • file still matches the manifest  -> we delivered it, nobody touched it -> overwrite
//   • file differs from the manifest   -> a human edited it -> keep, write <file>.new beside it
//   • file absent                      -> install it
// Engine code (pipeline/**, the entrypoint scripts) skips that test and always
// overwrites: it is not meant to be hand-edited, and a half-updated engine is
// worse than no update at all.
//
// All decision logic lives here rather than in bash so it can be unit-tested;
// bootstrap.sh and orchestrate.sh call in, exactly as they already shell out to
// node for JSON parsing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hashFile } from './integrity.mjs';
import { atomicWrite, pidAlive, readLock, pipelinePaths } from './state.mjs';
import { isOrchestratorSourceRepo } from './self-guard.mjs';

export const INSTALL_FILE = '.pipeline/install.json';
export const CHECK_FILE = '.pipeline/update-check.json';
export const DEFAULT_SOURCE = 'https://github.com/isholaomotayo/orchestrator.git';
export const CHECK_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Every file the installer owns, as source -> destination.
 *
 * `cls: 'engine'` always overwrites; `cls: 'tunable'` overwrites only when the
 * on-disk copy still matches the manifest. Anything absent from this table —
 * config.json, run state, AGENTS/CLAUDE/GEMINI.md, package.json — is never
 * touched by an update.
 *
 * Note the skill mappings: the source keeps the skill at `skills/orchestrate/`
 * but consumers receive it under `.agents/` and `.gemini/`. That asymmetry is
 * load-bearing — `skills/orchestrate/SKILL.md` + `pipeline/orchestrator.mjs`
 * are the self-target guard's markers (see self-guard.mjs), so writing the
 * source path into a consumer would make it look like the orchestrator repo.
 */
export const MANAGED = [
  { src: 'pipeline', dest: 'pipeline', cls: 'engine', tree: true },
  { src: '.pipeline/orchestrate.sh', dest: '.pipeline/orchestrate.sh', cls: 'engine' },
  { src: '.pipeline/spawn.sh', dest: '.pipeline/spawn.sh', cls: 'engine' },
  { src: '.pipeline/skill.json', dest: '.pipeline/skill.json', cls: 'engine' },
  { src: '.pipeline/prompts', dest: '.pipeline/prompts', cls: 'tunable', tree: true },
  { src: 'skills/orchestrate', dest: '.agents/skills/orchestrate', cls: 'tunable', tree: true },
  { src: 'skills/orchestrate', dest: '.gemini/skills/orchestrate', cls: 'tunable', tree: true, only: ['SKILL.md', 'REFERENCE.md'] },
  { src: '.agents/workflows/orchestrate.md', dest: '.agents/workflows/orchestrate.md', cls: 'tunable' },
  { src: '.agent/rules/orchestrate.md', dest: '.agent/rules/orchestrate.md', cls: 'tunable' },
  { src: '.cursor/commands/orchestrate.md', dest: '.cursor/commands/orchestrate.md', cls: 'tunable' },
  { src: '.cursorrules', dest: '.cursorrules', cls: 'tunable' },
];

/**
 * Does this directory actually hold an orchestrator source tree?
 *
 * Without this check a wrong --src (an empty dir, the wrong clone, a failed
 * checkout) yields zero managed files, every manifest entry then looks like
 * "deleted upstream", and the update wipes the installed scaffold.
 */
export function isValidSource(srcRoot) {
  return ['pipeline/orchestrator.mjs', '.pipeline/orchestrate.sh']
    .every((marker) => fs.existsSync(path.join(srcRoot, marker)));
}

function walk(root, rel, out = []) {
  let entries;
  try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) walk(root, child, out);
    else if (entry.isFile()) out.push(child);
  }
  return out;
}

/**
 * Expand MANAGED against a source tree.
 * @returns {{dest: string, src: string, cls: 'engine'|'tunable'}[]}
 */
export function listManaged(srcRoot) {
  const out = [];
  const seen = new Set();
  for (const entry of MANAGED) {
    const candidates = entry.tree
      ? walk(srcRoot, entry.src).map((src) => ({ src, inner: src.slice(entry.src.length + 1) }))
      : (fs.existsSync(path.join(srcRoot, entry.src)) ? [{ src: entry.src, inner: null }] : []);
    for (const { src, inner } of candidates) {
      if (entry.only && !entry.only.includes(inner)) continue;
      const dest = inner === null ? entry.dest : `${entry.dest}/${inner}`;
      if (seen.has(dest)) continue;
      seen.add(dest);
      out.push({ dest, src, cls: entry.cls });
    }
  }
  return out;
}

/**
 * Classify every managed file without touching disk beyond hashing.
 * @param manifest previous install manifest, or null for a project installed
 *   before manifests existed — then every tunable counts as modified, so an
 *   update touches engine code only.
 * @returns {{install: [], overwrite: [], preserve: [], unchanged: [], remove: [], keepStale: []}}
 */
export function planUpdate({ repoRoot, srcRoot, manifest = null, force = false }) {
  const managed = listManaged(srcRoot);
  const recorded = manifest?.files || null;
  const plan = { install: [], overwrite: [], preserve: [], unchanged: [], alreadyOffered: [], remove: [], keepStale: [] };

  for (const item of managed) {
    const current = hashFile(path.join(repoRoot, item.dest));
    const incoming = hashFile(path.join(srcRoot, item.src));
    if (current === null) { plan.install.push(item); continue; }
    if (current === incoming) { plan.unchanged.push(item); continue; }
    if (item.cls === 'engine' || force) { plan.overwrite.push(item); continue; }
    const delivered = recorded ? recorded[item.dest] : null;
    if (delivered && delivered === current) { plan.overwrite.push(item); continue; }
    // Already offered this exact version beside the file — re-running an update
    // should not keep announcing the same .new. Kept out of `unchanged` so the
    // manifest still records the older bytes we actually delivered.
    if (hashFile(path.join(repoRoot, `${item.dest}.new`)) === incoming) plan.alreadyOffered.push(item);
    else plan.preserve.push(item);
  }

  // Files we delivered that upstream has since dropped. Removing one we know is
  // untouched keeps the tree clean; anything edited is left alone and reported.
  // Skipped entirely when the source yielded nothing — that is a broken source,
  // not an upstream that deleted its own scaffold.
  if (!managed.length) return plan;
  const live = new Set(managed.map((m) => m.dest));
  for (const dest of Object.keys(recorded || {})) {
    if (live.has(dest)) continue;
    const current = hashFile(path.join(repoRoot, dest));
    if (current === null) continue;
    if (current === recorded[dest]) plan.remove.push({ dest });
    else plan.keepStale.push({ dest });
  }
  return plan;
}

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  try { fs.chmodSync(dest, fs.statSync(src).mode & 0o777); } catch {}
}

export function applyUpdate(plan, { repoRoot, srcRoot }) {
  const done = { installed: [], updated: [], preserved: [], removed: [], kept: [] };
  for (const item of plan.install) {
    copyFile(path.join(srcRoot, item.src), path.join(repoRoot, item.dest));
    done.installed.push(item.dest);
  }
  for (const item of plan.overwrite) {
    copyFile(path.join(srcRoot, item.src), path.join(repoRoot, item.dest));
    done.updated.push(item.dest);
  }
  for (const item of plan.preserve) {
    copyFile(path.join(srcRoot, item.src), path.join(repoRoot, `${item.dest}.new`));
    done.preserved.push(item.dest);
  }
  for (const item of plan.remove) {
    try { fs.rmSync(path.join(repoRoot, item.dest), { force: true }); done.removed.push(item.dest); } catch {}
  }
  for (const item of plan.keepStale) done.kept.push(item.dest);
  return done;
}

/**
 * The manifest records the hash of the *upstream* bytes we last delivered — not
 * what is on disk. A preserved file keeps its previous entry precisely because
 * we did not deliver the new version to it; recording the user's own hash would
 * make their edit look pristine and get it overwritten on the next update.
 */
export function nextManifestFiles(plan, { srcRoot, previous = {} }) {
  const files = { ...previous };
  for (const item of [...plan.install, ...plan.overwrite, ...plan.unchanged]) {
    const hash = hashFile(path.join(srcRoot, item.src));
    if (hash) files[item.dest] = hash;
  }
  for (const item of plan.remove) delete files[item.dest];
  return files;
}

/** Manifest for a fresh install: only files that actually landed as delivered. */
export function manifestFilesAfterInstall(repoRoot, srcRoot) {
  const files = {};
  for (const item of listManaged(srcRoot)) {
    const incoming = hashFile(path.join(srcRoot, item.src));
    if (incoming && incoming === hashFile(path.join(repoRoot, item.dest))) files[item.dest] = incoming;
  }
  return files;
}

export function readInstall(repoRoot) {
  try { return JSON.parse(fs.readFileSync(path.join(repoRoot, INSTALL_FILE), 'utf8')); } catch { return null; }
}
export function writeInstall(repoRoot, manifest) {
  fs.mkdirSync(path.join(repoRoot, '.pipeline'), { recursive: true });
  atomicWrite(path.join(repoRoot, INSTALL_FILE), JSON.stringify(manifest, null, 2) + '\n');
}
export function readCheck(repoRoot) {
  try { return JSON.parse(fs.readFileSync(path.join(repoRoot, CHECK_FILE), 'utf8')); } catch { return null; }
}
export function writeCheck(repoRoot, cache) {
  fs.mkdirSync(path.join(repoRoot, '.pipeline'), { recursive: true });
  atomicWrite(path.join(repoRoot, CHECK_FILE), JSON.stringify(cache, null, 2) + '\n');
}

/** Rate-limit the upstream probe: a run should not pay for it more than daily. */
export function shouldCheck(cache, now, ttlMs = CHECK_TTL_MS) {
  const last = Date.parse(cache?.checkedAt || '');
  if (!Number.isFinite(last)) return true;
  return now - last >= ttlMs;
}

const SHA_RE = /^[0-9a-f]{40}$/;

/** Upstream HEAD, or null on any failure — a run must never block on this. */
export function remoteHead(source, { timeoutMs = 5000 } = {}) {
  const res = spawnSync('git', ['ls-remote', source, 'HEAD'], { encoding: 'utf8', timeout: timeoutMs });
  if (res.status !== 0 || !res.stdout) return null;
  const sha = res.stdout.trim().split(/\s+/)[0];
  return SHA_RE.test(sha) ? sha : null;
}

export function gitHead(dir) {
  const res = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8', timeout: 5000 });
  if (res.status !== 0) return null;
  const sha = (res.stdout || '').trim();
  return SHA_RE.test(sha) ? sha : null;
}

export function packageVersion(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version || null; } catch { return null; }
}

/**
 * Which orchestrator.mjs should drive a run in `repoRoot`?
 *
 * The dashboard used to always spawn its own copy, so a run started from the
 * sidebar and the same run started from the CLI could execute different engine
 * versions. Prefer the target's own engine; fall back to the host's only when
 * the target has none.
 */
export function resolveEngineEntry({ repoRoot, hostDir, exists = fs.existsSync }) {
  const local = path.join(repoRoot, 'pipeline', 'orchestrator.mjs');
  if (exists(local)) return { entry: local, source: 'project' };
  return { entry: path.join(hostDir, 'orchestrator.mjs'), source: 'host' };
}

/** A live lock means a run owns these files right now. */
export function runInProgress(repoRoot) {
  const lock = readLock(pipelinePaths(repoRoot));
  return !!(lock && pidAlive(lock.pid));
}

export function summarize(done) {
  const lines = [];
  const say = (label, list) => { if (list.length) lines.push(`  ${label}: ${list.join(', ')}`); };
  say('installed', done.installed);
  say('updated', done.updated);
  say('preserved (new version written as .new)', done.preserved);
  say('removed', done.removed);
  say('kept (dropped upstream but edited locally)', done.kept);
  return lines.length ? lines.join('\n') : '  nothing to do — already up to date';
}

// ---- CLI -------------------------------------------------------------------

function flagValue(argv, name, fallback = null) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

function cloneSource(source) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-update-'));
  const res = spawnSync('git', ['clone', '--depth', '1', source, tmp], { encoding: 'utf8', timeout: 120000 });
  if (res.status !== 0) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    return null;
  }
  return tmp;
}

function doApply({ repoRoot, srcRoot, force, source }) {
  const previous = readInstall(repoRoot);
  const plan = planUpdate({ repoRoot, srcRoot, manifest: previous, force });
  const done = applyUpdate(plan, { repoRoot, srcRoot });
  const now = new Date().toISOString();
  writeInstall(repoRoot, {
    version: packageVersion(srcRoot),
    commit: gitHead(srcRoot),
    source: source || previous?.source || DEFAULT_SOURCE,
    installedAt: previous?.installedAt || now,
    updatedAt: now,
    files: nextManifestFiles(plan, { srcRoot, previous: previous?.files || {} }),
  });
  return done;
}

function main(argv) {
  const repoRoot = path.resolve(flagValue(argv, '--repo', process.cwd()));
  const force = argv.includes('--force');

  // Updating the source repo in place would overwrite local work with upstream.
  if (isOrchestratorSourceRepo(repoRoot) && process.env.ORCH_ALLOW_SELF !== '1' && !argv.includes('--check')) {
    console.error('[installer] Refusing to modify the orchestrator SOURCE repository. Run this from a consumer project (maintainers: ORCH_ALLOW_SELF=1).');
    return 3;
  }

  if (argv.includes('--write-manifest')) {
    const srcRoot = path.resolve(flagValue(argv, '--src', repoRoot));
    if (!isValidSource(srcRoot)) { console.error(`[installer] Not an orchestrator source tree: ${srcRoot}`); return 1; }
    const now = new Date().toISOString();
    writeInstall(repoRoot, {
      version: packageVersion(srcRoot),
      commit: gitHead(srcRoot),
      source: flagValue(argv, '--source', DEFAULT_SOURCE),
      installedAt: now,
      updatedAt: now,
      files: manifestFilesAfterInstall(repoRoot, srcRoot),
    });
    return 0;
  }

  if (argv.includes('--check')) {
    const installed = readInstall(repoRoot);
    const source = flagValue(argv, '--source', installed?.source || DEFAULT_SOURCE);
    const ttl = Number(flagValue(argv, '--ttl', CHECK_TTL_MS));
    const cache = readCheck(repoRoot);
    let latest = cache?.latestCommit || null;
    let checked = false;
    if (shouldCheck(cache, Date.now(), ttl)) {
      const head = remoteHead(source, { timeoutMs: Number(flagValue(argv, '--timeout', 5000)) });
      if (head) { latest = head; checked = true; writeCheck(repoRoot, { checkedAt: new Date().toISOString(), latestCommit: head }); }
    }
    const current = installed?.commit || null;
    console.log(JSON.stringify({
      updateAvailable: !!(current && latest && current !== latest),
      current, latest, checked, source,
    }));
    return 0;
  }

  if (argv.includes('--plan')) {
    const srcRoot = path.resolve(flagValue(argv, '--src', ''));
    if (!isValidSource(srcRoot)) { console.error(`[installer] --plan requires --src pointing at an orchestrator source tree (got ${srcRoot || 'nothing'})`); return 1; }
    const plan = planUpdate({ repoRoot, srcRoot, manifest: readInstall(repoRoot), force });
    console.log(JSON.stringify(plan, null, 2));
    return 0;
  }

  if (argv.includes('--apply') || argv.includes('--self-update')) {
    if (runInProgress(repoRoot)) {
      console.error('[installer] A pipeline run is active (.pipeline/.lock) — not updating.');
      return 1;
    }
    let srcRoot = flagValue(argv, '--src', null);
    let cloned = null;
    const source = flagValue(argv, '--source', readInstall(repoRoot)?.source || DEFAULT_SOURCE);
    if (!srcRoot) {
      cloned = cloneSource(source);
      if (!cloned) { console.error(`[installer] Could not fetch ${source}.`); return 1; }
      srcRoot = cloned;
      // Hand off to the freshly fetched installer so an update is always
      // applied by the NEW logic, never by the stale local copy.
      const fresh = path.join(cloned, 'pipeline', 'installer.mjs');
      if (fs.existsSync(fresh) && !argv.includes('--no-rexec')) {
        const res = spawnSync(process.execPath, [fresh, '--apply', '--src', cloned, '--repo', repoRoot, '--no-rexec', ...(force ? ['--force'] : [])], { stdio: 'inherit' });
        try { fs.rmSync(cloned, { recursive: true, force: true }); } catch {}
        return res.status === null ? 1 : res.status;
      }
    }
    srcRoot = path.resolve(srcRoot);
    if (!isValidSource(srcRoot)) {
      console.error(`[installer] Refusing to update from ${srcRoot} — it is not an orchestrator source tree.`);
      if (cloned) { try { fs.rmSync(cloned, { recursive: true, force: true }); } catch {} }
      return 1;
    }
    const done = doApply({ repoRoot, srcRoot, force, source });
    console.log('[installer] Scaffold update:');
    console.log(summarize(done));
    if (cloned) { try { fs.rmSync(cloned, { recursive: true, force: true }); } catch {} }
    return 0;
  }

  console.error('Usage: node pipeline/installer.mjs --check | --plan --src <dir> | --apply [--src <dir>] [--force] | --self-update | --write-manifest --src <dir>');
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
