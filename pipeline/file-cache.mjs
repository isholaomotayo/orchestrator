// Parse-once caches for files many readers re-read on every request or tick.
//
// The dashboard and the supervisor ask the same questions of the same files
// (a run's events, the bridge journal) many times a second, and the answer only
// changes when the file does. A file's (inode, size, mtime) is a cheap stand-in
// for "has it changed": a hit costs one stat instead of a read and a parse.
import fs from 'node:fs';

const MAX_ENTRIES = 2000;
const cache = new Map();

export function statKey(file) {
  try {
    const s = fs.statSync(file);
    return `${s.ino}:${s.size}:${s.mtimeMs}`;
  } catch { return null; }
}

/**
 * `compute()` for `file`, reused until the file changes. The cached value is
 * shared: callers must not mutate it (clone first if they need to).
 */
export function memoByStat(file, compute) {
  const key = statKey(file);
  const hit = cache.get(file);
  if (hit && hit.key === key) return hit.value;
  const value = compute();
  cache.delete(file);
  cache.set(file, { key, value });
  if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
  return value;
}
