// Multi-lens review panel.
//
// One reviewer asked to audit architecture AND security AND spec-conformance in
// a single pass spreads its attention across all three and reliably under-reports
// on at least one. Three focused reviewers, run concurrently, each see more in
// their own dimension — and because they are read-only they can safely run at
// the same time.
//
// Aggregation is STRICTEST-WINS, not majority. A security lens finding a real
// injection must not be outvoted by two lenses that were not looking for one;
// with a majority rule the most valuable finding is the easiest to lose.
import { parseVerdict, VERDICTS } from './artifacts.mjs';

export const LENSES = [
  {
    key: 'correctness',
    label: 'Spec & Correctness',
    artifact: 'review_correctness.md',
    focus: `Audit ONLY correctness against the specification. Compare the diff to the
specs.md tracer-bullet tickets (and design.md Final Contracts if present),
ticket by ticket. Report: missing implementations, logic and edge-case bugs
(conditionals, boundary handling, data mutation, error paths), and scope creep —
code implementing things the spec never asked for. Ignore style and security;
other reviewers own those.`,
  },
  {
    key: 'security',
    label: 'Security & Data Handling',
    artifact: 'review_security.md',
    focus: `Audit ONLY security and data handling. Look for injection (SQL, command,
template, path traversal), XSS and output encoding, CSRF, authentication and
authorization gaps, insecure direct object references, credential and token
leakage into logs or errors, unsafe deserialization, weak randomness for
security purposes, TOCTOU races, resource exhaustion, and any newly introduced
network or filesystem reach. Ignore style and spec conformance.`,
  },
  {
    key: 'architecture',
    label: 'Architecture & Maintainability',
    artifact: 'review_architecture.md',
    focus: `Audit ONLY structural quality against this codebase's established patterns.
Separate hard violations from subjective smells. Cover: Mysterious Name,
Duplicated Code, Feature Envy, Data Clumps, Primitive Obsession, Repeated
Switches, Shotgun Surgery, Divergent Change, Speculative Generality, Message
Chains, Middle Man, Refused Bequest — plus algorithmic complexity, blocking
synchronous work, and leak-prone resource handling. Ignore security and spec
conformance.`,
  },
];

// Ordered least-to-most severe; the aggregate takes the maximum.
const SEVERITY = { APPROVED: 0, REQUEST_CHANGES: 1, BLOCK: 2 };

/**
 * Merge per-lens reports into the single review_report.md the orchestrator
 * parses, preserving each lens's findings verbatim.
 *
 * @param {Array<{ lens: object, content: string, ok: boolean }>} reports
 * @returns {{ verdict: string|null, report: string, lensVerdicts: object, unusable: string[] }}
 */
export function aggregatePanel(reports, { task = '' } = {}) {
  const lensVerdicts = {};
  const unusable = [];
  let worst = null;

  for (const r of reports) {
    const parsed = r.ok ? parseVerdict(r.content) : { verdict: null, ok: false };
    lensVerdicts[r.lens.key] = parsed.verdict;
    if (!parsed.ok) { unusable.push(r.lens.key); continue; }
    if (worst === null || SEVERITY[parsed.verdict] > SEVERITY[worst]) worst = parsed.verdict;
  }

  // A lens that failed or produced an unparseable report is NOT a silent
  // approval — the panel's verdict is unknown and the caller must halt.
  const verdict = unusable.length ? null : worst;

  const lines = [
    '# ARCHITECTURE & SECURITY AUDIT REVIEW',
    '',
    `## Verdict: ${verdict ?? 'UNKNOWN'}`,
    '',
    '> Aggregated from an independent review panel. The verdict is the STRICTEST',
    '> of the lens verdicts, so a finding from any single lens cannot be outvoted.',
    '',
    '## Panel',
    '',
    '| Lens | Verdict |',
    '|---|---|',
    ...LENSES.map((l) => `| ${l.label} | ${lensVerdicts[l.key] ?? '_unusable report_'} |`),
    '',
  ];

  if (unusable.length) {
    lines.push(`> **Incomplete panel:** ${unusable.join(', ')} produced no usable report.`, '');
  }

  reports.forEach((r, i) => {
    lines.push(`## ${i + 1}. ${r.lens.label} Axis`, '');
    lines.push(r.ok && r.content.trim() ? stripDuplicateHeadings(r.content).trim() : '_This lens produced no usable report._');
    lines.push('');
  });

  // The orchestrator feeds this section verbatim to the fix pass, so every
  // lens's action items must survive the merge.
  lines.push('## Final Recommendations / Action Items', '');
  const items = reports.flatMap((r) => (r.ok ? extractActionItems(r.content).map((t) => `- **[${r.lens.label}]** ${t}`) : []));
  lines.push(items.length ? items.join('\n') : '- No action items reported by any lens.');
  lines.push('');
  if (task) lines.push(`_Task: ${task}_`, '');

  return { verdict, report: lines.join('\n'), lensVerdicts, unusable };
}

// A lens report carries its own "## Verdict:" line; leaving them in the merged
// document would give the orchestrator's parser several verdicts to choose from.
function stripDuplicateHeadings(content) {
  return content
    .split('\n')
    .filter((l) => !/^\s*(#{1,4}\s*)?Verdict:?/i.test(l))
    .filter((l) => !/^#\s+ARCHITECTURE & SECURITY AUDIT REVIEW/i.test(l))
    .join('\n');
}

// The reviewer prompt mandates "## 4. Final Recommendations / Action Items", so
// the numeric section prefix must be optional — without it this matched nothing
// and every lens's action items were dropped from the merged report.
const ACTION_HEADING_RE = /^#{1,4}\s*(?:\d+\.\s*)?(Final Recommendations|Action Items)/i;

function extractActionItems(content) {
  const lines = content.split('\n');
  const start = lines.findIndex((l) => ACTION_HEADING_RE.test(l));
  if (start < 0) return [];
  const items = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,4}\s/.test(lines[i])) break;
    const t = lines[i].trim();
    if (!t) continue;
    items.push(t.replace(/^([-*]|\d+\.)\s*/, ''));
  }
  return items.filter((t) => t && !/^no action items/i.test(t));
}

export const PANEL_VERDICTS = VERDICTS;
