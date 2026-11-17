import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ENSURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui-ensure.mjs');
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

test('ui --ensure starts a dashboard once, then reuses it, printing JSON', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ensure-')));
  const port = await freePort();
  fs.mkdirSync(path.join(root, '.pipeline'), { recursive: true });
  // A private port and home, so the test never touches a real dashboard.
  fs.writeFileSync(path.join(root, '.pipeline', 'config.json'), JSON.stringify({ uiPort: port, uiIdleTimeoutMs: 0 }));
  const env = { ...process.env, ORCHESTRATOR_HOME: path.join(root, '.orch-home') };
  let pid = null;
  try {
    const first = spawnSync(process.execPath, [ENSURE, '--repo', root, '--json'], { encoding: 'utf8', env, timeout: 20000 });
    assert.equal(first.status, 0, first.stderr);
    const a = JSON.parse(first.stdout.trim());
    pid = Number(fs.readFileSync(path.join(root, '.pipeline', 'ui-server.pid'), 'utf8'));
    assert.equal(a.port, port);
    assert.equal(a.started, true);
    assert.deepEqual(a.apiVersions, ['v1']);
    const second = JSON.parse(spawnSync(process.execPath, [ENSURE, '--repo', root, '--json'], { encoding: 'utf8', env, timeout: 20000 }).stdout.trim());
    assert.equal(second.started, false);
    assert.equal(second.instanceId, a.instanceId);
    assert.match(fs.readFileSync(path.join(root, '.pipeline', 'ui.url'), 'utf8'), new RegExp(`:${port}/`));
  } finally {
    if (pid) try { process.kill(pid); } catch { /* gone */ }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
