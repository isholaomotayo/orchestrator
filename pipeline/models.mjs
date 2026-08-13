// Per-stage model + reasoning-effort profiles.
//
// Two-layer design. The pipeline reasons in vendor-neutral MODEL FAMILIES
// ('opus-5', 'gpt-5.5'); each runner CLI is handed a runner-native identifier
// resolved from RUNNER_MODEL_IDS. Families are what appear in config, the
// dashboard, and status.json; the native id never leaks outside buildInvocation.
// Without this layer a profile value like 'opus-4.8' is passed verbatim to
// `claude --model`, which accepts only an alias (opus|sonnet|fable|haiku) or a
// full name (claude-opus-5) — and silently belongs to neither.
import { CORE_STAGES, OPTIONAL_STAGES } from './state.mjs';

// Sentinel model id meaning "use whatever model this chat session is running".
// Never assume a specific vendor's models exist in the hosting IDE.
export const CURRENT_CHAT_MODEL = 'current-chat';

// Canonical reasoning-effort ladder, matching `claude --effort <level>`.
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

// Canonical model catalog surfaced in manual selection (dashboard dropdowns +
// docs). Grouped by provider, ordered strongest -> cheapest. `id` is the family
// key used everywhere in the pipeline, NOT the string handed to a CLI.
export const MODEL_CATALOG = {
  anthropic: [
    { id: 'opus-5', label: 'Claude Opus 5', tier: 'frontier' },
    { id: 'fable-5', label: 'Claude Fable 5', tier: 'frontier' },
    { id: 'sonnet-5', label: 'Claude Sonnet 5', tier: 'balanced' },
    { id: 'haiku-4.5', label: 'Claude Haiku 4.5', tier: 'fast' },
  ],
  openai: [
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', tier: 'frontier' },
    { id: 'gpt-5.5', label: 'GPT-5.5', tier: 'balanced' },
    { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', tier: 'fast' },
  ],
  google: [
    { id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', tier: 'frontier' },
    { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', tier: 'balanced' },
    { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', tier: 'fast' },
  ],
  xai: [
    { id: 'grok-4.5', label: 'Grok 4.5', tier: 'balanced' },
  ],
  host: [
    // Sentinel: "use whatever model this chat session is running". Selected
    // automatically in host mode when the hosting IDE's ecosystem is unknown.
    { id: CURRENT_CHAT_MODEL, label: 'Current chat model', tier: 'host' },
  ],
};

export const MODEL_FAMILIES = Object.fromEntries(
  Object.entries(MODEL_CATALOG).flatMap(([provider, entries]) =>
    entries.map((e) => [e.id, { ...e, provider }])),
);

// Family -> runner-native model identifier.
//
// claude:  short aliases always track the newest model in a family, which is
//          what an "auto" profile wants; full names stay valid for pin-downs.
// cursor:  ids come from `cursor-agent --list-models`; effort is encoded IN the
//          model id there rather than as a separate flag (see CURSOR_EFFORT_IDS).
// codex:   identity pass-through — `codex exec --model` accepts provider names
//          directly and publishes no enumerable list to map against.
// gemini:  identity pass-through.
const RUNNER_MODEL_IDS = {
  claude: {
    'opus-5': 'opus',
    'fable-5': 'fable',
    'sonnet-5': 'sonnet',
    'haiku-4.5': 'haiku',
  },
  cursor: {
    'opus-5': 'claude-opus-5',
    'fable-5': 'claude-fable-5-thinking-high',
    'sonnet-5': 'claude-sonnet-5',
    'gpt-5.6-sol': 'gpt-5.6-sol-high',
    'gpt-5.5': 'gpt-5.5-high',
    'gpt-5.4-mini': 'gpt-5.4-mini-medium',
    'gemini-3.1-pro': 'gemini-3.1-pro',
    'gemini-3.6-flash': 'gemini-3.6-flash-high',
    'gemini-3.5-flash': 'gemini-3.5-flash',
    'grok-4.5': 'cursor-grok-4.5-high',
  },
};

// cursor-agent has no --effort flag: the effort tier is baked into the model id.
// Only families with published per-effort variants are listed; anything absent
// falls back to the family's base id in RUNNER_MODEL_IDS.
const CURSOR_EFFORT_IDS = {
  'opus-5': {
    low: 'claude-opus-5-low',
    medium: 'claude-opus-5-medium',
    high: 'claude-opus-5-thinking-high',
    xhigh: 'claude-opus-5-thinking-xhigh',
    max: 'claude-opus-5-thinking-xhigh',
  },
  'sonnet-5': {
    high: 'claude-sonnet-5-thinking-high',
    xhigh: 'claude-sonnet-5-thinking-xhigh',
    max: 'claude-sonnet-5-thinking-xhigh',
  },
  'gpt-5.4-mini': {
    low: 'gpt-5.4-mini-low',
    medium: 'gpt-5.4-mini-medium',
    high: 'gpt-5.4-mini-high',
    xhigh: 'gpt-5.4-mini-xhigh',
    max: 'gpt-5.4-mini-xhigh',
  },
  'grok-4.5': {
    low: 'cursor-grok-4.5-low',
    medium: 'cursor-grok-4.5-medium',
    high: 'cursor-grok-4.5-high',
    xhigh: 'cursor-grok-4.5-high',
    max: 'cursor-grok-4.5-high',
  },
};

/**
 * Translate a model family into the identifier a runner's CLI actually accepts.
 * Unknown values pass through verbatim so custom, enterprise, or newly released
 * ids keep working without a code change — `isKnownFamily` lets callers warn.
 * @returns {string|null} null for the current-chat sentinel (no flag to emit)
 */
export function resolveModelId(model, runner, effort = null) {
  if (!model || model === CURRENT_CHAT_MODEL) return null;
  if (runner === 'cursor' && effort && CURSOR_EFFORT_IDS[model]?.[effort]) {
    return CURSOR_EFFORT_IDS[model][effort];
  }
  return RUNNER_MODEL_IDS[runner]?.[model] || model;
}

// Degrade one tier down within the same provider when the primary model is
// unavailable (capacity, rollout, entitlement). A degraded stage beats a halted
// run; `claude --fallback-model` applies this automatically mid-invocation.
const FALLBACK_FAMILY = {
  'opus-5': 'sonnet-5',
  'fable-5': 'sonnet-5',
  'sonnet-5': 'haiku-4.5',
  'gpt-5.6-sol': 'gpt-5.5',
  'gpt-5.5': 'gpt-5.4-mini',
  'gemini-3.1-pro': 'gemini-3.6-flash',
  'gemini-3.6-flash': 'gemini-3.5-flash',
};

/** Runner-native id of the fallback for `model`, or null if there isn't one. */
export function fallbackModelId(model, runner) {
  const family = FALLBACK_FAMILY[model];
  return family ? resolveModelId(family, runner) : null;
}

export function isKnownFamily(model) {
  return model === CURRENT_CHAT_MODEL || Object.hasOwn(MODEL_FAMILIES, model);
}

export function normalizeEffort(effort) {
  if (typeof effort !== 'string') return null;
  const lower = effort.trim().toLowerCase();
  return EFFORT_LEVELS.includes(lower) ? lower : null;
}

// Effort is a bigger quality/cost lever than model tier for the stages that
// reason (planner, designer, reviewer) and near-worthless for the ones that
// transcribe (handoff). The ladder is runner-independent.
export const DEFAULT_STAGE_EFFORT = {
  planner: 'high',
  designer: 'high',
  coder: 'medium',
  tester: 'medium',
  reviewer: 'high',
  handoff: 'low',
};

// Cost-aware defaults. Frontier models on the stages whose output every later
// stage depends on (planner, designer) or that gate the run (reviewer); the
// balanced tier on the token-heavy implementation loop; the cheap tier on pure
// summarisation.
const ANTHROPIC_AUTO = {
  planner: 'opus-5',
  designer: 'opus-5',
  coder: 'sonnet-5',
  tester: 'sonnet-5',
  reviewer: 'opus-5',
  handoff: 'haiku-4.5',
};

const OPENAI_AUTO = {
  planner: 'gpt-5.6-sol',
  designer: 'gpt-5.6-sol',
  coder: 'gpt-5.5',
  tester: 'gpt-5.5',
  reviewer: 'gpt-5.6-sol',
  handoff: 'gpt-5.4-mini',
};

const GOOGLE_AUTO = {
  planner: 'gemini-3.1-pro',
  designer: 'gemini-3.1-pro',
  coder: 'gemini-3.6-flash',
  tester: 'gemini-3.6-flash',
  reviewer: 'gemini-3.1-pro',
  handoff: 'gemini-3.5-flash',
};

export const DEFAULT_MODEL_PROFILES = {
  auto: {
    host: { ...ANTHROPIC_AUTO },
    claude: { ...ANTHROPIC_AUTO },
    cursor: { ...ANTHROPIC_AUTO },
    codex: { ...OPENAI_AUTO },
    gemini: { ...GOOGLE_AUTO },
    antigravity: { ...GOOGLE_AUTO },
  },
};

const RUNNER_KEYS = ['host', 'claude', 'cursor', 'codex', 'gemini', 'antigravity'];

// Host mode: map the IDE chat client hosting the run to its model ecosystem,
// so we never suggest models that don't exist in that environment.
const HOST_CLIENT_PROFILE_KEYS = {
  claude: 'claude',
  'claude-code': 'claude',
  cursor: 'cursor',
  codex: 'codex',
  gemini: 'gemini',
  antigravity: 'antigravity',
};

function normalizeRunner(runner) {
  if (!runner || runner === 'auto') return 'host';
  return runner;
}

function stagesOfCurrentChat() {
  const stages = {};
  for (const name of [...CORE_STAGES, ...OPTIONAL_STAGES]) stages[name] = CURRENT_CHAT_MODEL;
  return stages;
}

function pickAutoStages(config, runner, { hostClient = null } = {}) {
  let key = normalizeRunner(runner);
  if (key === 'host') {
    const clientKey = HOST_CLIENT_PROFILE_KEYS[hostClient];
    // Unknown host environment ('vscode', null, …): use the active chat model
    // for every stage rather than assuming Claude models exist there.
    if (!clientKey) return stagesOfCurrentChat();
    key = clientKey;
  }
  const profiles = config.modelProfiles?.auto || DEFAULT_MODEL_PROFILES.auto;
  const byRunner = profiles[key] || DEFAULT_MODEL_PROFILES.auto[key] || DEFAULT_MODEL_PROFILES.auto.host;
  return { ...byRunner };
}

function validateStageMap(stages, label = 'models') {
  if (!stages || typeof stages !== 'object') {
    throw new Error(`Invalid ${label}: expected an object with keys ${CORE_STAGES.join(', ')} (optional: ${OPTIONAL_STAGES.join(', ')}).`);
  }
  const out = {};
  for (const name of CORE_STAGES) {
    const val = stages[name];
    if (typeof val !== 'string' || !val.trim()) {
      throw new Error(`Invalid ${label}: missing or empty model for stage "${name}".`);
    }
    out[name] = val.trim();
  }
  // Optional stages default to a sensible sibling when omitted: the designer is
  // architecture work (planner tier); the handoff doc is summarisation (reviewer tier).
  out.designer = typeof stages.designer === 'string' && stages.designer.trim() ? stages.designer.trim() : out.planner;
  out.handoff = typeof stages.handoff === 'string' && stages.handoff.trim() ? stages.handoff.trim() : out.reviewer;
  return out;
}

// Unknown ids stay usable (custom/enterprise/newly-released), but say so once at
// resolution time rather than failing opaquely inside an agent CLI 20 minutes in.
export function unknownFamilies(stages) {
  return [...new Set(Object.values(stages).filter((m) => !isKnownFamily(m)))];
}

function resolveEffort(config, stages) {
  const overrides = config?.stageEffort || {};
  const out = {};
  for (const name of Object.keys(stages)) {
    out[name] = normalizeEffort(overrides[name]) || DEFAULT_STAGE_EFFORT[name] || 'medium';
  }
  return out;
}

/**
 * Resolve the per-stage model profile for a pipeline run.
 * @param {{ config: object, runner: string, profile?: 'auto'|'manual', manualStages?: object, hostClient?: string|null }} opts
 * @returns {{ selection: 'auto'|'manual', runner: string, stages: Record<string,string>, effort: Record<string,string> }}
 */
export function resolveModelProfile({ config, runner, profile = 'auto', manualStages = null, hostClient = null }) {
  const normalizedRunner = normalizeRunner(runner);
  const selection = profile === 'manual' ? 'manual' : 'auto';

  const stages = selection === 'manual'
    ? validateStageMap(requireManual(manualStages), '--models')
    : pickAutoStages(config, runner, { hostClient });

  return { selection, runner: normalizedRunner, stages, effort: resolveEffort(config, stages) };
}

function requireManual(manualStages) {
  if (!manualStages) {
    throw new Error('Manual model profile requires --models with a JSON object mapping stages to model IDs.');
  }
  return manualStages;
}

export function parseModelsJson(raw) {
  if (!raw) return null;
  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    throw new Error('Invalid --models JSON. Expected: {"planner":"...","coder":"...","tester":"...","reviewer":"..."}');
  }
  return validateStageMap(parsed, '--models');
}

export function modelForStage(models, stage) {
  return models?.stages?.[stage] || null;
}

export function effortForStage(models, stage) {
  return models?.effort?.[stage] || DEFAULT_STAGE_EFFORT[stage] || null;
}

export function modelNote(model, effort = null) {
  const effortNote = effort ? ` Target reasoning effort: ${effort}.` : '';
  if (model === CURRENT_CHAT_MODEL) {
    return `Use your active chat model for this stage.${effortNote}`;
  }
  return `Switch to ${model} if available in this environment; otherwise use your active chat model and record it as actualModel.${effortNote}`;
}

export function mergeModelProfiles(config) {
  const merged = { auto: { ...DEFAULT_MODEL_PROFILES.auto } };
  const fromConfig = config.modelProfiles?.auto;
  if (fromConfig) {
    for (const runner of RUNNER_KEYS) {
      if (fromConfig[runner]) {
        merged.auto[runner] = { ...merged.auto[runner], ...fromConfig[runner] };
      }
    }
  }
  return merged;
}
