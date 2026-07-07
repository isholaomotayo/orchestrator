// Agent CLI adapters: invoke claude / cursor-agent / codex / gemini headlessly,
// stream verbose output to .pipeline/logs/<stage>.log and events.jsonl.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { appendEvent } from './state.mjs';

const RUNNER_BINS = { claude: 'claude', cursor: 'cursor-agent', codex: 'codex', gemini: 'gemini' };

export function binExists(bin) {
  const res = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf8' });
  return res.status === 0;
}

export function detectRunner(config) {
  if (config.runner && config.runner !== 'auto') return config.runner;
  for (const [name, bin] of Object.entries(RUNNER_BINS)) {
    if (binExists(bin)) return name;
  }
  throw new Error('No agent CLI found on PATH (looked for: claude, cursor-agent, codex, gemini). Set "runner" in .pipeline/config.json or pass --runner.');
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

// Turn a claude stream-json event line into a short human-readable log line.
function summarizeClaudeEvent(line) {
  let ev;
  try { ev = JSON.parse(line); } catch { return line; }
  if (ev.type === 'system' && ev.subtype === 'init') return `[session] model=${ev.model || '?'}`;
  if (ev.type === 'assistant') {
    const parts = [];
    for (const block of ev.message?.content || []) {
      if (block.type === 'text' && block.text?.trim()) parts.push(block.text.trim());
      if (block.type === 'tool_use') {
        const input = JSON.stringify(block.input || {});
        parts.push(`[tool] ${block.name} ${input.length > 200 ? input.slice(0, 200) + '…' : input}`);
      }
    }
    return parts.join('\n') || null;
  }
  if (ev.type === 'result') {
    return `[result] ${ev.subtype || ''} turns=${ev.num_turns ?? '?'} cost=$${ev.total_cost_usd?.toFixed?.(4) ?? '?'}`;
  }
  return null; // user/tool_result echoes — too noisy for the dashboard
}

function summarizeLine(parse, line) {
  if (!line.trim()) return null;
  if (parse === 'claude-stream-json') return summarizeClaudeEvent(line);
  if (parse === 'jsonl-or-text') {
    try {
      const ev = JSON.parse(line);
      return ev.text || ev.message || ev.content || line;
    } catch { return line; }
  }
  return line;
}

export function runAgent({ runner, stage, cycle = 0, task, systemPromptFile, cwd, readOnly = false, paths, config }) {
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
    const handleChunk = (chunk, isErr) => {
      buffer += chunk.toString();
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        const summary = isErr ? (line.trim() ? `[stderr] ${line}` : null) : summarizeLine(parse, line);
        if (summary) {
          log.write(summary + '\n');
          appendEvent(paths, { stage, cycle, type: 'agent_output', line: summary });
        }
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
      if (buffer.trim()) {
        const summary = summarizeLine(parse, buffer);
        if (summary) { log.write(summary + '\n'); appendEvent(paths, { stage, cycle, type: 'agent_output', line: summary }); }
      }
      appendEvent(paths, { stage, cycle, type: 'agent_end', ok: code === 0, exitCode: code });
      log.end();
      resolve({ ok: code === 0, exitCode: code });
    });
  });
}
