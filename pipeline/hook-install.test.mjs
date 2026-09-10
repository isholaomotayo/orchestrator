// Host hook installation: merging our checkpoint script into each host's own
// hook config format without disturbing whatever a user already has there.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOSTS, configPath, installHooks, uninstallHooks, hookStatus } from './hook-install.mjs';

function project() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hook-install-'));
}
function readConfig(root, host) {
  return JSON.parse(fs.readFileSync(configPath(root, host), 'utf8'));
}

test('configPath rejects an unsupported host', () => {
  assert.throws(() => configPath(project(), 'notepad'), /Unsupported host/);
});

test('hookStatus is unsupported when the host was never set up here at all', () => {
  const root = project();
  for (const host of HOSTS) assert.equal(hookStatus(root, host), 'unsupported');
});

for (const host of HOSTS) {
  test(`${host}: install creates the config, status flips to connected, and the command references host-hooks.mjs and this project`, () => {
    const root = project();
    const { file } = installHooks(root, host);
    assert.equal(file, configPath(root, host));
    assert.equal(hookStatus(root, host), 'connected');
    const raw = fs.readFileSync(file, 'utf8');
    assert.match(raw, /host-hooks\.mjs/);
    assert.match(raw, new RegExp(host.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')));
    assert.match(raw, new RegExp(root.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')));
  });

  test(`${host}: installing twice does not duplicate entries`, () => {
    const root = project();
    installHooks(root, host);
    const once = JSON.stringify(readConfig(root, host)).split('host-hooks.mjs').length;
    installHooks(root, host);
    const twice = JSON.stringify(readConfig(root, host)).split('host-hooks.mjs').length;
    assert.equal(twice, once, 're-running install must not add a second copy of our hooks');
  });

  test(`${host}: uninstall removes our entries and clears the file back toward empty`, () => {
    const root = project();
    installHooks(root, host);
    uninstallHooks(root, host);
    assert.equal(hookStatus(root, host), 'disconnected');
    const raw = fs.readFileSync(configPath(root, host), 'utf8');
    assert.ok(!raw.includes('host-hooks.mjs'));
  });
}

// ---- preserving what was already there --------------------------------------

test('claude: a user’s own PreToolUse hook and unrelated settings survive install and uninstall', () => {
  const root = project();
  const file = configPath(root, 'claude');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    model: 'opus',
    hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo', args: ['guard'] }] }] },
  }));
  installHooks(root, 'claude');
  let config = readConfig(root, 'claude');
  assert.equal(config.model, 'opus');
  assert.equal(config.hooks.PreToolUse[0].hooks[0].command, 'echo');
  assert.equal(hookStatus(root, 'claude'), 'connected');

  uninstallHooks(root, 'claude');
  config = readConfig(root, 'claude');
  assert.equal(config.model, 'opus');
  // The user's PreToolUse guard is untouched; only our PostToolUse/Stop groups are gone.
  assert.equal(config.hooks.PreToolUse[0].hooks[0].command, 'echo');
  assert.equal(config.hooks.PostToolUse, undefined);
  assert.equal(config.hooks.Stop, undefined);
});

test('cursor: a user’s own afterFileEdit hook in the same event array survives alongside ours', () => {
  const root = project();
  const file = configPath(root, 'cursor');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, hooks: { postToolUse: [{ command: './format.sh', type: 'command' }] } }));
  installHooks(root, 'cursor');
  const config = readConfig(root, 'cursor');
  assert.equal(config.hooks.postToolUse.length, 2);
  assert.ok(config.hooks.postToolUse.some((h) => h.command === './format.sh'));
  assert.ok(config.hooks.postToolUse.some((h) => (h.args || []).some((a) => String(a).includes('host-hooks.mjs'))));

  uninstallHooks(root, 'cursor');
  const after = readConfig(root, 'cursor');
  assert.deepEqual(after.hooks.postToolUse, [{ command: './format.sh', type: 'command' }]);
});

test('antigravity: our hooks live in their own namespaced group, untouched by unrelated groups', () => {
  const root = project();
  const file = configPath(root, 'antigravity');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ 'someone-elses-hook': { enabled: true, Stop: [{ type: 'command', command: './cleanup.sh' }] } }));
  installHooks(root, 'antigravity');
  const config = readConfig(root, 'antigravity');
  assert.deepEqual(config['someone-elses-hook'].Stop, [{ type: 'command', command: './cleanup.sh' }]);
  assert.equal(config['orchestrator-bridge'].enabled, true);

  uninstallHooks(root, 'antigravity');
  const after = readConfig(root, 'antigravity');
  assert.ok(after['someone-elses-hook']);
  assert.equal(after['orchestrator-bridge'], undefined);
});

test('uninstall on a host that was never installed is a harmless no-op', () => {
  const root = project();
  const result = uninstallHooks(root, 'claude');
  assert.equal(result.removed, false);
});
