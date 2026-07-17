// Self-targeting guard: refuse to run the pipeline against the orchestrator
// SOURCE repository itself (a run once "improved" the orchestrator instead of
// the consumer project). Consumers installed via bootstrap.sh never receive the
// root skills/ directory (they get .agents/skills/ and .gemini/skills/ copies),
// so `skills/orchestrate/SKILL.md` + `pipeline/orchestrator.mjs` together
// identify the source repo and only the source repo.
import fs from 'node:fs';
import path from 'node:path';

export const SELF_MARKERS = ['skills/orchestrate/SKILL.md', 'pipeline/orchestrator.mjs'];

export function isOrchestratorSourceRepo(repoRoot) {
  return SELF_MARKERS.every((marker) => fs.existsSync(path.join(repoRoot, marker)));
}

export function selfTargetAllowed({ env = process.env, allowSelfFlag = false } = {}) {
  return allowSelfFlag || env.ORCH_ALLOW_SELF === '1';
}

export function selfGuardMessage(repoRoot) {
  return [
    `[Orchestrator] Refusing to run: ${repoRoot} is the orchestrator SOURCE repository, not a consumer project`,
    `(detected markers: ${SELF_MARKERS.join(' + ')}).`,
    'Install the pipeline into your project (bash skills/orchestrate/scripts/bootstrap.sh from that repo) and run it there.',
    'Maintainers who really mean to target this repo can override with --allow-self or ORCH_ALLOW_SELF=1.',
  ].join('\n');
}
