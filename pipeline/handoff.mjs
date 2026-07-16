// Deterministic handoff-document compiler. On any halt the orchestrator writes
// .pipeline/handoff.md from run state alone — no LLM call — so the next session
// (human or agent) can resume without archaeology, even when the halt cause is
// the agent CLI itself. compileHaltHandoff is pure so it can be unit-tested
// without running a pipeline.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const RESUME_HINTS = {
  MAX_CYCLES: 'Extend the same fix loop: `node pipeline/orchestrator.mjs --resume --extend <n>` (or the dashboard "Extend" button).',
  REGRESSION_BLOCKED: 'A change broke previously passing tests. Inspect the diff and `.pipeline/checker_report.md` BEFORE any resume — regression halts are intentionally not extendable.',
  MISSING_ARTIFACT: 'A stage exited without producing its artifact. Inspect that stage\'s log under `.pipeline/logs/`, then start a fresh run (or `node pipeline/orchestrator.mjs --resume` if the run is stale/interrupted).',
  AGENT_ERROR: 'The agent CLI failed. Check authentication and the stage log under `.pipeline/logs/`, then `node pipeline/orchestrator.mjs --resume`.',
  INTERRUPTED: 'The run was interrupted. Resume it: `node pipeline/orchestrator.mjs --resume`.',
};

export function collectGitInfo(cwd) {
  const git = (args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (git(['rev-parse', '--is-inside-work-tree']).status !== 0) return null;
  const branch = (git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout || '').trim() || null;
  const dirty = (git(['status', '--porcelain']).stdout || '').trim().length > 0;
  return { branch, dirty };
}

export function compileHaltHandoff({ status, history = null, git = null }) {
  const reason = status.haltReason || 'UNKNOWN';
  const halted = Boolean(status.haltReason);
  const phase = status.haltedPhase || status.resumePoint?.step || '(unknown)';
  const failing = (status.stages || []).find((s) => s.status === 'failed' || s.status === 'blocked' || s.status === 'interrupted');
  const lines = [
    '# Pipeline Handoff (auto-generated on halt)',
    '',
    '> **CRITICAL RESUME DIRECTION:** Do not start planning from scratch. Read `.pipeline/status.json` for the machine state, skim the artifacts below, then follow the resume command at the end.',
    '',
    '## 1. Summary of Blocked State',
    `- **Goal:** ${status.task || '(unknown)'}`,
    halted
      ? `- **Outcome:** halted — ${reason}`
      : `- **Outcome:** completed — verdict ${status.verdict || 'UNKNOWN'} (handoff agent failed; deterministic summary written instead)`,
    `- **Phase at freeze:** ${phase}`,
  ];
  if (failing?.detail) lines.push(`- **Detail:** ${failing.detail}`);
  lines.push('', '## 2. Stage Status', '| Stage | Status | Cycle | Artifact |', '|---|---|---|---|');
  for (const s of status.stages || []) {
    lines.push(`| ${s.name} | ${s.status} | ${s.cycle || 0}${s.maxCycles > 1 ? `/${s.maxCycles}` : ''} | ${s.artifact || '—'} |`);
  }
  lines.push('', '## 3. Verification Trend');
  const runs = [...(history?.coder || []), ...(history?.postTester || [])];
  if (runs.length) {
    const last = runs[runs.length - 1];
    lines.push(`- Last checker run: ${last.passedCount} passed / ${last.failedCount} failed (${last.isPassed ? 'GREEN' : 'RED'})`);
    lines.push(`- Trend (passed counts): ${runs.map((r) => r.passedCount).join(' → ')}`);
  } else {
    lines.push('- No checker runs recorded for this run.');
  }
  lines.push('', '## 4. Artifacts to Read (in order)');
  for (const [p, why] of [
    ['`.pipeline/checker_report.md`', 'latest verification failures'],
    ['`.pipeline/changes.md`', 'what the Coder implemented, fix cycle by fix cycle'],
    ['`.pipeline/specs.md`', 'the specification being implemented'],
    ['`.pipeline/design.md`', 'finalized design contracts (if the design stage ran)'],
    ['`.pipeline/review_report.md`', 'last review verdict (if the reviewer ran)'],
    ['`.pipeline/logs/`', 'raw per-stage agent logs'],
  ]) lines.push(`- ${p} — ${why}`);
  lines.push('', '## 5. Git State');
  if (git) {
    lines.push(`- Branch: ${git.branch || '(detached)'}`);
    lines.push(`- Base commit for this run: ${status.baseRef || '(none captured)'}`);
    lines.push(`- Working tree: ${git.dirty ? 'DIRTY (uncommitted changes present)' : 'clean'}`);
  } else {
    lines.push('- Not a git repository (or git unavailable).');
  }
  lines.push('', '## 6. How to Resume');
  if (halted) {
    lines.push(`- ${RESUME_HINTS[reason] || 'Inspect `.pipeline/status.json` and the stage logs, then `node pipeline/orchestrator.mjs --resume`.'}`);
    lines.push('- Chat mode: `bash .pipeline/orchestrate.sh --continue` when a stage handoff is pending.', '');
  } else {
    lines.push('- The run completed — no resume needed. Read `.pipeline/review_report.md` for the verdict and follow-ups, and `.pipeline/status.json` for final state.', '');
  }
  return lines.join('\n');
}

export function writeHaltHandoff({ paths, status, history = null, cwd = paths.root }) {
  try {
    fs.writeFileSync(paths.handoffDoc, compileHaltHandoff({ status, history, git: collectGitInfo(cwd) }));
    return true;
  } catch {
    return false; // best-effort; never mask the original halt
  }
}
