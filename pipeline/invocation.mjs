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

  if (env.CI === 'true' || env.GITHUB_ACTIONS || env.GITLAB_CI || env.CIRCLECI) {
    return { mode: 'cli', source: 'ci' };
  }

  for (const [key, value] of CHAT_ENV_SIGNALS) {
    if (value === null ? env[key] : env[key] === value) {
      return { mode: 'chat', source: key.toLowerCase() };
    }
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
