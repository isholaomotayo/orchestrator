// Agent CLI adapters: invoke claude / cursor-agent / codex / gemini headlessly,
// or hand off to the IDE chat session (host runner) when in chat mode.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { appendEvent, STAGE_ARTIFACT_FILES } from './state.mjs';
import { firstAuthenticatedRunner, probeRunnerAuth } from './invocation.mjs';

const RUNNER_BINS = { claude: 'claude', cursor: 'cursor-agent', codex: 'codex', gemini: 'gemini', host: null };

export function binExists(bin) {
  const res = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf8' });
  return res.status === 0;
}

export function detectRunner(config, { invocationMode = 'cli' } = {}) {
  const forced = config.runner && config.runner !== 'auto' ? config.runner : null;
  if (forced) {
    if (forced === 'host') return 'host';
    if (!RUNNER_BINS[forced] && !config.customRunners?.[forced]) {
      throw new Error(`Unknown runner "${forced}".`);
    }
    if (invocationMode === 'cli' && forced !== 'host' && !probeRunnerAuth(forced)) {
      throw new Error(`Runner "${forced}" is on PATH but not authenticated. Log in to that CLI or use --mode chat from your IDE.`);
    }
    return forced;
  }

  // Chat mode: the IDE session is the agent — no separate CLI auth required.
  if (invocationMode === 'chat') return 'host';

  // CLI mode: pick the first authenticated agent CLI.
  const authed = firstAuthenticatedRunner();
  if (authed) return authed;

  // Fall back to first binary on PATH (may fail with a clear auth error).
  for (const [name, bin] of Object.entries(RUNNER_BINS)) {
    if (name === 'host' || !bin) continue;
    if (binExists(bin)) return name;
  }
  throw new Error('No agent CLI found on PATH (looked for: claude, cursor-agent, codex, gemini). Set "runner" in .pipeline/config.json, pass --runner, or invoke from an IDE chat for host mode.');
}

// Build argv for each supported CLI. Every adapter runs non-interactively with
// verbose/streamed output so the dashboard can show live activity.
function buildInvocation({ runner, systemPrompt, task, readOnly, config }) {
  const combined = `${systemPrompt}\n\n---\nTASK:\n${task}`;
  switch (runner) {
    case 'claude': {
      const args = [
        '-p', task,
        '--append-system-prompt', systemPrompt,
        '--verbose',
        '--output-format', 'stream-json',
      ];
      if (readOnly) {
        // Headless mode denies anything not allowlisted: reviewer may read,
        // run git diff/log, and write ONLY its report file.
        args.push('--allowedTools', 'Read,Glob,Grep,Bash(git diff:*),Bash(git log:*),Bash(git status:*),Write(.pipeline/review_report.md)');
      } else {
        args.push('--permission-mode', 'acceptEdits', '--allowedTools', 'Bash,Edit,Write,Read,Glob,Grep,WebFetch');
      }
      return { bin: 'claude', args, parse: 'claude-stream-json' };
    }
    case 'cursor': {
      const args = ['-p', combined, '--output-format', 'stream-json', '--force'];
      return { bin: 'cursor-agent', args, parse: 'jsonl-or-text' };
    }
    case 'codex': {
      const args = ['exec', '--full-auto', '--json', combined];
      return { bin: 'codex', args, parse: 'jsonl-or-text' };
    }
    case 'gemini': {
      const args = ['-p', combined, '--yolo'];
      return { bin: 'gemini', args, parse: 'text' };
    }
    default: {
      const custom = config.customRunners?.[runner];
      if (!custom) throw new Error(`Unknown runner "${runner}"`);
      const sub = (s) => s
        .replaceAll('{task}', task)
        .replaceAll('{systemPrompt}', systemPrompt)
        .replaceAll('{readOnly}', String(!!readOnly));
      return { bin: custom.command, args: (custom.args || []).map(sub), parse: 'text' };
    }
  }
}

function writeHostHandoff({ stage, cycle, task, systemPromptFile, readOnly, paths }) {
  const handoff = {
    stage,
    cycle: cycle || 1,
    task,
    promptFile: path.relative(paths.root, systemPromptFile),
    artifact: `.pipeline/${STAGE_ARTIFACT_FILES[stage]}`,
    readOnly: !!readOnly,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(paths.stageHandoff, JSON.stringify(handoff, null, 2));
  appendEvent(paths, { stage, cycle, type: 'chat_handoff', artifact: handoff.artifact });
}

// Turn a claude stream-json event line into structured activity blocks the
// dashboard can render (text paragraphs, file chips, command cards).
function parseClaudeEvent(line) {
  let ev;
  try { ev = JSON.parse(line); } catch { return [{ kind: 'text', text: line }]; }
  if (ev.type === 'system' && ev.subtype === 'init') return [{ kind: 'sys', text: `session started · model ${ev.model || '?'}` }];
  if (ev.type === 'assistant') {
    const blocks = [];
    for (const block of ev.message?.content || []) {
      if (block.type === 'text' && block.text?.trim()) blocks.push({ kind: 'text', text: block.text.trim() });
      if (block.type === 'tool_use') {
        const input = block.input || {};
        blocks.push({
          kind: 'tool',
          tool: block.name,
          file: input.file_path || input.path || input.notebook_path || null,
          cmd: input.command || input.pattern || input.query || null,
        });
      }
    }
    return blocks;
  }
  if (ev.type === 'result') {
    return [{
      kind: 'sys',
      text: `done · ${ev.subtype || ''} · ${ev.num_turns ?? '?'} turns · $${ev.total_cost_usd?.toFixed?.(4) ?? '?'}`,
      costUsd: typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : undefined,
      turns: ev.num_turns,
    }];
  }
  return []; // user/tool_result echoes — too noisy for the dashboard
}

function parseLine(parse, line) {
  if (!line.trim()) return [];
  if (parse === 'claude-stream-json') return parseClaudeEvent(line);
  if (parse === 'jsonl-or-text') {
    try {
      const ev = JSON.parse(line);
      const text = ev.text || ev.message || ev.content;
      return typeof text === 'string' ? [{ kind: 'text', text }] : [{ kind: 'text', text: line }];
    } catch { return [{ kind: 'text', text: line }]; }
  }
  return [{ kind: 'text', text: line }];
}

function blockToLogLine(b) {
  if (b.kind === 'tool') return `[tool] ${b.tool} ${b.file || b.cmd || ''}`.trim();
  if (b.kind === 'sys') return `[session] ${b.text}`;
  if (b.kind === 'err') return `[stderr] ${b.text}`;
  return b.text;
}

export function runAgent({ runner, stage, cycle = 0, task, systemPromptFile, cwd, readOnly = false, paths, config }) {
  if (runner === 'host') {
    fs.mkdirSync(paths.logs, { recursive: true });
    const logFile = path.join(paths.logs, `${stage}.log`);
    fs.appendFileSync(logFile, `\n===== ${stage.toUpperCase()} (cycle ${cycle || 1}) — host (IDE chat) — ${new Date().toISOString()} =====\n`);
    appendEvent(paths, { stage, cycle, type: 'agent_start', runner: 'host' });
    writeHostHandoff({ stage, cycle, task, systemPromptFile, readOnly, paths });
    appendEvent(paths, { stage, cycle, type: 'agent_end', ok: false, hostHandoff: true });
    return Promise.resolve({ ok: false, hostHandoff: true });
  }

  const systemPrompt = fs.readFileSync(systemPromptFile, 'utf8');
  const { bin, args, parse } = buildInvocation({ runner, systemPrompt, task, readOnly, config });

  fs.mkdirSync(paths.logs, { recursive: true });
  const logFile = path.join(paths.logs, `${stage}.log`);
  const log = fs.createWriteStream(logFile, { flags: cycle > 1 ? 'a' : 'w' });
  log.write(`\n===== ${stage.toUpperCase()} (cycle ${cycle || 1}) — ${runner} — ${new Date().toISOString()} =====\n`);
  appendEvent(paths, { stage, cycle, type: 'agent_start', runner });

  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, env: { ...process.env, FORCE_COLOR: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });

    const timer = setTimeout(() => {
      appendEvent(paths, { stage, cycle, type: 'agent_timeout' });
      child.kill('SIGKILL');
    }, config.agentTimeoutMs);

    let buffer = '';
    const emit = (b) => {
      log.write(blockToLogLine(b) + '\n');
      appendEvent(paths, { stage, cycle, type: 'agent_output', ...b });
    };
    const handleChunk = (chunk, isErr) => {
      buffer += chunk.toString();
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        const blocks = isErr ? (line.trim() ? [{ kind: 'err', text: line }] : []) : parseLine(parse, line);
        blocks.forEach(emit);
      }
    };
    child.stdout.on('data', (c) => handleChunk(c, false));
    child.stderr.on('data', (c) => handleChunk(c, true));

    child.on('error', (err) => {
      clearTimeout(timer);
      log.write(`[error] failed to spawn ${bin}: ${err.message}\n`);
      appendEvent(paths, { stage, cycle, type: 'agent_end', ok: false, error: err.message });
      log.end();
      resolve({ ok: false, exitCode: -1, error: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (buffer.trim()) parseLine(parse, buffer).forEach(emit);
      appendEvent(paths, { stage, cycle, type: 'agent_end', ok: code === 0, exitCode: code });
      log.end();
      resolve({ ok: code === 0, exitCode: code });
    });
  });
}
