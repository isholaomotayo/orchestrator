// Detect whether the pipeline was invoked from an IDE chat session (host mode)
// or from a terminal / CI job (headless CLI subprocesses).
import { spawnSync } from 'node:child_process';

function binExists(bin) {
  const res = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf8' });
  return res.status === 0;
}

const CHAT_ENV_SIGNALS = [
  ['CURSOR_AGENT', '1'],
  ['CURSOR_TRACE_ID', null], // any value
  ['CLAUDE_CODE', '1'],
  ['CLAUDECODE', '1'],
  ['CODEX_IN_IDE', '1'],
  ['GEMINI_CLI_IDE', '1'],
];

// Canonical host-client names plus the aliases instruction files might pass.
const HOST_CLIENT_ALIASES = {
  agy: 'antigravity',
  'claude-code': 'claude',
  'cursor-agent': 'cursor',
};

/** Normalize a --host-client / PIPELINE_HOST_CLIENT value ('AGY' → 'antigravity'). */
export function normalizeHostClient(name) {
  if (typeof name !== 'string') return null;
  const lower = name.trim().toLowerCase();
  if (!lower) return null;
  return HOST_CLIENT_ALIASES[lower] || lower;
}

function hostClientFlagValue(argv) {
  const idx = argv.indexOf('--host-client');
  if (idx < 0) return null;
  return normalizeHostClient(argv[idx + 1]);
}

/**
 * Which IDE/chat client hosts this invocation (chat mode attribution + model
 * selection). Precedence: explicit flag → PIPELINE_HOST_CLIENT → env signals.
 * @returns {string | null}
 */
export function detectHostClient({ env = process.env, argv = [] } = {}) {
  const flagged = hostClientFlagValue(argv);
  if (flagged) return flagged;
  const fromEnv = normalizeHostClient(env.PIPELINE_HOST_CLIENT);
  if (fromEnv) return fromEnv;
  if (Object.keys(env).some((k) => k.startsWith('ANTIGRAVITY'))) return 'antigravity';
  if (env.CURSOR_AGENT === '1' || env.CURSOR_TRACE_ID) return 'cursor';
  if (env.CLAUDE_CODE === '1' || env.CLAUDECODE) return 'claude';
  if (env.CODEX_IN_IDE === '1') return 'codex';
  if (env.GEMINI_CLI_IDE === '1') return 'gemini';
  if (env.VSCODE_PID) return 'vscode';
  return null;
}

/**
 * @returns {{ mode: 'chat' | 'cli', source: string }}
 */
export function detectInvocationMode({ env = process.env, argv = [] } = {}) {
  const modeFlagIdx = argv.indexOf('--mode');
  if (modeFlagIdx >= 0) {
    const mode = argv[modeFlagIdx + 1];
    if (mode === 'chat' || mode === 'cli') return { mode, source: 'flag' };
  }
  if (env.PIPELINE_INVOCATION === 'chat') return { mode: 'chat', source: 'env' };
  if (env.PIPELINE_INVOCATION === 'cli') return { mode: 'cli', source: 'env' };

  // An explicit host client means an IDE chat session is driving this run — it
  // outranks CI/TTY heuristics (which misfire in IDE-integrated terminals).
  if (hostClientFlagValue(argv)) return { mode: 'chat', source: 'host-client-flag' };
  if (normalizeHostClient(env.PIPELINE_HOST_CLIENT)) return { mode: 'chat', source: 'host-client-env' };

  if (env.CI === 'true' || env.GITHUB_ACTIONS || env.GITLAB_CI || env.CIRCLECI) {
    return { mode: 'cli', source: 'ci' };
  }

  for (const [key, value] of CHAT_ENV_SIGNALS) {
    if (value === null ? env[key] : env[key] === value) {
      return { mode: 'chat', source: key.toLowerCase() };
    }
  }

  // Antigravity sets no single stable flag — any ANTIGRAVITY* env means its
  // chat/agent surface is hosting this process.
  if (Object.keys(env).some((k) => k.startsWith('ANTIGRAVITY'))) {
    return { mode: 'chat', source: 'antigravity' };
  }

  // Interactive terminal invocation → CLI subprocess mode.
  if (process.stdout.isTTY && process.stdin.isTTY) {
    return { mode: 'cli', source: 'tty' };
  }

  // IDE-integrated shells (Cursor agent exec, VS Code tasks) are usually non-TTY.
  if (env.VSCODE_PID && !process.stdout.isTTY) {
    return { mode: 'chat', source: 'ide-shell' };
  }

  return { mode: 'cli', source: 'default' };
}

function probeClaudeAuth() {
  if (!binExists('claude')) return false;
  const res = spawnSync('claude', ['auth', 'status'], { encoding: 'utf8', timeout: 8000 });
  if (res.status !== 0) return false;
  try {
    return JSON.parse(res.stdout).loggedIn === true;
  } catch {
    return /"loggedIn"\s*:\s*true/.test(res.stdout);
  }
}

function probeCursorAuth() {
  if (!binExists('cursor-agent')) return false;
  if (process.env.CURSOR_API_KEY) return true;
  const res = spawnSync('cursor-agent', ['-p', 'ok', '--output-format', 'text'], {
    encoding: 'utf8',
    timeout: 8000,
    input: '',
  });
  const out = `${res.stdout}\n${res.stderr}`;
  return res.status === 0 && !/authentication required/i.test(out);
}

function probeCodexAuth() {
  if (!binExists('codex')) return false;
  const res = spawnSync('codex', ['login', 'status'], { encoding: 'utf8', timeout: 8000 });
  const out = `${res.stdout}\n${res.stderr}`;
  return res.status === 0 && /logged in/i.test(out);
}

function probeGeminiAuth() {
  if (!binExists('gemini')) return false;
  const res = spawnSync('gemini', ['-p', 'ok'], { encoding: 'utf8', timeout: 8000, input: '' });
  const out = `${res.stdout}\n${res.stderr}`;
  return res.status === 0 && !/not authenticated|login required|sign in/i.test(out);
}

const AUTH_PROBES = {
  claude: probeClaudeAuth,
  cursor: probeCursorAuth,
  codex: probeCodexAuth,
  gemini: probeGeminiAuth,
};

/** First CLI runner on PATH that passes an auth probe (CLI mode only). */
export function firstAuthenticatedRunner(order = ['claude', 'cursor', 'codex', 'gemini']) {
  for (const name of order) {
    const probe = AUTH_PROBES[name];
    if (probe?.()) return name;
  }
  return null;
}

export function probeRunnerAuth(runner) {
  return AUTH_PROBES[runner]?.() ?? false;
}
