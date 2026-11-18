// The two orthogonal "mode" axes of a run, read through one module.
//
//   surface  — who executes stages: 'host' (a chat session completes each
//              stage from stage-handoff.json) or 'cli' (the engine spawns an
//              agent CLI). Decided once when the run is created; changed only
//              by an explicit --mode on continue/resume, and then audited.
//   autonomy — who decides at gates: 'guided' (a human approves the plan and
//              merges, and halts wait for a person) or 'autonomous' (the
//              pipeline recovers within its budgets and only notifies).
//              Editable mid-run; it applies at the next gate.
import fs from 'node:fs';
import path from 'node:path';
import { resolveExecutionSurface } from './adapters.mjs';
import { atomicWrite } from './state.mjs';

export const SURFACES = ['host', 'cli'];
export const AUTONOMY = ['guided', 'autonomous'];

export function surfaceOf(status) {
  if (SURFACES.includes(status?.surface)) return status.surface;
  return resolveExecutionSurface(status || {}) === 'host-handoff' ? 'host' : 'cli';
}

export function isHost(status) { return surfaceOf(status) === 'host'; }

// The mid-run autonomy toggle lives in its own operator-owned file, so the
// dashboard/CLI never races the engine on status.json.
export function policyFile(dir) { return path.join(dir, 'policy.json'); }

export function readPolicyOverride(dir) {
  try { return JSON.parse(fs.readFileSync(policyFile(dir), 'utf8')); } catch { return null; }
}

export function writePolicyOverride(dir, { autonomy, by = 'operator', via = 'cli' }) {
  if (!AUTONOMY.includes(autonomy)) throw new Error(`autonomy must be one of: ${AUTONOMY.join(', ')}`);
  const record = { autonomy, by, via, at: new Date().toISOString() };
  atomicWrite(policyFile(dir), JSON.stringify(record, null, 2));
  return record;
}

/**
 * The run's effective autonomy: a mid-run override, else what the run was
 * created with, else the project default, else 'guided'.
 */
export function policyOf(status, config = {}, override = null) {
  const pick = [override?.autonomy, status?.policy?.autonomy, config?.autonomy].find((a) => AUTONOMY.includes(a));
  const autonomy = pick || 'guided';
  return {
    autonomy,
    source: override?.autonomy === autonomy ? 'override' : status?.policy?.autonomy === autonomy ? 'run' : config?.autonomy === autonomy ? 'project' : 'default',
    // What the policy means at each gate, so every UI shows it the same way.
    // Merging is irreversible and always needs a human, whatever the policy.
    effective: {
      planApproval: status?.flags?.approvePlan ? 'human' : 'agent',
      mergeApproval: 'human',
      recoverableFailures: autonomy === 'autonomous' ? 'retry-once' : 'ask',
    },
  };
}
