// Deterministic handoff-document compiler. On any halt the orchestrator writes
// .pipeline/handoff.md from run state alone — no LLM call — so the next session
// (human or agent) can resume without archaeology, even when the halt cause is
// the agent CLI itself. compileHaltHandoff is pure so it can be unit-tested
// without running a pipeline.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const RESUME_HINTS = {
  MAX_CYCLES: 'Extend the same fix loop: `node pipeline/orchestrator.mjs --resume --extend <n>` (or the dashboard "Extend" button).',
  REGRESSION_BLOCKED: 'A change broke previously passing tests. Inspect the diff and `.pipeline/checker_report.md` BEFORE any resume — regression halts are intentionally not extendable.',
  MISSING_ARTIFACT: 'A stage\'s artifact is missing or lacks a required section (named in the halt detail above). Fix that file in place, then `node pipeline/orchestrator.mjs --resume` — it re-validates the artifact and continues from the same step; no fresh run needed.',
  AGENT_ERROR: 'The agent CLI failed. Check authentication and the stage log under `.pipeline/logs/`, then `node pipeline/orchestrator.mjs --resume`.',
  INTEGRITY_VIOLATION: 'A stage wrote pipeline control-plane files it does not own, or a read-only stage mutated the working tree. Its output is untrusted: review the listed files and `git status` BEFORE resuming, and prefer a runner that hard-enforces read-only (claude, codex) for audit stages.',
  INVALID_VERDICT: 'The reviewer produced a report with no parseable verdict line. Read `.pipeline/review_report.md`; if the audit is sound, add "## Verdict: APPROVED|REQUEST_CHANGES|BLOCK" and `node pipeline/orchestrator.mjs --resume`.',
  ENGINE_ERROR: 'The orchestrator itself hit an unexpected error (see the stage detail above). Report it, then `node pipeline/orchestrator.mjs --resume` to re-enter the failed step.',
  INTERRUPTED: 'The run was interrupted. Resume it: `node pipeline/orchestrator.mjs --resume`.',
};

export function collectGitInfo(cwd) {
  const git = (args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (git(['rev-parse', '--is-inside-work-tree']).status !== 0) return null;
  const branch = (git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout || '').trim() || null;
  const dirty = (git(['status', '--porcelain']).stdout || '').trim().length > 0;
  return { branch, dirty };
}

// Pool runs live under .pipeline/runs/<id>/ and are resumed through the
// supervisor, so the classic `.pipeline/...` paths and engine commands would
// send a reader (or agent) to another run's stale files.
function localize(text, { dir, runId }) {
  let out = text.replaceAll('`.pipeline/', `\`${dir}/`);
  if (runId) {
    out = out
      .replaceAll('`node pipeline/orchestrator.mjs --resume --extend <n>`', `\`bash .pipeline/orchestrate.sh pool extend ${runId} <n>\``)
      .replaceAll('`node pipeline/orchestrator.mjs --resume`', `\`bash .pipeline/orchestrate.sh pool resume-run ${runId}\``);
  }
  return out;
}

export function compileHaltHandoff({ status, history = null, git = null, dir = '.pipeline' }) {
  // Pool briefs already lead the task with "- **Goal:**".
  const goal = String(status.task || '').replace(/^\s*-?\s*\*\*Goal:\*\*\s*/, '') || '(unknown)';
  const reason = status.haltReason || 'UNKNOWN';
  const halted = Boolean(status.haltReason);
  const phase = status.haltedPhase || status.resumePoint?.step || '(unknown)';
  const failing = (status.stages || []).find((s) => s.status === 'failed' || s.status === 'blocked' || s.status === 'interrupted');
  const lines = [
    halted ? '# Pipeline Handoff (auto-generated on halt)' : '# Pipeline Handoff (auto-generated)',
    '',
    '> **CRITICAL RESUME DIRECTION:** Do not start planning from scratch. Read `.pipeline/status.json` for the machine state, skim the artifacts below, then follow the resume command at the end. This document was compiled deterministically (no agent call) — it is necessarily less detailed than an agent-authored handoff, so read the stage artifacts below in full rather than relying on this summary alone.',
    '',
    halted ? '## 1. Summary of Blocked State' : '## 1. Summary of Final State',
    `- **Goal:** ${goal}`,
    halted
      ? `- **Outcome:** halted — ${reason}${status.haltTransient ? ' (classified as transient — a bare `--resume` may simply succeed)' : ''}`
      : `- **Outcome:** completed — verdict ${status.verdict || 'UNKNOWN'} (handoff agent failed; deterministic summary written instead)`,
    `- **Phase at freeze:** ${phase}`,
    (status.runId || status.featureId || status.ticketId)
      ? `- **Identity:** ${[status.runId ? `run \`${status.runId}\`` : null, status.featureId ? `feature \`${status.featureId}\`` : null, status.ticketId ? `ticket \`${status.ticketId}\`` : null].filter(Boolean).join(', ')}`
      : null,
    status.reviewPass ? `- **Review fix passes so far:** ${status.reviewPass}` : null,
  ].filter((l) => l !== null);
  if (failing?.detail) lines.push(`- **Detail:** ${failing.detail}`);
  lines.push('', '## 2. Stage Status', '| Stage | Status | Cycle | Artifact | Detail |', '|---|---|---|---|---|');
  for (const s of status.stages || []) {
    lines.push(`| ${s.name} | ${s.status} | ${s.cycle || 0}${s.maxCycles > 1 ? `/${s.maxCycles}` : ''} | ${s.artifact || '—'} | ${s.detail || '—'} |`);
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
    ['`.pipeline/test_suite.md`', 'the coverage map and any known-uncovered cases (if the tester ran)'],
    ['`.pipeline/review_report.md`', 'last review verdict (if the reviewer ran)'],
    ['`.pipeline/diff.patch`', 'the actual code diff, if you need ground truth over any narrative'],
    ['`.pipeline/logs/`', 'raw per-stage agent logs'],
  ]) lines.push(`- ${p} — ${why}`);
  lines.push('', '## 5. Git State');
  if (git) {
    lines.push(`- Branch: ${git.branch || '(detached)'}`);
    lines.push(`- Base commit for this run: ${status.baseRef || '(none captured)'}`);
    lines.push(`- Working tree: ${git.dirty ? 'DIRTY (uncommitted changes present)' : 'clean'}`);
  } else {
    lines.push('- The run root is not a git repository (or git is unavailable).');
  }
  // A run rooted at a container folder of clones has its real git state one
  // level down, where the `git` block above cannot see it.
  if (status.repos?.length > 1) {
    lines.push(`- Repositories in diff scope (${status.repos.length}):`);
    for (const r of status.repos) {
      lines.push(`  - \`${r.label}\` — base commit ${r.baseRef ? r.baseRef.slice(0, 12) : '(none captured)'}`);
    }
  }
  lines.push('', '## 6. How to Resume');
  if (halted) {
    lines.push(`- ${RESUME_HINTS[reason] || 'Inspect `.pipeline/status.json` and the stage logs, then `node pipeline/orchestrator.mjs --resume`.'}`);
    lines.push(`- Chat mode: \`bash .pipeline/orchestrate.sh --continue${status.runId ? ` --run-id ${status.runId}` : ''}\` when a stage handoff is pending.`, '');
  } else {
    lines.push('- The run completed — no resume needed. Read `.pipeline/review_report.md` for the verdict and follow-ups, and `.pipeline/status.json` for final state.', '');
  }
  return localize(lines.join('\n'), { dir, runId: status.runId || null });
}

export function writeHaltHandoff({ paths, status, history = null, cwd = paths.root }) {
  try {
    const dir = paths.dir && paths.root ? path.relative(paths.root, paths.dir) || '.pipeline' : '.pipeline';
    fs.writeFileSync(paths.handoffDoc, compileHaltHandoff({ status, history, git: collectGitInfo(cwd), dir }));
    return true;
  } catch {
    return false; // best-effort; never mask the original halt
  }
}
