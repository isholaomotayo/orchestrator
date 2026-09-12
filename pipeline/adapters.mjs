// Agent CLI adapters: invoke claude / cursor-agent / codex / agy (Antigravity)
// headlessly, or hand off to the IDE chat session (host runner) in chat mode.
// `gemini` remains a deprecated alias for the Antigravity CLI (`agy`).
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { appendEvent, STAGE_ARTIFACT_FILES } from './state.mjs';
import { firstAuthenticatedRunner, probeRunnerAuth } from './invocation.mjs';
import { modelNote, resolveModelId, normalizeEffort, fallbackModelId } from './models.mjs';
import { createStreamParser, hostEventCommand } from './events.mjs';

export const RUNNER_BINS = {
  claude: 'claude',
  cursor: 'cursor-agent',
  codex: 'codex',
  antigravity: 'agy',
  // Deprecated alias: Gemini CLI was replaced by Antigravity (`agy`).
  gemini: 'agy',
  host: null,
};

const GOOGLE_CLI_BIN = 'agy';
const GOOGLE_CLI_RUNNERS = new Set(['antigravity', 'gemini']);

/** agy accepts only low|medium|high; collapse our higher tiers. */
function googleCliEffort(level) {
  if (!level) return null;
  if (level === 'low' || level === 'medium' || level === 'high') return level;
  if (level === 'xhigh' || level === 'max') return 'high';
  return null;
}

function buildGoogleCliInvocation({ combined, readOnly, modelId, level }) {
  // agy has no hard read-only flag; withhold --dangerously-skip-permissions
  // so it cannot auto-run mutating actions during a read-only audit (best-effort).
  const args = ['-p', combined, '--output-format', 'text'];
  if (!readOnly) args.push('--dangerously-skip-permissions');
  if (modelId) args.push('--model', modelId);
  const effort = googleCliEffort(level);
  if (effort) args.push('--effort', effort);
  return { bin: GOOGLE_CLI_BIN, args, parse: 'text', readOnlyEnforced: false };
}

// Resolve a pool feature/ticket's declared runner ('auto'/null/a name) to the
// runner the supervisor should actually use. 'auto' prefers an authenticated
// CLI so real parallel automation keeps working unattended, but never throws —
// falling back to 'host' keeps a roadmap runnable with zero CLI auth at all.
export function resolvePoolRunner(requested) {
  if (!requested || requested === 'auto') return firstAuthenticatedRunner() || 'host';
  return requested;
}

/** How this run actually executes agent stages — independent of the CLI flag. */
export function resolveExecutionSurface({ runner, invocationMode, executionSurface } = {}) {
  if (executionSurface === 'host-handoff' || executionSurface === 'cli-subprocess') return executionSurface;
  if (runner === 'host' || invocationMode === 'chat') return 'host-handoff';
  return 'cli-subprocess';
}

export function isHostSurface(input = {}) {
  return resolveExecutionSurface(input) === 'host-handoff';
}

// Preflight a resolved (non-auto) runner before the supervisor spawns anything
// for it, so an unusable runner is a clean attention item instead of a crash
// inside a detached child process. A configured custom runner has no auth
// concept to probe (same reasoning as detectRunner's own forced-runner path).
export function checkRunnerAvailable(runner, config = {}) {
  if (runner === 'host') return { ok: true };
  if (config.customRunners?.[runner]) return { ok: true };
  if (!RUNNER_BINS[runner]) return { ok: false, reason: `Unknown runner "${runner}".` };
  if (!binExists(RUNNER_BINS[runner])) return { ok: false, reason: `"${runner}" is not installed on PATH.` };
  if (!probeRunnerAuth(runner)) return { ok: false, reason: `"${runner}" is on PATH but not authenticated.` };
  return { ok: true };
}

// Control-plane files a writing stage must never author. The orchestrator trusts
// these to decide verdicts, cycle budgets, and what the next stage is told to do,
// so an agent that can write them can rewrite its own grading.
export const CONTROL_PLANE_FILES = [
  '.pipeline/review_report.md',
  '.pipeline/checker_report.md',
  '.pipeline/status.json',
  '.pipeline/specs.md',
  '.pipeline/design.md',
  '.pipeline/test_history.json',
  '.pipeline/stage-handoff.json',
  '.pipeline/reporter.md',
];

// A stage always keeps write access to its OWN artifact (the Planner must be
// able to write specs.md); everything else in the control plane is denied.
export function pipelineWriteDeny(stage) {
  const own = `.pipeline/${STAGE_ARTIFACT_FILES[stage] || ''}`;
  return [
    ...CONTROL_PLANE_FILES.filter((f) => f !== own).flatMap((f) => [`Write(${f})`, `Edit(${f})`]),
    // Prompts define every agent's instructions — a stage rewriting them would
    // persist into later stages and later runs.
    'Write(.pipeline/prompts/**)',
    'Edit(.pipeline/prompts/**)',
    // Skill pins are the trust anchor for what gets injected into a prompt, and
    // reports are compiled by the engine from artifacts. A stage that could
    // write either could grade or describe its own work.
    'Write(.pipeline/skills/**)',
    'Edit(.pipeline/skills/**)',
    'Write(.pipeline/reports/**)',
    'Edit(.pipeline/reports/**)',
  ];
}

// An agent never needs forge credentials: it does not open or merge pull
// requests, the supervisor does. Withholding them means a compromised or
// confused stage cannot push, merge, or exfiltrate a token.
export function agentEnv(base = process.env) {
  const env = { ...base, FORCE_COLOR: '0' };
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITLAB_TOKEN']) delete env[key];
  return env;
}

export function binExists(bin) {
  const res = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf8' });
  return res.status === 0;
}

// The one place that decides "does chat mode override this runner". A chat
// session must always be the one driving its own stages — there is no
// legitimate reason for a chat invocation to end up dispatching to a
// different, unwatched agent CLI (the exact failure this exists to prevent:
// a task started from one IDE's chat silently ran under a different CLI that
// nobody had open, and just sat there looking stuck). Pure and shared by
// detectRunner (fresh runs) and reconcileChatRunner (continue/resume), so the
// decision lives in exactly one place.
export function resolveChatSafeRunner(requestedRunner, invocationMode) {
  if (invocationMode !== 'chat' || !requestedRunner || requestedRunner === 'host') {
    return { runner: requestedRunner ?? null, runnerRequested: null };
  }
  console.log(`[Orchestrator] Notice: runner "${requestedRunner}" coerced to "host" — invoked from chat, so this chat session stays the driver instead of silently delegating to an external, unattended agent CLI. Drop --runner (or pass --runner host) to silence this.`);
  return { runner: 'host', runnerRequested: requestedRunner };
}

export function detectRunner(config, { invocationMode = 'cli' } = {}) {
  const forced = config.runner && config.runner !== 'auto' ? config.runner : null;
  if (forced) {
    if (forced === 'host') return { runner: 'host', runnerRequested: null };
    if (!RUNNER_BINS[forced] && !config.customRunners?.[forced]) {
      throw new Error(`Unknown runner "${forced}".`);
    }
    const coerced = resolveChatSafeRunner(forced, invocationMode);
    if (coerced.runnerRequested) return coerced;
    // Only the built-in agent CLIs have an auth concept to probe. A custom
    // runner is a command the user configured explicitly; there is nothing to
    // log in to, and probing it would always "fail" and refuse a valid runner.
    const isBuiltIn = Object.prototype.hasOwnProperty.call(RUNNER_BINS, forced);
    if (invocationMode === 'cli' && isBuiltIn && !probeRunnerAuth(forced)) {
      throw new Error(`Runner "${forced}" is on PATH but not authenticated. Log in to that CLI or use --mode chat from your IDE.`);
    }
    return { runner: forced, runnerRequested: null };
  }

  // Chat mode: the IDE session is the agent — no separate CLI auth required.
  if (invocationMode === 'chat') return { runner: 'host', runnerRequested: null };

  // CLI mode: pick the first authenticated agent CLI.
  const authed = firstAuthenticatedRunner();
  if (authed) return { runner: authed, runnerRequested: null };

  // Fall back to first binary on PATH (may fail with a clear auth error).
  for (const [name, bin] of Object.entries(RUNNER_BINS)) {
    if (name === 'host' || !bin) continue;
    if (binExists(bin)) return { runner: name, runnerRequested: null };
  }
  throw new Error('No agent CLI found on PATH (looked for: claude, cursor-agent, codex, agy). Set "runner" in .pipeline/config.json, pass --runner, or invoke from an IDE chat for host mode.');
}

// For --continue/--resume/--extend: reconciles an already-resolved runner
// against both its recorded chat surface and this invocation's own freshly
// detected mode. Self-heals a status.json baked before this coercion existed
// (runner mismatched against chat-mode metadata), and converges a fresh
// --resume/--continue invoked from a live chat session onto 'host' even if
// the halted run was originally a genuine cli-subprocess run — a chat
// session must always drive its own stages, with no carve-out for what the
// run used to be. Returns null when nothing needs to change.
export function reconcileChatRunner({ runner, statusInvocationMode, statusExecutionSurface, currentInvocationMode }) {
  const recordedHostSurface = isHostSurface({ runner, invocationMode: statusInvocationMode, executionSurface: statusExecutionSurface });
  if (!recordedHostSurface && currentInvocationMode !== 'chat') return null;
  const { runner: safeRunner, runnerRequested } = resolveChatSafeRunner(runner, 'chat');
  return { runner: safeRunner, executionSurface: 'host-handoff', invocationMode: 'chat', runnerRequested };
}

// Build argv for each supported CLI. Every adapter runs non-interactively with
// verbose/streamed output so the dashboard can show live activity.
//
// readOnly (the Reviewer's read-only audit) MUST be honored by every runner, not
// just claude — otherwise the "read-only" review stage could mutate the repo or
// weaken tests. Each branch sets `readOnlyEnforced` to signal whether the CLI can
// hard-guarantee read-only at the process level. When it cannot, we drop the
// auto-approve/write flags (--force / --full-auto / --dangerously-skip-permissions) so the agent cannot
// silently apply edits — a best-effort constraint the caller can still reject.
export function buildInvocation({ runner, stage, systemPrompt, task, readOnly, config, model, effort, artifactOverride = null, skills = null }) {
  // Verified skill instructions sit AFTER the stage prompt (so the trust
  // boundary is read first) and are still system prompt, never task input.
  const promptWithSkills = skills?.promptSection
    ? `${systemPrompt}\n\n${skills.promptSection}`
    : systemPrompt;
  systemPrompt = promptWithSkills;
  const combined = `${systemPrompt}\n\n---\nTASK:\n${task}`;
  // Model families are pipeline-internal; each CLI gets the identifier it
  // actually accepts. cursor encodes effort in the id, so it is resolved here too.
  const modelId = resolveModelId(model, runner, normalizeEffort(effort));
  const level = normalizeEffort(effort);
  switch (runner) {
    case 'claude': {
      const args = [
        '-p', task,
        '--append-system-prompt', systemPrompt,
        '--verbose',
        '--output-format', 'stream-json',
      ];
      if (modelId) args.push('--model', modelId);
      if (level) args.push('--effort', level);
      // Capacity/entitlement failures degrade a tier instead of halting the run.
      const fallback = fallbackModelId(model, 'claude');
      if (fallback && fallback !== modelId) args.push('--fallback-model', fallback);
      if (readOnly) {
        // Headless mode denies anything not allowlisted: a read-only stage may
        // read, run git diff/log, and write ONLY its own artifact file.
        const artifact = artifactOverride || `.pipeline/${STAGE_ARTIFACT_FILES[stage] || 'review_report.md'}`;
        // A skill may add read-only commands (a validator, a lookup) — never a
        // renderer or anything that writes, which the engine runs itself.
        const skillTools = (skills?.allowances || []).join(',');
        args.push('--allowedTools', `Read,Glob,Grep,Bash(git diff:*),Bash(git log:*),Bash(git status:*),Write(${artifact})${skillTools ? `,${skillTools}` : ''}`);
        return { bin: 'claude', args, parse: 'claude-stream-json', readOnlyEnforced: true };
      }
      args.push('--permission-mode', 'acceptEdits', '--allowedTools', 'Bash,Edit,Write,Read,Glob,Grep,WebFetch');
      // A writing stage must not touch the control plane. Without this the Coder
      // can write .pipeline/review_report.md containing "## Verdict: APPROVED"
      // and approve its own work — the orchestrator only regex-parses that file.
      args.push('--disallowedTools', pipelineWriteDeny(stage).join(','));
      return { bin: 'claude', args, parse: 'claude-stream-json', readOnlyEnforced: false };
    }
    case 'cursor': {
      // cursor-agent has no read-only allowlist; withhold --force so it cannot
      // auto-approve writes during a read-only audit (best-effort).
      const args = ['-p', combined, '--output-format', 'stream-json'];
      if (!readOnly) args.push('--force');
      // No --effort flag: resolveModelId already selected the effort-tiered id.
      if (modelId) args.push('--model', modelId);
      return { bin: 'cursor-agent', args, parse: 'stream-json', readOnlyEnforced: false };
    }
    case 'codex': {
      // codex exec supports a hard read-only sandbox.
      const args = ['exec'];
      if (readOnly) args.push('--sandbox', 'read-only');
      else args.push('--full-auto');
      args.push('--json');
      if (modelId) args.push('--model', modelId);
      // Effort is a config override rather than a flag on `codex exec`.
      if (level) args.push('-c', `model_reasoning_effort="${level}"`);
      args.push(combined);
      return { bin: 'codex', args, parse: 'stream-json', readOnlyEnforced: !!readOnly };
    }
    case 'antigravity':
    case 'gemini':
      return buildGoogleCliInvocation({ combined, readOnly, modelId, level });
    default: {
      const custom = config.customRunners?.[runner];
      if (!custom) throw new Error(`Unknown runner "${runner}"`);
      const sub = (s) => s
        .replaceAll('{task}', task)
        .replaceAll('{systemPrompt}', systemPrompt)
        .replaceAll('{model}', modelId || '')
        .replaceAll('{effort}', level || '')
        .replaceAll('{readOnly}', String(!!readOnly));
      return { bin: custom.command, args: (custom.args || []).map(sub), parse: 'text', readOnlyEnforced: false };
    }
  }
}

function writeHostHandoff({ stage, cycle, task, systemPromptFile, readOnly, paths, model, effort, modelSelection, hostClient = null, skills = null }) {
  const handoff = {
    stage,
    cycle: cycle || 1,
    task,
    promptFile: path.relative(paths.root, systemPromptFile),
    artifact: `.pipeline/${STAGE_ARTIFACT_FILES[stage]}`,
    readOnly: !!readOnly,
    createdAt: new Date().toISOString(),
  };
  if (model) {
    handoff.model = model;
    handoff.modelSelection = modelSelection || 'auto';
    handoff.modelNote = modelNote(model, normalizeEffort(effort));
  }
  if (normalizeEffort(effort)) handoff.effort = normalizeEffort(effort);
  if (skills?.active?.length) {
    // A chat host reads the same verified instructions a CLI runner would.
    handoff.skills = skills.active.map((a) => ({ name: a.skill.name, dir: a.dir, entry: a.skill.entry }));
    handoff.skillsPromptSection = skills.promptSection;
  }
  if (hostClient) {
    handoff.hostClient = hostClient;
    handoff.hostNote = `Complete this stage in the current ${hostClient} chat session. Do NOT spawn or delegate to another agent CLI.`;
  }
  handoff.bridge = { version: 2, project: paths.root, runId: paths.runId, instructions: 'Register your host conversation, run.claim this handoff, run.checkpoint before work and after tool batches, acknowledge and resolve operator messages, then stage.complete. Never edit control state directly.', command: 'node pipeline/bridge-cli.mjs <command> --input-file <json-file>' };
  handoff.eventCommand = hostEventCommand({ runId: paths.runId, stage });
  fs.writeFileSync(paths.stageHandoff, JSON.stringify(handoff, null, 2));
  appendEvent(paths, { stage, cycle, type: 'chat_handoff', artifact: handoff.artifact, ...(hostClient ? { hostClient } : {}) });
}

export function runAgent({ runner, stage, cycle = 0, task, systemPromptFile, cwd, readOnly = false, paths, config, model, effort, modelSelection, hostClient = null, artifactOverride = null, skills = null }) {
  if (runner === 'host') {
    fs.mkdirSync(paths.logs, { recursive: true });
    const logFile = path.join(paths.logs, `${stage}.log`);
    const modelLabel = model ? ` · suggested model ${model} (actual model determined by chat)` : '';
    const hostLabel = hostClient ? ` (IDE chat: ${hostClient})` : ' (IDE chat)';
    fs.appendFileSync(logFile, `\n===== ${stage.toUpperCase()} (cycle ${cycle || 1}) — host${hostLabel}${modelLabel} — ${new Date().toISOString()} =====\n`);
    appendEvent(paths, { stage, cycle, type: 'agent_start', runner: 'host', model: model || undefined, effort: normalizeEffort(effort) || undefined, hostClient: hostClient || undefined });
    writeHostHandoff({ stage, cycle, task, systemPromptFile, readOnly, paths, model, effort, modelSelection, hostClient, skills });
    appendEvent(paths, { stage, cycle, type: 'agent_parked', ok: true, hostHandoff: true });
    return Promise.resolve({ ok: false, hostHandoff: true });
  }

  const systemPrompt = fs.readFileSync(systemPromptFile, 'utf8');
  const { bin, args, readOnlyEnforced } = buildInvocation({ runner, stage, systemPrompt, task, readOnly, config, model, effort, artifactOverride, skills });

  fs.mkdirSync(paths.logs, { recursive: true });
  const logFile = path.join(paths.logs, `${stage}.log`);
  const log = fs.createWriteStream(logFile, { flags: cycle > 1 ? 'a' : 'w' });
  const level = normalizeEffort(effort);
  const modelLabel = model ? ` · model ${model}${level ? ` · effort ${level}` : ''}` : '';
  log.write(`\n===== ${stage.toUpperCase()} (cycle ${cycle || 1}) — ${runner}${modelLabel} — ${new Date().toISOString()} =====\n`);
  if (readOnly && !readOnlyEnforced) {
    const warn = `[warn] runner "${runner}" cannot hard-enforce read-only; auto-approve flags withheld (best-effort). Use claude or codex for a guaranteed read-only audit.`;
    log.write(warn + '\n');
    appendEvent(paths, { stage, cycle, type: 'readonly_best_effort', runner });
  }
  appendEvent(paths, { stage, cycle, type: 'agent_start', runner, model: model || undefined, effort: level || undefined });

  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, env: { ...process.env, FORCE_COLOR: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      appendEvent(paths, { stage, cycle, type: 'agent_timeout', timeoutMs: config.agentTimeoutMs });
      child.kill('SIGKILL');
    }, config.agentTimeoutMs);

    let buffer = '';
    const parser = createStreamParser();
    const emit = (b) => {
      appendEvent(paths, { stage, cycle, type: 'agent_output', ...b });
    };
    const handleChunk = (chunk, isErr) => {
      buffer += chunk.toString();
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        log.write(`${line}\n`);
        if (isErr) {
          if (line.trim()) emit({ kind: 'err', text: line });
          continue;
        }
        parser.pushLine(line).forEach(emit);
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
        log.write(buffer.endsWith('\n') ? buffer : `${buffer}\n`);
        parser.pushLine(buffer).forEach(emit);
      }
      parser.flush().forEach(emit);
      if (timedOut) log.write(`[error] agent exceeded agentTimeoutMs (${config.agentTimeoutMs}ms) and was killed\n`);
      appendEvent(paths, { stage, cycle, type: 'agent_end', ok: code === 0, exitCode: code, timedOut: timedOut || undefined });
      log.end();
      resolve({ ok: code === 0, exitCode: code, timedOut });
    });
  });
}

export function runOneShot({ runner, prompt, config, model, timeoutMs = 15000 }) {
  const bin = RUNNER_BINS[runner] || config?.customRunners?.[runner]?.command;
  if (!bin) {
    return Promise.reject(new Error(`Runner "${runner}" has no executable binary.`));
  }
  let args = [];
  if (runner === 'claude' || runner === 'cursor' || GOOGLE_CLI_RUNNERS.has(runner)) {
    args = ['-p', prompt];
    if (model) args.push('--model', model);
  } else if (runner === 'codex') {
    args = ['exec', '--full-auto', prompt];
    if (model) args.push('--model', model);
  } else {
    const custom = config?.customRunners?.[runner];
    if (custom) {
      const sub = (s) => s
        .replaceAll('{task}', prompt)
        .replaceAll('{systemPrompt}', '')
        .replaceAll('{readOnly}', 'true');
      args = (custom.args || []).map(sub);
    } else {
      return Promise.reject(new Error(`Unsupported runner for runOneShot: ${runner}`));
    }
  }

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env: { ...process.env, FORCE_COLOR: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`runOneShot timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (c) => { stdout += c.toString(); });
    child.stderr.on('data', (c) => { stderr += c.toString(); });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`Runner "${runner}" exited with code ${code}. Stderr: ${stderr.trim()}`));
      }
    });
  });
}

