// The dashboard's sign-in link: the URL with this server's browser key, which
// buys an HttpOnly session cookie (see ui-server.mjs). The key lives in the
// server's owner-only record, and the link only ever lands in an owner-only
// .pipeline/ui.url, so reading it is what proves the reader is this user.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

/** The live server record for a port, newest first, or null. */
export function serverRecordForPort(port) {
  const dir = path.join(process.env.ORCHESTRATOR_HOME || path.join(os.homedir(), '.orchestrator'), 'servers');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return null; }
  const records = [];
  for (const name of names) {
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (Number(rec.port) === Number(port) && alive(rec.pid)) records.push(rec);
    } catch { /* torn or foreign file */ }
  }
  return records.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))[0] || null;
}

/** The sign-in URL for a project on the server at `port`, or null when no live server there has a key. */
export function signInUrl(port, repoRoot) {
  const rec = serverRecordForPort(port);
  if (!rec?.browserKey) return null;
  return `http://127.0.0.1:${port}/?project=${encodeURIComponent(repoRoot)}&key=${rec.browserKey}`;
}

/** Write .pipeline/ui.url readable by its owner only, replacing any older copy whatever its mode. */
export function writeUiUrl(pipelineDir, url) {
  const file = path.join(pipelineDir, 'ui.url');
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${url}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600); // the umask may have narrowed it further, never widened; be explicit
  fs.renameSync(tmp, file);
}
