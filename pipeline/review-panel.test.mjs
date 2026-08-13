import test from 'node:test';
import assert from 'node:assert/strict';
import { LENSES, aggregatePanel } from './review-panel.mjs';
import { parseVerdict, validateArtifact } from './artifacts.mjs';

function report(verdict, { items = [], body = 'findings body text' } = {}) {
  return `# ARCHITECTURE & SECURITY AUDIT REVIEW

## Verdict: ${verdict}

## 1. Findings
${body}

## 4. Final Recommendations / Action Items
${items.length ? items.map((t, i) => `${i + 1}. ${t}`).join('\n') : '- No action items reported by any lens.'}
`;
}

const lensOf = (key) => LENSES.find((l) => l.key === key);
const panel = (verdicts, opts = {}) => LENSES.map((l) => ({
  lens: l,
  content: report(verdicts[l.key], opts[l.key] || {}),
  ok: verdicts[l.key] !== undefined,
}));

test('the panel defines three distinct, non-overlapping lenses', () => {
  assert.equal(LENSES.length, 3);
  assert.deepEqual(LENSES.map((l) => l.key), ['correctness', 'security', 'architecture']);
  assert.equal(new Set(LENSES.map((l) => l.artifact)).size, 3);
});

test('unanimous approval approves', () => {
  const { verdict } = aggregatePanel(panel({ correctness: 'APPROVED', security: 'APPROVED', architecture: 'APPROVED' }));
  assert.equal(verdict, 'APPROVED');
});

test('a lone security finding cannot be outvoted', () => {
  // The whole reason the rule is strictest-wins rather than majority: under a
  // majority vote this run would ship with the security finding discarded.
  const { verdict } = aggregatePanel(panel({ correctness: 'APPROVED', security: 'BLOCK', architecture: 'APPROVED' }));
  assert.equal(verdict, 'BLOCK');
});

test('BLOCK outranks REQUEST_CHANGES', () => {
  const { verdict } = aggregatePanel(panel({ correctness: 'REQUEST_CHANGES', security: 'BLOCK', architecture: 'APPROVED' }));
  assert.equal(verdict, 'BLOCK');
});

test('a single REQUEST_CHANGES blocks approval', () => {
  const { verdict } = aggregatePanel(panel({ correctness: 'APPROVED', security: 'APPROVED', architecture: 'REQUEST_CHANGES' }));
  assert.equal(verdict, 'REQUEST_CHANGES');
});

test('an unusable lens report yields no verdict rather than an approval', () => {
  const reports = panel({ correctness: 'APPROVED', security: 'APPROVED', architecture: 'APPROVED' });
  reports[1] = { lens: lensOf('security'), content: '', ok: false };
  const { verdict, unusable } = aggregatePanel(reports);
  assert.equal(verdict, null, 'a failed lens must not be treated as approval');
  assert.deepEqual(unusable, ['security']);
});

test('a lens whose report has no parseable verdict counts as unusable', () => {
  const reports = panel({ correctness: 'APPROVED', security: 'APPROVED', architecture: 'APPROVED' });
  reports[0] = { lens: lensOf('correctness'), content: 'I had a look and it seems fine', ok: true };
  const { verdict, unusable } = aggregatePanel(reports);
  assert.equal(verdict, null);
  assert.deepEqual(unusable, ['correctness']);
});

test('the merged report is parseable by the orchestrator and has exactly one verdict', () => {
  const { report: merged } = aggregatePanel(panel({ correctness: 'APPROVED', security: 'REQUEST_CHANGES', architecture: 'APPROVED' }));
  assert.equal(parseVerdict(merged).verdict, 'REQUEST_CHANGES');
  // Per-lens verdict headings must be stripped, or the parser has several to pick from.
  const headings = merged.split('\n').filter((l) => /^\s*#{1,4}\s*Verdict:/i.test(l));
  assert.equal(headings.length, 1, `expected one verdict heading, found ${headings.length}`);
  assert.equal(validateArtifact('reviewer', merged).ok, true);
});

test('action items from every lens survive the merge, attributed to their lens', () => {
  const { report: merged } = aggregatePanel(panel(
    { correctness: 'REQUEST_CHANGES', security: 'REQUEST_CHANGES', architecture: 'APPROVED' },
    {
      correctness: { items: ['`src/a.js` — off-by-one in loop bound'] },
      security: { items: ['`src/b.js` — unescaped user input in query'] },
    },
  ));
  // The orchestrator feeds this section verbatim to the fix pass; dropping a
  // lens's items would silently discard findings the run just paid for.
  assert.match(merged, /off-by-one in loop bound/);
  assert.match(merged, /unescaped user input in query/);
  assert.match(merged, /\[Spec & Correctness\]/);
  assert.match(merged, /\[Security & Data Handling\]/);
});

test('the panel table records each lens verdict', () => {
  const { report: merged, lensVerdicts } = aggregatePanel(panel({ correctness: 'APPROVED', security: 'BLOCK', architecture: 'REQUEST_CHANGES' }));
  assert.deepEqual(lensVerdicts, { correctness: 'APPROVED', security: 'BLOCK', architecture: 'REQUEST_CHANGES' });
  assert.match(merged, /\| Security & Data Handling \| BLOCK \|/);
});
