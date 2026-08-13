// Artifact trust: is what a stage produced actually usable by the next stage?
//
// The original gate was `size > 0`, which a file containing "TODO" passes. Each
// stage's prompt mandates an exact document skeleton, so we can check the parts
// the pipeline itself consumes — the Reviewer's verdict line above all, since an
// unparsed verdict silently costs a full Coder+Tester+Reviewer fix pass.
import fs from 'node:fs';

export const VERDICTS = ['APPROVED', 'REQUEST_CHANGES', 'BLOCK'];

// Tolerant of the formatting drift models actually produce around a heading:
// "## Verdict: APPROVED", "## Verdict: [APPROVED]", "**Verdict:** BLOCK".
const VERDICT_RE = /(?:^|\n)\s*(?:#{1,4}\s*|\*\*)?Verdict:?\*{0,2}\s*:?\s*\[?\s*(APPROVED|REQUEST_CHANGES|BLOCK)\s*\]?/i;

/**
 * @returns {{ verdict: string|null, ok: boolean }} verdict is null when the
 * report has no parseable verdict — the caller must NOT treat that as a
 * rejection, it means the reviewer's output was malformed.
 */
export function parseVerdict(report) {
  const m = String(report || '').match(VERDICT_RE);
  if (!m) return { verdict: null, ok: false };
  return { verdict: m[1].toUpperCase(), ok: true };
}

// Minimum believable size. Artifacts with a mandated skeleton (a PRD, a design
// synthesis, an audit) cannot honestly be tiny. Free-form notes can: a one-line
// fix produces a genuinely short changes.md, and rejecting that halts a healthy
// run. The marker checks below carry the weight for the structured ones.
const MIN_BYTES_STRUCTURED = 200;
const MIN_BYTES_FREEFORM = 80;
const STRUCTURED = new Set(['specs', 'design', 'review_report']);

// Substrings each artifact must contain, drawn from the skeleton its prompt
// mandates. Matched case-insensitively so heading case drift is tolerated.
const REQUIRED_MARKERS = {
  specs: ['tracer-bullet', 'objective'],
  design: ['final contracts'],
  changes: [],
  test_suite: [],
  review_report: ['verdict'],
  handoff: [],
};

const ARTIFACT_KEYS = {
  planner: 'specs',
  designer: 'design',
  coder: 'changes',
  tester: 'test_suite',
  reviewer: 'review_report',
  handoff: 'handoff',
};

/**
 * @returns {{ ok: boolean, reason: string|null }}
 */
export function validateArtifact(stage, content) {
  const text = String(content || '');
  if (!text.trim()) return { ok: false, reason: 'artifact is empty' };
  const key = ARTIFACT_KEYS[stage];
  const min = STRUCTURED.has(key) ? MIN_BYTES_STRUCTURED : MIN_BYTES_FREEFORM;
  if (text.length < min) {
    return { ok: false, reason: `artifact is only ${text.length} bytes — too short to be a real ${stage} output` };
  }
  const missing = (REQUIRED_MARKERS[key] || []).filter((m) => !text.toLowerCase().includes(m));
  if (missing.length) {
    return { ok: false, reason: `artifact is missing required section(s): ${missing.join(', ')}` };
  }
  if (stage === 'reviewer' && !parseVerdict(text).ok) {
    return { ok: false, reason: `no parseable verdict — expected one of ${VERDICTS.join(' | ')} on a "## Verdict:" line` };
  }
  return { ok: true, reason: null };
}

export function validateArtifactFile(stage, file) {
  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return { ok: false, reason: 'artifact was not created' };
  }
  return validateArtifact(stage, content);
}

// changes.md is append-only across fix cycles and is re-read in full by the
// Coder on every cycle, by the Tester, and by the Reviewer. By cycle 5 the bulk
// of it is superseded history that crowds out the part that matters — the most
// recent failure and fix. Collapse older sections deterministically (no LLM, no
// judgement) so the tail stays complete and the head stays navigable.
const COMPACT_THRESHOLD_BYTES = 24000;
const KEEP_RECENT_SECTIONS = 2;
const SUMMARY_LINES = 6;

const SECTION_RE = /^##\s+(Fix Cycle|Post-Tester Fix Cycle|Review Fix Pass)\s/i;

export function compactChangelog(text, {
  threshold = COMPACT_THRESHOLD_BYTES,
  keepRecent = KEEP_RECENT_SECTIONS,
  summaryLines = SUMMARY_LINES,
} = {}) {
  if (!text || text.length <= threshold) return { text, compacted: false };

  const lines = text.split('\n');
  const starts = [];
  lines.forEach((l, i) => { if (SECTION_RE.test(l)) starts.push(i); });
  // Nothing cycle-shaped to fold, or too few sections for folding to pay off.
  if (starts.length <= keepRecent) return { text, compacted: false };

  const foldUntil = starts[starts.length - keepRecent];
  const head = lines.slice(0, starts[0]);
  const tail = lines.slice(foldUntil);

  const folded = [];
  for (let i = 0; i < starts.length - keepRecent; i++) {
    const from = starts[i];
    const to = starts[i + 1] ?? foldUntil;
    const body = lines.slice(from + 1, to).filter((l) => l.trim());
    folded.push(lines[from]);
    folded.push(...body.slice(0, summaryLines));
    const dropped = body.length - summaryLines;
    if (dropped > 0) folded.push(`_… ${dropped} more line${dropped === 1 ? '' : 's'} folded by the orchestrator; the full history is in .pipeline/runs/._`);
    folded.push('');
  }

  const notice = [
    '> **Note:** earlier fix cycles below were folded to their first few lines to',
    '> keep this document readable. The two most recent sections are complete.',
    '',
  ];
  return { text: [...head, ...notice, ...folded, ...tail].join('\n'), compacted: true };
}

/**
 * Total tests seen by the checker. A drop means tests were deleted, skipped, or
 * commented out — the failure mode every "do not weaken tests" prompt line is
 * trying to prevent and that none of them can actually detect.
 */
export function totalTests(check) {
  if (!check) return null;
  const passed = Number(check.passedCount);
  const failed = Number(check.failedCount);
  if (!Number.isFinite(passed) || !Number.isFinite(failed)) return null;
  return passed + failed;
}

/**
 * @returns {{ weakened: boolean, before: number|null, after: number|null }}
 */
export function detectTestWeakening(prev, current) {
  const before = totalTests(prev);
  const after = totalTests(current);
  if (before === null || after === null) return { weakened: false, before, after };
  // A binary fallback signal (1/0, no real counts) carries no information about
  // suite size — comparing it would fire on every red-to-green transition.
  if (before <= 1 && after <= 1) return { weakened: false, before, after };
  return { weakened: after < before, before, after };
}
