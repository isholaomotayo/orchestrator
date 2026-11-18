// Agent CLI adapters: invoke claude / cursor-agent / codex / agy (Antigravity)
// headlessly, or hand off to the IDE chat session (host runner) in chat mode.
// `gemini` remains a deprecated alias for the Antigravity CLI (`agy`).
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { appendEvent, STAGE_ARTIFACT_FILES } from './state.mjs';
import { firstAuthenticatedRunner, probeRunnerAuth } from './invocation.mjs';
import { modelNote, resolveModelId, normalizeEffort, fallbackModelId, CURRENT_CHAT_MODEL } from './models.mjs';
import { createStreamParser, hostEventCommand } from './events.mjs';
import { hookStatus } from './hook-install.mjs';

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

function buildGoogleCliInvocation({ combined, readOnly, modelId, level, runner }) {
  // agy has no hard read-only flag. Pass --dangerously-skip-permissions so it
  // doesn't hang on stdin prompts in non-interactive mode.
  // Exception: the 'gemini' runner is a deprecated alias with stricter read-only
  // semantics (consistent with how cursor/codex withhold write flags). When
  // readOnly is true, omit the flag as best-effort enforcement — the caller's
  // warning log will note that hard enforcement is unavailable for this runner.
  const skipPerms = !readOnly || runner !== 'gemini';
  const args = ['-p', combined, '--output-format', 'text'];
  if (skipPerms) args.push('--dangerously-skip-permissions');
  if (modelId) args.push('--model', modelId);
  const effort = googleCliEffort(level);
  if (effort) args.push('--effort', effort);
  return { bin: GOOGLE_CLI_BIN, args, parse: 'text', readOnlyEnforced: false };
}

// Resolve a pool feature/ticket's declared runner ('auto'/null/a name) to the
// runner the supervisor should actually use. Pool work stays with the
// attending chat unless a CLI runner was explicitly selected.
export function resolvePoolRunner(requested) {
  if (!requested || requested === 'auto') return 'host';
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
  '.pipeline/plan_review.md',
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

// Agent CLIs currently running for this engine, so a stop or signal can take
// them down with it instead of leaving orphans editing the worktree.
const liveAgents = new Set();
let stopping = false;

/** Time a timed-out agent gets between SIGTERM and SIGKILL. */
export const KILL_GRACE_MS = 10_000;

function killAgentTree(child, signal) {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch { try { child.kill(signal); } catch { /* already gone */ } }
}

/** Whether anything in the agent's process group is still running. */
function groupAlive(child) {
  if (!child.pid) return false;
  try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 0); return true; } catch { return false; }
}

/** Wait (up to `ms`) until nothing in the agent's process group is left; SIGKILL takes a moment to land. */
async function untilGroupGone(child, ms = 2000) {
  const deadline = Date.now() + ms;
  while (groupAlive(child) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
}

/** Signal every live agent's whole process group; returns how many were signalled. */
export function killLiveAgents(signal = 'SIGTERM') {
  let n = 0;
  for (const child of liveAgents) { killAgentTree(child, signal); n += 1; }
  return n;
}

/**
 * Stop every live agent's process group: SIGTERM, up to `graceMs` for the
 * groups to exit, then SIGKILL for whatever is left. Resolves once nothing is
 * left running, so the caller can release the run lock knowing no old worker
 * can overlap a resumed one. Returns how many groups were signalled.
 */
export async function stopLiveAgents({ graceMs = KILL_GRACE_MS, pollMs = 100 } = {}) {
  // From here the engine is exiting: an agent that ends now reports nothing
  // (the stage code must not retry or halt under another reason) and no new
  // agent starts.
  stopping = true;
  const children = [...liveAgents];
  for (const child of children) killAgentTree(child, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (children.some(groupAlive) && Date.now() < deadline) await new Promise((r) => setTimeout(r, pollMs));
  const left = children.filter(groupAlive);
  for (const child of left) killAgentTree(child, 'SIGKILL');
  await Promise.all(left.map((child) => untilGroupGone(child)));
  return children.length;
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
// auto-approve/write flags (--force / --dangerously-skip-permissions; codex instead gets a read-only sandbox) so the agent cannot
// silently apply edits — a best-effort constraint the caller can still reject.
export function buildInvocation({ runner, stage, systemPrompt, task, readOnly, config, model, effort, artifactOverride = null, skills = null, resumeSession = null }) {
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
      // A fix cycle continues the conversation that wrote the code, so the agent
      // keeps what it already read instead of re-exploring the repo cold.
      if (resumeSession) args.push('--resume', resumeSession);
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
      // codex exec supports a hard read-only sandbox. Writing stages use the
      // workspace-write sandbox (current codex rejects the old --full-auto).
      const sandbox = readOnly ? 'read-only' : 'workspace-write';
      // `exec resume` takes no --sandbox flag; the same policy goes in as config.
      const args = resumeSession
        ? ['exec', 'resume', '-c', `sandbox_mode="${sandbox}"`]
        : ['exec', '--sandbox', sandbox];
      args.push('--json');
      if (modelId) args.push('--model', modelId);
      // Effort is a config override rather than a flag on `codex exec`.
      if (level) args.push('-c', `model_reasoning_effort="${level}"`);
      // A resumed thread already holds the stage prompt; send only the new task.
      if (resumeSession) args.push(resumeSession, task);
      else args.push(combined);
      return { bin: 'codex', args, parse: 'stream-json', readOnlyEnforced: !!readOnly };
    }
    case 'antigravity':
    case 'gemini':
      return buildGoogleCliInvocation({ combined, readOnly, modelId, level, runner });
    default: {
      const custom = config.customRunners?.[runner];
      if (!custom) throw new Error(`Unknown runner "${runner}"`);
      const sub = (s) => s
        .replaceAll('{task}', task)
        .replaceAll('{systemPrompt}', systemPrompt)
        .replaceAll('{model}', modelId || '')
        .replaceAll('{effort}', level || '')
        .replaceAll('{readOnly}', String(!!readOnly));
      // A custom runner may stream agent JSON events (a wrapper around a real
      // CLI) or print plain text; it says which with `parse`. Without it,
      // JSON event lines are read as events and every other line as text.
      return { bin: custom.command, args: (custom.args || []).map(sub), parse: custom.parse === 'text' ? 'text' : 'stream-json', readOnlyEnforced: false };
    }
  }
}

/** Shape of stage-handoff.json; SKILL.md documents the matching protocol. */
export const HANDOFF_VERSION = 3;

// Hosts whose installed hooks write a tool event after every tool call
// (host-hooks.mjs) and inject queued operator notes. Antigravity's hook runs
// before an invocation, not after a tool, so it reports no tool events.
const HOOK_PROGRESS_HOSTS = new Set(['claude', 'codex', 'cursor']);

function writeHostHandoff({ stage, cycle, task, systemPromptFile, readOnly, paths, model, effort, modelSelection, hostClient = null, skills = null, handoffId = null, runId = null }) {
  const handoff = {
    version: HANDOFF_VERSION,
    ...(handoffId ? { handoffId, runId } : {}),
    stage,
    cycle: cycle || 1,
    task,
    promptFile: path.relative(paths.root, systemPromptFile),
    artifact: `.pipeline/${STAGE_ARTIFACT_FILES[stage]}`,
    readOnly: !!readOnly,
    mode: 'chat',
    actualModel: null,
    createdAt: new Date().toISOString(),
  };
  if (model) {
    handoff.model = model;
    handoff.modelSelection = modelSelection || 'auto';
    handoff.modelNote = modelNote(model, normalizeEffort(effort));
  }
  if (normalizeEffort(effort)) handoff.effort = normalizeEffort(effort);
  // A chat session cannot switch its own model mid-conversation, so every stage
  // used to run on the (usually frontier) chat model. Low-effort stages are
  // summarisation work: a host with model-scoped subagents can run them there.
  if (model && model !== CURRENT_CHAT_MODEL && normalizeEffort(effort) === 'low') {
    handoff.delegate = {
      model,
      note: `Low-effort ${stage} stage. If this host can run a subagent on a chosen model, do this stage in one on ${model} (it writes ${STAGE_ARTIFACT_FILES[stage]}), then record ${model} as actualModel. Otherwise do it here.`,
    };
  }
  if (skills?.active?.length) {
    // A chat host reads the same verified instructions a CLI runner would.
    handoff.skills = skills.active.map((a) => ({ name: a.skill.name, dir: a.dir, entry: a.skill.entry }));
    handoff.skillsPromptSection = skills.promptSection;
  }
  // The brief carries only what differs per stage. The fixed protocol (never
  // spawn another CLI, how to report progress, the bridge lease steps) lives in
  // skills/orchestrate/SKILL.md, versioned by HANDOFF_VERSION, instead of being
  // repeated in every brief.
  if (hostClient) handoff.hostClient = hostClient;
  // With hooks connected, a claimed run's progress and operator notes flow
  // through the hooks, so the per-tool host-event calls SKILL.md asks for
  // would only duplicate them (one process and one model turn each).
  // A host settings file the user broke must not break the handoff: then the
  // agent just reports progress by hand.
  let hooked = false;
  try { hooked = HOOK_PROGRESS_HOSTS.has(hostClient) && hookStatus(paths.root, hostClient) === 'connected'; } catch { /* unreadable settings */ }
  if (hooked) handoff.hookProgress = true;
  handoff.bridge = { version: 2, project: paths.root, runId: paths.runId, command: 'node pipeline/bridge-cli.mjs <command> --input-file <json-file>' };
  handoff.eventCommand = hostEventCommand({ runId: paths.runId, stage });
  fs.writeFileSync(paths.stageHandoff, JSON.stringify(handoff, null, 2));
  appendEvent(paths, { stage, cycle, type: 'chat_handoff', artifact: handoff.artifact, ...(hostClient ? { hostClient } : {}) });
}

export function runAgent({ runner, stage, cycle = 0, attempt = 1, appendLog = false, handoffId = null, runIdForHandoff = null, resumeSession = null, task, systemPromptFile, cwd, readOnly = false, paths, config, model, effort, modelSelection, hostClient = null, artifactOverride = null, skills = null }) {
  if (runner === 'host') {
    fs.mkdirSync(paths.logs, { recursive: true });
    const logFile = path.join(paths.logs, `${stage}.log`);
    const modelLabel = model ? ` · suggested model ${model} (actual model determined by chat)` : '';
    const hostLabel = hostClient ? ` (IDE chat: ${hostClient})` : ' (IDE chat)';
    fs.appendFileSync(logFile, `\n===== ${stage.toUpperCase()} (cycle ${cycle || 1}) — host${hostLabel}${modelLabel} — ${new Date().toISOString()} =====\n`);
    appendEvent(paths, { stage, cycle, type: 'agent_start', runner: 'host', model: model || undefined, effort: normalizeEffort(effort) || undefined, hostClient: hostClient || undefined });
    writeHostHandoff({ stage, cycle, task, systemPromptFile, readOnly, paths, model, effort, modelSelection, hostClient, skills, handoffId, runId: runIdForHandoff });
    appendEvent(paths, { stage, cycle, type: 'agent_parked', ok: true, hostHandoff: true });
    return Promise.resolve({ ok: false, hostHandoff: true });
  }

  const systemPrompt = fs.readFileSync(systemPromptFile, 'utf8');
  const { bin, args, parse, readOnlyEnforced } = buildInvocation({ runner, stage, systemPrompt, task, readOnly, config, model, effort, artifactOverride, skills, resumeSession });

  fs.mkdirSync(paths.logs, { recursive: true });
  const logFile = path.join(paths.logs, `${stage}.log`);
  // A retry (attempt > 1) appends, so the failed attempt's output survives for diagnosis.
  const log = fs.createWriteStream(logFile, { flags: cycle > 1 || attempt > 1 || appendLog ? 'a' : 'w' });
  const level = normalizeEffort(effort);
  const modelLabel = model ? ` · model ${model}${level ? ` · effort ${level}` : ''}` : '';
  log.write(`\n===== ${stage.toUpperCase()} (cycle ${cycle || 1}) — ${runner}${modelLabel} — ${new Date().toISOString()} =====\n`);
  if (readOnly && !readOnlyEnforced) {
    const warn = `[warn] runner "${runner}" cannot hard-enforce read-only; auto-approve flags withheld (best-effort). Use claude or codex for a guaranteed read-only audit.`;
    log.write(warn + '\n');
    appendEvent(paths, { stage, cycle, type: 'readonly_best_effort', runner });
  }
  appendEvent(paths, { stage, cycle, type: 'agent_start', runner, model: model || undefined, effort: level || undefined });

  if (stopping) return new Promise(() => {});
  return new Promise((resolve) => {
    // Own process group, so a stop/timeout reaches everything the agent
    // started (test runners, dev servers), not just the CLI itself. No forge
    // tokens: stages never push or merge; the supervisor does.
    const child = spawn(bin, args, { cwd, env: agentEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    liveAgents.add(child);
    const stderrLines = [];
    const outputLines = [];

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      appendEvent(paths, { stage, cycle, type: 'agent_timeout', timeoutMs: config.agentTimeoutMs });
      // Ask first so the agent's own children (test runners, servers) can shut down.
      killAgentTree(child, 'SIGTERM');
      killAt = Date.now() + KILL_GRACE_MS;
      killTimer = setTimeout(() => killAgentTree(child, 'SIGKILL'), KILL_GRACE_MS);
    }, config.agentTimeoutMs);
    let killTimer = null;
    let killAt = 0;
    // No output at all for agentIdleTimeoutMs means a hung CLI, not a slow one:
    // its own tool calls time out well before that. Stop it then instead of
    // waiting out the whole wall-clock budget.
    let lastOutputAt = Date.now();
    let idledOut = false;
    const idleMs = Number(config.agentIdleTimeoutMs) || 0;
    const idleTimer = idleMs > 0 ? setInterval(() => {
      if (timedOut || Date.now() - lastOutputAt < idleMs) return;
      timedOut = true;
      idledOut = true;
      appendEvent(paths, { stage, cycle, type: 'agent_timeout', idle: true, idleTimeoutMs: idleMs });
      killAgentTree(child, 'SIGTERM');
      killAt = Date.now() + KILL_GRACE_MS;
      killTimer = setTimeout(() => killAgentTree(child, 'SIGKILL'), KILL_GRACE_MS);
    }, Math.min(15_000, idleMs)) : null;

    let buffer = '';
    const parser = createStreamParser({ format: parse });
    // What the CLI itself reports, as opposed to what was requested: the session
    // to resume next cycle, the model that actually ran (a --fallback-model
    // switch shows here), and whether its final result was an error.
    const observed = { sessionId: null, model: null, resultError: false };
    // A text runner prints no such events: a JSON line it prints is output.
    const observe = (line) => {
      if (parse === 'text' || !line.startsWith('{') || !/"type":\s*"(system|result|thread\.started)"/.test(line)) return;
      try {
        const ev = JSON.parse(line);
        if (ev.session_id) observed.sessionId = ev.session_id;
        if (ev.type === 'thread.started' && ev.thread_id) observed.sessionId = ev.thread_id; // codex
        if (ev.type === 'system' && ev.subtype === 'init' && ev.model) observed.model = ev.model;
        if (ev.type === 'result' && ev.is_error === true) observed.resultError = true;
      } catch { /* not a complete event */ }
    };
    const emit = (b) => {
      appendEvent(paths, { stage, cycle, type: 'agent_output', ...b });
    };
    const handleChunk = (chunk, isErr) => {
      lastOutputAt = Date.now();
      buffer += chunk.toString();
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        log.write(`${line}\n`);
        const keep = isErr ? stderrLines : outputLines;
        if (line.trim()) { keep.push(line); if (keep.length > (isErr ? 40 : 5)) keep.shift(); }
        if (isErr) {
          if (line.trim()) emit({ kind: 'err', text: line });
          continue;
        }
        observe(line.trim());
        parser.pushLine(line).forEach(emit);
      }
    };
    child.stdout.on('data', (c) => handleChunk(c, false));
    child.stderr.on('data', (c) => handleChunk(c, true));

    child.on('error', (err) => {
      clearTimeout(timer);
      clearInterval(idleTimer);
      liveAgents.delete(child);
      log.write(`[error] failed to spawn ${bin}: ${err.message}\n`);
      appendEvent(paths, { stage, cycle, type: 'agent_end', ok: false, error: err.message });
      log.end(() => resolve({ ok: false, exitCode: -1, error: err.message }));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      clearInterval(idleTimer);
      // The CLI exited, but after a timeout something in its group may still be
      // ignoring SIGTERM. Let the pending SIGKILL land before reporting the
      // stage over, so a rerun cannot overlap an old worker.
      if (killTimer && groupAlive(child)) {
        clearTimeout(killTimer);
        const wait = Math.max(0, killAt - Date.now());
        setTimeout(() => { killAgentTree(child, 'SIGKILL'); untilGroupGone(child).then(() => finish(code)); }, wait);
        return;
      }
      clearTimeout(killTimer);
      finish(code);
    });
    const finish = (code) => {
      liveAgents.delete(child);
      if (stopping) { log.end(); return; }
      if (buffer.trim()) {
        log.write(buffer.endsWith('\n') ? buffer : `${buffer}\n`);
        observe(buffer.trim());
        parser.pushLine(buffer).forEach(emit);
      }
      parser.flush().forEach(emit);
      if (idledOut) log.write(`[error] agent produced no output for agentIdleTimeoutMs (${idleMs}ms) and was stopped\n`);
      else if (timedOut) log.write(`[error] agent exceeded agentTimeoutMs (${config.agentTimeoutMs}ms) and was killed\n`);
      // Exit 0 with an error result (e.g. max turns, a refused permission) did
      // not do the work; treating it as success sent an empty stage downstream.
      // A stopped agent did not finish, whatever its SIGTERM handler exits with.
      const ok = code === 0 && !observed.resultError && !timedOut;
      if (code === 0 && observed.resultError) log.write('[error] agent exited 0 but reported an error result\n');
      appendEvent(paths, { stage, cycle, type: 'agent_end', ok, exitCode: code, timedOut: timedOut || undefined, resultError: observed.resultError || undefined, model: observed.model || undefined });
      // Resolve once the log is on disk: on a failure the engine reads its tail
      // straight away to classify it.
      log.end(() => resolve({ ok, exitCode: code, timedOut, stderrTail: stderrLines.join('\n'), outputTail: outputLines.join('\n'), sessionId: observed.sessionId, observedModel: observed.model, resultError: observed.resultError }));
    };
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
    // A one-shot classifies text; it never needs to write.
    args = ['exec', '--sandbox', 'read-only', prompt];
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
    const child = spawn(bin, args, { env: agentEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let stdout = '';
    let stderr = '';
    
    const timer = setTimeout(() => {
      killAgentTree(child, 'SIGKILL');
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
