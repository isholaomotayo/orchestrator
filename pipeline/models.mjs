// Per-stage model profiles: cost-aware defaults per runner + manual overrides.
import { STAGES } from './state.mjs';

export const DEFAULT_MODEL_PROFILES = {
  auto: {
    host: {
      planner: 'opus-4.8',
      coder: 'sonnet-5',
      tester: 'sonnet-5',
      reviewer: 'sonnet-5',
    },
    claude: {
      planner: 'opus-4.8',
      coder: 'sonnet-5',
      tester: 'sonnet-5',
      reviewer: 'sonnet-5',
    },
    cursor: {
      planner: 'opus-4.8',
      coder: 'sonnet-5',
      tester: 'sonnet-5',
      reviewer: 'sonnet-5',
    },
    codex: {
      planner: 'gpt-5',
      coder: 'gpt-5',
      tester: 'gpt-5',
      reviewer: 'gpt-5',
    },
    gemini: {
      planner: 'gemini-3.1-pro',
      coder: 'gemini-3.5-flash',
      tester: 'gemini-3.5-flash',
      reviewer: 'gemini-3.5-flash',
    },
  },
};

const RUNNER_KEYS = ['host', 'claude', 'cursor', 'codex', 'gemini'];

function normalizeRunner(runner) {
  if (!runner || runner === 'auto') return 'host';
  return runner;
}

function pickAutoStages(config, runner) {
  const key = normalizeRunner(runner);
  const profiles = config.modelProfiles?.auto || DEFAULT_MODEL_PROFILES.auto;
  const byRunner = profiles[key] || DEFAULT_MODEL_PROFILES.auto[key] || DEFAULT_MODEL_PROFILES.auto.host;
  return { ...byRunner };
}

function validateStageMap(stages, label = 'models') {
  if (!stages || typeof stages !== 'object') {
    throw new Error(`Invalid ${label}: expected an object with keys ${STAGES.join(', ')}.`);
  }
  const out = {};
  for (const name of STAGES) {
    const val = stages[name];
    if (typeof val !== 'string' || !val.trim()) {
      throw new Error(`Invalid ${label}: missing or empty model for stage "${name}".`);
    }
    out[name] = val.trim();
  }
  return out;
}

/**
 * Resolve the per-stage model profile for a pipeline run.
 * @param {{ config: object, runner: string, profile?: 'auto'|'manual', manualStages?: object }} opts
 * @returns {{ selection: 'auto'|'manual', runner: string, stages: Record<string, string> }}
 */
export function resolveModelProfile({ config, runner, profile = 'auto', manualStages = null }) {
  const normalizedRunner = normalizeRunner(runner);
  const selection = profile === 'manual' ? 'manual' : 'auto';

  if (selection === 'manual') {
    if (!manualStages) {
      throw new Error('Manual model profile requires --models with a JSON object mapping stages to model IDs.');
    }
    const stages = validateStageMap(manualStages, '--models');
    return { selection, runner: normalizedRunner, stages };
  }

  return {
    selection: 'auto',
    runner: normalizedRunner,
    stages: pickAutoStages(config, runner),
  };
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

export function modelNote(model) {
  return `Switch to ${model} (or use your active chat model) before completing this stage.`;
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
