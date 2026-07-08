import { detectRunner, runOneShot } from './adapters.mjs';

export const STAGE_KEYWORDS = {
  planner: ['spec', 'plan', 'requirement', 'scope', 'design'],
  coder: ['implement', 'fix', 'bug', 'refactor', 'error'],
  tester: ['test', 'coverage', 'edge case', 'assert'],
  reviewer: ['review', 'audit', 'security', 'verdict', 'approve'],
};

/**
 * Pure heuristic router based on keyword scoring.
 * @param {string} text
 * @returns {{ stage: string | null, ambiguous: boolean }}
 */
export function heuristicRoute(text) {
  if (typeof text !== 'string') {
    return { stage: null, ambiguous: true };
  }
  const lowerText = text.toLowerCase();
  const scores = {};
  for (const [stage, keywords] of Object.entries(STAGE_KEYWORDS)) {
    let score = 0;
    for (const kw of keywords) {
      let count = 0;
      let pos = lowerText.indexOf(kw);
      while (pos !== -1) {
        count++;
        pos = lowerText.indexOf(kw, pos + kw.length);
      }
      score += count;
    }
    scores[stage] = score;
  }

  let maxScore = 0;
  let bestStages = [];
  for (const [stage, score] of Object.entries(scores)) {
    if (score > maxScore) {
      maxScore = score;
      bestStages = [stage];
    } else if (score === maxScore && score > 0) {
      bestStages.push(stage);
    }
  }

  if (maxScore === 0 || bestStages.length > 1) {
    return { stage: null, ambiguous: true };
  }
  return { stage: bestStages[0], ambiguous: false };
}

/**
 * Pure state default stage routing.
 * @param {object} status
 * @returns {string}
 */
export function stateDefaultStage(status) {
  if (!status || !Array.isArray(status.stages)) {
    return 'coder';
  }
  const running = status.stages.find((s) => s.status === 'running');
  if (running) return running.name;

  const nonPassed = status.stages.find((s) => s.status !== 'passed');
  if (nonPassed) return nonPassed.name;

  return 'coder';
}

/**
 * Classifies the message with LLM.
 * @param {{ text: string, status: object, config: object, runner: string }} opts
 * @returns {Promise<string | null>}
 */
export async function classifyWithLlm({ text, status, config, runner }) {
  if (runner === 'host') return null;

  const prompt = `Classify this user message into one of these stages: planner, coder, tester, reviewer.
Respond with exactly one word: planner|coder|tester|reviewer.

User message:
"${text}"`;

  const model = status?.models?.stages?.planner || null;
  const response = await runOneShot({ runner, prompt, config, model });
  const match = response.toLowerCase().match(/\b(planner|coder|tester|reviewer)\b/);
  return match ? match[1] : null;
}

/**
 * Routes message based on heuristic, LLM fallback, or state default fallback.
 * @param {{ text: string, status: object, config: object }} opts
 * @returns {Promise<{ stage: string, via: string, reason: string }>}
 */
export async function routeMessage({ text, status, config }) {
  // 1. Keyword scoring heuristic
  const heur = heuristicRoute(text);
  if (heur.stage && !heur.ambiguous) {
    return {
      stage: heur.stage,
      via: 'heuristic',
      reason: `matched keywords for ${heur.stage}`,
    };
  }

  // 2. LLM fallback
  let runner = null;
  try {
    runner = detectRunner(config, { invocationMode: 'cli' });
  } catch (err) {
    // Runner detection/auth failure, skip LLM
  }

  if (runner && runner !== 'host') {
    try {
      const llmStage = await classifyWithLlm({ text, status, config, runner });
      if (llmStage) {
        return {
          stage: llmStage,
          via: 'llm',
          reason: `classified via LLM (${runner})`,
        };
      }
    } catch (err) {
      // LLM execution failed, fall through to default
    }
  }

  // 3. State default
  const dflt = stateDefaultStage(status);
  return {
    stage: dflt,
    via: 'default',
    reason: `state default fallback (${dflt})`,
  };
}
