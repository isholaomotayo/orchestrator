import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVerdict, validateArtifact, detectTestWeakening, totalTests, compactChangelog } from './artifacts.mjs';

const SPEC = `# TECHNICAL SPECIFICATION: Thing
## 2. Technical Specification (PRD)
- **Objective:** ship the thing
### Edge Cases & Failure Modes
| # | Case | Trigger | Required behavior | Proven by |
| E1 | empty input | \`[]\` | returns 0 | sums_empty |
## 3. Tracer-Bullet Tickets
### Ticket 1: do it
`.padEnd(400, '\n- filler line');

test('parseVerdict reads the canonical heading', () => {
  assert.deepEqual(parseVerdict('## Verdict: APPROVED'), { verdict: 'APPROVED', ok: true });
  assert.deepEqual(parseVerdict('## Verdict: [BLOCK]'), { verdict: 'BLOCK', ok: true });
});

test('parseVerdict tolerates real-world formatting drift', () => {
  for (const line of [
    '# Verdict: REQUEST_CHANGES',
    '**Verdict:** REQUEST_CHANGES',
    '## verdict: request_changes',
    '## Verdict:  [ REQUEST_CHANGES ]',
  ]) {
    assert.equal(parseVerdict(`intro\n${line}\nbody`).verdict, 'REQUEST_CHANGES', line);
  }
});

test('parseVerdict reports failure rather than guessing', () => {
  assert.deepEqual(parseVerdict('the code looks fine to me'), { verdict: null, ok: false });
  assert.deepEqual(parseVerdict(''), { verdict: null, ok: false });
  assert.deepEqual(parseVerdict(null), { verdict: null, ok: false });
  // "APPROVED" in prose without a verdict line must not be harvested.
  assert.equal(parseVerdict('I would have APPROVED this last week').ok, false);
});

test('validateArtifact rejects the empty and near-empty writes size>0 accepted', () => {
  assert.equal(validateArtifact('coder', '').ok, false);
  assert.equal(validateArtifact('coder', 'TODO').ok, false);
  assert.match(validateArtifact('coder', 'TODO').reason, /too short/);
});

test('validateArtifact enforces the skeleton each prompt mandates', () => {
  assert.equal(validateArtifact('planner', SPEC).ok, true);
  const noTickets = SPEC.replace(/Tracer-Bullet/i, 'Some Other');
  assert.equal(validateArtifact('planner', noTickets).ok, false);
  assert.match(validateArtifact('planner', noTickets).reason, /tracer-bullet/);
});

test('validateArtifact requires a parseable verdict from the reviewer', () => {
  const body = `## 3. Spec Coverage Verification\n${'x'.repeat(400)}`;
  assert.equal(validateArtifact('reviewer', `# AUDIT\n## Verdict: APPROVED\n${body}`).ok, true);
  const noVerdict = validateArtifact('reviewer', `# AUDIT\n${body}`);
  assert.equal(noVerdict.ok, false);
  assert.match(noVerdict.reason, /verdict/i);
});

test('validateArtifact leaves the handoff artifact unconstrained beyond length', () => {
  assert.equal(validateArtifact('handoff', 'a real handoff document '.repeat(20)).ok, true);
});

// ---- Depth gates: the sections that make a shallow stage output unusable ----

test('a spec with no failure-mode table is rejected', () => {
  const shallow = SPEC.replace('### Edge Cases & Failure Modes', '### Edge Cases');
  assert.equal(validateArtifact('planner', shallow).ok, false);
  assert.match(validateArtifact('planner', shallow).reason, /failure modes/);
});

test('a changes.md with no self-review is rejected', () => {
  const body = 'a real changes document '.repeat(20);
  assert.equal(validateArtifact('coder', body).ok, false);
  assert.match(validateArtifact('coder', body).reason, /self-review/);
  assert.equal(validateArtifact('coder', `${body}\n## Self-Review\nE1 handled at src/x.js:12`).ok, true);
});

test('a test_suite.md must carry both a coverage map and an honest gap list', () => {
  const body = 'a real test summary document '.repeat(20);
  assert.equal(validateArtifact('tester', `${body}\n## Coverage Map\n| E1 | t | x:1 |`).ok, false);
  assert.match(validateArtifact('tester', `${body}\n## Coverage Map\n`).reason, /uncovered/);
  assert.equal(
    validateArtifact('tester', `${body}\n## Coverage Map\n| E1 | t | x:1 |\n## Uncovered / Deferred Coverage\nNone`).ok,
    true,
  );
});

test('a review with a verdict but no spec-coverage table is rejected', () => {
  const shallow = `# AUDIT\n## Verdict: APPROVED\n${'looks good to me. '.repeat(30)}`;
  assert.equal(validateArtifact('reviewer', shallow).ok, false);
  assert.match(validateArtifact('reviewer', shallow).reason, /spec coverage/);
});

test('required sections survive punctuation and spacing drift', () => {
  // A hard halt over "Self Review" vs "Self-Review" would be indefensible.
  const body = 'a real changes document '.repeat(20);
  for (const heading of ['## Self-Review', '## Self Review', '## SELF_REVIEW', '### Self — Review']) {
    assert.equal(validateArtifact('coder', `${body}\n${heading}\nE1 at src/x.js:9`).ok, true, heading);
  }
});

test('detectTestWeakening fires when the suite shrinks', () => {
  const res = detectTestWeakening({ passedCount: 40, failedCount: 2 }, { passedCount: 35, failedCount: 0 });
  assert.equal(res.weakened, true);
  assert.equal(res.before, 42);
  assert.equal(res.after, 35);
});

test('detectTestWeakening allows a suite that grows or holds', () => {
  assert.equal(detectTestWeakening({ passedCount: 10, failedCount: 2 }, { passedCount: 12, failedCount: 0 }).weakened, false);
  assert.equal(detectTestWeakening({ passedCount: 10, failedCount: 2 }, { passedCount: 20, failedCount: 5 }).weakened, false);
});

test('detectTestWeakening ignores the binary fallback signal', () => {
  // Runner emitted no counts: checker falls back to 1/0 or 0/1, which says
  // nothing about suite size. Comparing it would fire on every red->green.
  assert.equal(detectTestWeakening({ passedCount: 0, failedCount: 1 }, { passedCount: 1, failedCount: 0 }).weakened, false);
});

test('detectTestWeakening is inert without a prior cycle', () => {
  assert.equal(detectTestWeakening(null, { passedCount: 5, failedCount: 0 }).weakened, false);
  assert.equal(totalTests(null), null);
});

// ---- Changelog compaction (Wave 5) ----

function changelog(cycles, linesPer = 120) {
  let out = '# Implementation Notes\n\nInitial implementation summary.\n\n';
  for (let i = 1; i <= cycles; i++) {
    out += `## Fix Cycle ${i}\n`;
    for (let l = 0; l < linesPer; l++) out += `- cycle ${i} detail line ${l} ${'x'.repeat(40)}\n`;
    out += '\n';
  }
  return out;
}

test('compactChangelog leaves a short document untouched', () => {
  const short = changelog(1, 3);
  assert.deepEqual(compactChangelog(short), { text: short, compacted: false });
});

test('compactChangelog folds older cycles and keeps the two most recent intact', () => {
  const long = changelog(6);
  const { text, compacted } = compactChangelog(long);
  assert.equal(compacted, true);
  assert.ok(text.length < long.length, 'expected the document to shrink');
  // Every section heading survives — history is navigable, not erased.
  for (let i = 1; i <= 6; i++) assert.match(text, new RegExp(`## Fix Cycle ${i}\\b`), `cycle ${i} heading lost`);
  // The two newest sections keep all their detail lines.
  assert.ok(text.includes('- cycle 6 detail line 119 '), 'newest cycle was folded');
  assert.ok(text.includes('- cycle 5 detail line 119 '), 'second-newest cycle was folded');
  // An older one is folded.
  assert.ok(!text.includes('- cycle 1 detail line 119 '), 'oldest cycle was not folded');
  assert.match(text, /folded by the orchestrator/);
});

test('compactChangelog preserves the document head', () => {
  const { text } = compactChangelog(changelog(6));
  assert.ok(text.startsWith('# Implementation Notes'));
  assert.ok(text.includes('Initial implementation summary.'));
});

test('compactChangelog is a no-op when there are too few sections to fold', () => {
  const twoBig = changelog(2, 800);
  assert.equal(compactChangelog(twoBig).compacted, false);
});

test('compactChangelog also folds post-tester and review sections', () => {
  let doc = '# Notes\n\n';
  for (const label of ['Fix Cycle 1', 'Post-Tester Fix Cycle 1', 'Review Fix Pass 1', 'Review Fix Pass 2']) {
    doc += `## ${label}\n` + '- detail line padding padding padding padding padding\n'.repeat(200) + '\n';
  }
  const { text, compacted } = compactChangelog(doc);
  assert.equal(compacted, true);
  assert.match(text, /## Post-Tester Fix Cycle 1/);
  assert.match(text, /## Review Fix Pass 2/);
});

test('a short but honest change note is accepted', () => {
  // Regression: a one-line fix produces a genuinely small changes.md. A flat
  // 200-byte floor rejected it and halted an otherwise healthy run. The
  // self-review gate must not reintroduce that — a self-review can be one line.
  const honest = `# Notes
- \`src/paginate.js:5\` — floor -> ceil; trailing partial page now emitted.
## Self-Review
- E1 empty list: \`src/paginate.js:3\`. No other rows touched.
`;
  assert.ok(honest.length < 200, 'fixture must be under the structured floor');
  assert.equal(validateArtifact('coder', honest).ok, true);
});

test('structured artifacts still require substance', () => {
  const tiny = '# TECHNICAL SPECIFICATION\n- **Objective:** x\n## Tracer-Bullet Tickets\n';
  assert.equal(validateArtifact('planner', tiny).ok, false);
  assert.match(validateArtifact('planner', tiny).reason, /too short/);
});

test('placeholder writes are rejected for every stage', () => {
  for (const stage of ['planner', 'designer', 'coder', 'tester', 'reviewer', 'handoff']) {
    assert.equal(validateArtifact(stage, 'TODO').ok, false, stage);
    assert.equal(validateArtifact(stage, '').ok, false, stage);
  }
});
