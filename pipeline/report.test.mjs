import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipelinePaths } from './state.mjs';
import {
  escapeHtml, renderMarkdownLite, diffStats, parseSpecItems,
  parseReviewCoverage, coverageTable, testTrend,
  compileWorkDoneReport, writeWorkDoneReport,
} from './report.mjs';

const SPECS = `## 2. Technical Specification (PRD)
- **Objective:** add invoices

### Edge Cases & Failure Modes
| # | Case | Trigger | Required behavior | Proven by |
|---|---|---|---|---|
| E1 | empty cart | no items | throws | rejects_empty |
| E2 | bad currency | XYZ | throws | rejects_currency |

## 3. Tracer-Bullet Tickets
### Ticket 1: Invoice model
- **Files:** src/invoice.js
`;

const REVIEW = `## Verdict: APPROVED

## 3. Spec Coverage Verification
| ID | Status | Evidence |
|---|---|---|
| E1 | covered | invoice.test.js:12 |
| E2 | partial | not asserted |

## 5. Summary
Good.
`;

const DIFF = `## repo \`app\`
diff --git a/src/invoice.js b/src/invoice.js
new file mode 100644
--- /dev/null
+++ b/src/invoice.js
+export const a = 1;
+export const b = 2;
diff --git a/src/old.js b/src/old.js
deleted file mode 100644
--- a/src/old.js
+++ /dev/null
-gone
diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
+added line
-removed line
`;

const NARRATIVE = `# Work Done — Invoices

## Summary
Invoices can now be created and exported. The API is unchanged.

## What Changed
- Added \`src/invoice.js\`

## Key Decisions & Deviations
Used integers for money.

## Rough Edges & Follow-ups
Currency validation is not asserted yet.
`;

// ---- escaping and markdown -------------------------------------------------

test('agent-authored text can never become markup', () => {
  const hostile = '## Summary\n<script>alert(1)</script> and <img src=x onerror=y>';
  const { html } = compileWorkDoneReport({ title: 'T', narrative: hostile, status: {} });
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.match(html, /&lt;script&gt;/);
});

test('a hostile title is escaped in both the tag and the heading', () => {
  const { html } = compileWorkDoneReport({ title: '</title><script>x</script>', narrative: '', status: {} });
  assert.ok(!html.includes('<script>x</script>'));
  assert.match(html, /&lt;\/title&gt;/);
});

test('the markdown subset renders headings, lists and code without raw html', () => {
  const html = renderMarkdownLite('# H\n\n- one\n- two\n\n`code` and **bold**\n\n<b>raw</b>');
  assert.match(html, /<h2>H<\/h2>/);
  assert.match(html, /<li>one<\/li>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /&lt;b&gt;raw&lt;\/b&gt;/);
});

test('a fenced block is rendered as escaped code', () => {
  const html = renderMarkdownLite('```\n<script>x</script>\n```');
  assert.match(html, /<pre><code>/);
  assert.match(html, /&lt;script&gt;/);
});

test('escapeHtml covers every dangerous character', () => {
  assert.equal(escapeHtml(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;');
});

// ---- diff parsing ----------------------------------------------------------

test('diff stats report per-file additions, deletions and status', () => {
  const files = diffStats(DIFF);
  assert.equal(files.length, 3);
  const invoice = files.find((f) => f.file === 'src/invoice.js');
  assert.equal(invoice.status, 'A');
  assert.equal(invoice.added, 2);
  assert.equal(files.find((f) => f.file === 'src/old.js').status, 'D');
  assert.equal(files.find((f) => f.file === 'README.md').status, 'M');
});

test('diff stats attribute files to the repository section they came from', () => {
  assert.equal(diffStats(DIFF)[0].repo, 'app');
});

test('a binary file is flagged rather than counted as lines', () => {
  const files = diffStats('diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n');
  assert.equal(files[0].binary, true);
  assert.equal(files[0].added, 0);
});

test('an empty diff yields no files rather than throwing', () => {
  assert.deepEqual(diffStats(''), []);
});

// ---- coverage --------------------------------------------------------------

test('specification failure modes and tickets are extracted', () => {
  const { failureModes, tickets } = parseSpecItems(SPECS);
  assert.deepEqual(failureModes.map((f) => f.id), ['E1', 'E2']);
  assert.equal(failureModes[0].name, 'empty cart');
  assert.deepEqual(tickets.map((t) => t.id), ['T1']);
});

test('the reviewer coverage table is parsed without its header row', () => {
  const rows = parseReviewCoverage(REVIEW);
  assert.deepEqual(rows.map((r) => r.id), ['E1', 'E2']);
  assert.equal(rows[0].evidence, 'invoice.test.js:12');
});

test('coverage joins what was specified with what was reviewed', () => {
  const rows = coverageTable(SPECS, REVIEW);
  assert.equal(rows.find((r) => r.id === 'E1').status, 'covered');
  assert.equal(rows.find((r) => r.id === 'E2').status, 'partial');
});

test('a failure mode the review never mentions is called out, not assumed covered', () => {
  const rows = coverageTable(SPECS, '## Verdict: APPROVED\n\n## Spec Coverage\n| ID | Status |\n|---|---|\n| E1 | covered |\n');
  assert.equal(rows.find((r) => r.id === 'E2').status, 'unmentioned');
});

test('the test trend reads every cycle in order', () => {
  const trend = testTrend({ coder: [{ passedCount: 1, failedCount: 2, isPassed: false }], postTester: [{ passedCount: 3, failedCount: 0, isPassed: true }] });
  assert.deepEqual(trend.map((t) => t.passed), [1, 3]);
});

// ---- compilation -----------------------------------------------------------

const payload = () => ({
  title: 'Work Done — Invoices',
  status: { verdict: 'APPROVED', branch: 'pipeline/feature/F1', endedAt: '2026-09-06T12:00:00.000Z' },
  runId: 'r1', feature: { id: 'F1', title: 'Invoices' },
  narrative: NARRATIVE, specs: SPECS, review: REVIEW, diff: DIFF,
  history: { coder: [{ passedCount: 2, failedCount: 1, isPassed: false }], postTester: [{ passedCount: 4, failedCount: 0, isPassed: true }] },
  decisions: [{ question: 'Money type?', decision: 'integers', by: 'operator' }],
  pr: { url: 'https://example.test/pr/1' },
  diagrams: [],
});

test('the report carries the narrative, the numbers and the verdict', () => {
  const { html } = compileWorkDoneReport(payload());
  assert.match(html, /Invoices can now be created/);
  assert.match(html, /APPROVED/);
  assert.match(html, /src\/invoice\.js/);
  assert.match(html, /Money type\?/);
  assert.match(html, /2 passed \/ 1 failed/);
  assert.match(html, /example\.test\/pr\/1/);
});

test('the numbers come from the diff, not from the narrative', () => {
  const lying = { ...payload(), narrative: NARRATIVE.replace('Added `src/invoice.js`', 'Rewrote the entire system across 400 files') };
  const { computed, html } = compileWorkDoneReport(lying);
  assert.equal(computed.files.length, 3, 'the file count is measured');
  assert.match(html, /3 file\(s\)/);
});

test('an uncovered failure mode is visible in the report', () => {
  const { html } = compileWorkDoneReport({ ...payload(), review: '## Verdict: APPROVED\n\n## Spec Coverage\n| ID | Status |\n|---|---|\n| E1 | covered |\n' });
  assert.match(html, /class="unmentioned"/);
});

test('a rendered diagram is embedded sandboxed and can never reach the page', () => {
  const { html } = compileWorkDoneReport({ ...payload(), diagrams: [{ id: 'map', type: 'architecture', ok: true, htmlRel: 'map.html', sha256: 'abc123def456' }] });
  assert.match(html, /<iframe src="diagrams\/map\.html" sandbox="allow-scripts"/);
  assert.ok(!html.includes('allow-same-origin'), 'a diagram must never gain page access');
  assert.match(html, /sha256 abc123def456/);
});

test('a failed diagram becomes an honest note rather than a broken frame', () => {
  const { html } = compileWorkDoneReport({ ...payload(), diagrams: [{ id: 'map', type: 'architecture', ok: false, error: 'failed validation' }] });
  assert.match(html, /was omitted: failed validation/);
  assert.ok(!html.includes('<iframe'));
});

test('a run with no narrative still produces a usable report', () => {
  const { html } = compileWorkDoneReport({ ...payload(), narrative: '' });
  assert.match(html, /No narrative was recorded/);
  assert.match(html, /src\/invoice\.js/, 'the measured facts are still there');
});

test('the markdown form is suitable as a pull request body', () => {
  const { md } = compileWorkDoneReport(payload());
  assert.match(md, /^# Work Done — Invoices/);
  assert.match(md, /Review verdict: \*\*APPROVED\*\*/);
  assert.match(md, /`src\/invoice\.js`/);
  assert.ok(!md.includes('<'), 'no html leaks into the pull request body');
});

test('the report is theme-aware and self-contained', () => {
  const { html } = compileWorkDoneReport(payload());
  assert.match(html, /prefers-color-scheme:dark/);
  assert.match(html, /\[data-theme="dark"\]/);
  assert.ok(!/<script(?![^>]*type="application)/.test(html), 'no scripts of our own');
  assert.ok(!/https?:\/\/(?!example\.test)/.test(html.replace(/<a href="[^"]*"/g, '')), 'nothing is fetched from the network');
});

test('writing a report leaves html, markdown and a machine index', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'report-'));
  const paths = pipelinePaths(root, { runId: 'r1' });
  const res = writeWorkDoneReport(paths, payload());
  assert.equal(res.ok, true);
  for (const f of ['work-done.html', 'work-done.md', 'report.json']) {
    assert.ok(fs.existsSync(path.join(paths.reports, f)), `${f} was written`);
  }
  const index = JSON.parse(fs.readFileSync(path.join(paths.reports, 'report.json'), 'utf8'));
  assert.equal(index.verdict, 'APPROVED');
  assert.ok(index.htmlSha256);
  fs.rmSync(root, { recursive: true, force: true });
});
