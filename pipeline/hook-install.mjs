// Bundles host-specific hook configuration for the four supported chat hosts
// (Claude, Codex, Cursor, Antigravity), so a project can get checkpoint
// delivery wired up without hand-editing each host's own config format.
//
// Every host's config is a plain JSON file the host itself reads on startup;
// we only ever ADD our own entries to it, keyed by a recognizable command
// signature (`host-hooks.mjs`), so a user's pre-existing hooks are never
// touched and re-running install is a no-op rather than a duplicate.
//
// Schemas below are sourced from each host's own hook documentation:
//   Claude:      https://code.claude.com/docs/en/hooks
//   Codex:       https://learn.chatgpt.com/docs/hooks
//   Cursor:      https://prod.cursor.com/docs/hooks
//   Antigravity: https://antigravity.google/docs/hooks
// Hook payload field names (additionalContext, injectSteps, etc.) are handled
// entirely by host-hooks.mjs; this module only wires the SCRIPT into each
// host's config, it does not interpret hook input/output.
import fs from 'node:fs';
import path from 'node:path';

export const HOSTS = ['claude', 'codex', 'cursor', 'antigravity'];

const MARKER = 'pipeline/host-hooks.mjs';

// Which lifecycle events get our checkpoint wired in, per host's own event
// vocabulary. PostToolUse-equivalent for message delivery mid-turn, Stop for
// the "don't finish with an unresolved priority message" gate.
const EVENTS = {
  claude: { tool: 'PostToolUse', stop: 'Stop' },
  codex: { tool: 'PostToolUse', stop: 'Stop' },
  cursor: { tool: 'postToolUse', stop: 'stop' },
  antigravity: { tool: 'PreInvocation', stop: 'Stop' },
};

const CONFIG_REL = {
  claude: '.claude/settings.json',
  codex: '.codex/hooks.json',
  cursor: '.cursor/hooks.json',
  antigravity: '.agents/hooks.json',
};

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
function commandSignature(entry) {
  return [entry?.command, ...(entry?.args || [])].filter(Boolean).join(' ');
}
function isOurs(entry) {
  return commandSignature(entry).includes(MARKER);
}
function scriptEntry(projectRoot, host, event) {
  return { type: 'command', command: 'node', args: [path.join(projectRoot, 'pipeline', 'host-hooks.mjs'), host, projectRoot, event] };
}

export function configPath(projectRoot, host) {
  if (!HOSTS.includes(host)) throw new Error(`Unsupported host: ${host}`);
  return path.join(projectRoot, CONFIG_REL[host]);
}

// ---- Claude / Codex: hooks.<Event> = [{ matcher, hooks: [...] }] -----------

function installGrouped(projectRoot, host, config) {
  const out = { ...config, hooks: { ...(config.hooks || {}) } };
  for (const event of Object.values(EVENTS[host])) {
    const groups = [...(out.hooks[event] || [])];
    if (groups.some((g) => (g.hooks || []).some(isOurs))) { out.hooks[event] = groups; continue; }
    groups.push({ hooks: [scriptEntry(projectRoot, host, event)] });
    out.hooks[event] = groups;
  }
  return out;
}
function uninstallGrouped(config) {
  const out = { ...config, hooks: { ...(config.hooks || {}) } };
  for (const event of Object.keys(out.hooks)) {
    out.hooks[event] = out.hooks[event]
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurs(h)) }))
      .filter((g) => (g.hooks || []).length);
    if (!out.hooks[event].length) delete out.hooks[event];
  }
  return out;
}
function statusGrouped(config, host) {
  const events = Object.values(EVENTS[host]);
  return events.every((event) => (config?.hooks?.[event] || []).some((g) => (g.hooks || []).some(isOurs)));
}

// ---- Cursor: hooks.<event> = [{ command, type, matcher }] (no grouping) ---

function installFlat(projectRoot, host, config) {
  const out = { version: config.version ?? 1, ...config, hooks: { ...(config.hooks || {}) } };
  for (const event of Object.values(EVENTS[host])) {
    const entries = [...(out.hooks[event] || [])];
    if (entries.some(isOurs)) { out.hooks[event] = entries; continue; }
    entries.push(scriptEntry(projectRoot, host, event));
    out.hooks[event] = entries;
  }
  return out;
}
function uninstallFlat(config) {
  const out = { ...config, hooks: { ...(config.hooks || {}) } };
  for (const event of Object.keys(out.hooks)) {
    out.hooks[event] = out.hooks[event].filter((h) => !isOurs(h));
    if (!out.hooks[event].length) delete out.hooks[event];
  }
  return out;
}
function statusFlat(config, host) {
  const events = Object.values(EVENTS[host]);
  return events.every((event) => (config?.hooks?.[event] || []).some(isOurs));
}

// ---- Antigravity: a single named, namespaced hook group -------------------

const AG_GROUP = 'orchestrator-bridge';

function installNamedGroup(projectRoot, host, config) {
  const out = { ...config };
  const group = { enabled: true };
  for (const event of Object.values(EVENTS[host])) group[event] = [scriptEntry(projectRoot, host, event)];
  out[AG_GROUP] = group;
  return out;
}
function uninstallNamedGroup(config) {
  const out = { ...config };
  delete out[AG_GROUP];
  return out;
}
function statusNamedGroup(config, host) {
  const group = config?.[AG_GROUP];
  if (!group?.enabled) return false;
  return Object.values(EVENTS[host]).every((event) => (group[event] || []).some(isOurs));
}

const STRATEGY = {
  claude: { install: installGrouped, uninstall: uninstallGrouped, status: statusGrouped },
  codex: { install: installGrouped, uninstall: uninstallGrouped, status: statusGrouped },
  cursor: { install: installFlat, uninstall: uninstallFlat, status: statusFlat },
  antigravity: { install: installNamedGroup, uninstall: uninstallNamedGroup, status: statusNamedGroup },
};

/** Merge our checkpoint hooks into this host's config file, preserving everything already there. */
export function installHooks(projectRoot, host) {
  const file = configPath(projectRoot, host);
  const before = readJson(file) || {};
  const after = STRATEGY[host].install(projectRoot, host, before);
  writeJson(file, after);
  return { installed: true, file };
}

/** Remove only our own entries; a user's other hooks in the same file are untouched. */
export function uninstallHooks(projectRoot, host) {
  const file = configPath(projectRoot, host);
  const before = readJson(file);
  if (!before) return { removed: false, file };
  writeJson(file, STRATEGY[host].uninstall(before));
  return { removed: true, file };
}

/**
 * 'connected'    — our hooks are installed for this host.
 * 'unsupported'  — the host has no config directory here at all (never set up).
 * 'disconnected' — the host is set up but our hooks are not (yet, or no longer) installed.
 */
export function hookStatus(projectRoot, host) {
  const file = configPath(projectRoot, host);
  const config = readJson(file);
  if (config == null && !fs.existsSync(path.dirname(file))) return 'unsupported';
  return STRATEGY[host].status(config || {}, host) ? 'connected' : 'disconnected';
}
