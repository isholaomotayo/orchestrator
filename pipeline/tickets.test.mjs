import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTickets, sliceSpecForTicket, scheduleTickets } from './tickets.mjs';
import { validateArtifact } from './artifacts.mjs';

// Shaped exactly like the skeleton planner_prompt.txt mandates.
const SPEC = `# Specification

## 1. Alignment Log (Q&A)
### A. Domain & Business Logic
Q: what currency? A: GBP.

## 2. Technical Specification (PRD)
- **Objective:** add invoice export
- **Non-Goals:** no PDF styling

### Edge Cases & Failure Modes
| # | Case | Trigger | Required behavior | Proven by |
|---|---|---|---|---|
| E1 | empty cart | no items | throws EmptyCart | rejects_empty_cart |
| E2 | bad currency | "XYZ" | throws BadCurrency | rejects_bad_currency |

## 3. Tracer-Bullet Tickets
### Ticket 1: Invoice model
- **Goal:** add the Invoice type
- **Files:** src/invoice.js, src/types.d.ts
- **Verification Plan:** builds_invoice (E1)
- **Dependencies:** None
- **Signatures:** createInvoice(items)
---
### Ticket 2: Currency validation
- **Goal:** validate currency codes
- **Files:** src/currency.js
- **Verification Plan:** rejects_bad_currency (E2)
- **Dependencies:** None
---
### Ticket 3: Export endpoint
- **Goal:** wire the route
- **Files:** src/routes/export.js, src/invoice.js
- **Verification Plan:** exports_invoice (E1, E2)
- **Dependencies:** Ticket 1, Ticket 2
`;

test('parseTickets reads id, title, files and dependencies from the mandated skeleton', () => {
  const tickets = parseTickets(SPEC);
  assert.equal(tickets.length, 3);
  assert.deepEqual(tickets.map((t) => t.id), ['T1', 'T2', 'T3']);
  assert.equal(tickets[0].title, 'Invoice model');
  assert.deepEqual(tickets[0].files, ['src/invoice.js', 'src/types.d.ts']);
  assert.deepEqual(tickets[0].dependsOn, []);
  assert.deepEqual(tickets[2].dependsOn, ['T1', 'T2']);
  assert.match(tickets[0].body, /add the Invoice type/);
});

test('parseTickets returns an empty list when the spec has no ticket section', () => {
  assert.deepEqual(parseTickets('# Spec\n## 2. Technical Specification\nno tickets here'), []);
});

test('parseTickets treats "none" dependencies case-insensitively', () => {
  const tickets = parseTickets(SPEC.replace('- **Dependencies:** None', '- **Dependencies:** none'));
  assert.deepEqual(tickets[0].dependsOn, []);
});

test('a ticket has no runner override unless one is written into the spec', () => {
  const tickets = parseTickets(SPEC);
  assert.equal(tickets[0].runner, null);
});

test('a ticket can override the feature runner with a **Runner:** line', () => {
  const withRunner = SPEC.replace(
    '- **Dependencies:** None\n- **Signatures:** createInvoice(items)',
    '- **Dependencies:** None\n- **Runner:** host\n- **Signatures:** createInvoice(items)',
  );
  const tickets = parseTickets(withRunner);
  assert.equal(tickets[0].runner, 'host');
  assert.equal(tickets[1].runner, null, 'the override is per-ticket, not global');
});

test('a ticket slice keeps the shared context and only its own ticket', () => {
  const slice = sliceSpecForTicket(SPEC, 'T2');
  assert.match(slice, /## 2\. Technical Specification/);
  assert.match(slice, /E1 \| empty cart/);          // shared failure modes survive
  assert.match(slice, /Ticket 2: Currency validation/);
  assert.doesNotMatch(slice, /Ticket 1: Invoice model/);
  assert.doesNotMatch(slice, /Ticket 3: Export endpoint/);
});

test('a ticket slice still validates as a planner artifact', () => {
  // The worker is handed the slice as its specs.md, so it must pass the same
  // contract the Planner's own output does or the run halts on MISSING_ARTIFACT.
  for (const id of ['T1', 'T2', 'T3']) {
    const res = validateArtifact('planner', sliceSpecForTicket(SPEC, id));
    assert.equal(res.ok, true, `slice ${id} rejected: ${res.reason}`);
  }
});

test('slicing an unknown ticket id throws rather than silently returning everything', () => {
  assert.throws(() => sliceSpecForTicket(SPEC, 'T9'), /unknown ticket/i);
});

// ---- scheduling ------------------------------------------------------------

const tickets = () => parseTickets(SPEC);

test('the first wave is every dependency-free ticket, capped by maxParallel', () => {
  const wave = scheduleTickets(tickets(), { done: [], running: [], maxParallel: 3 });
  assert.deepEqual(wave.map((t) => t.id), ['T1', 'T2']);
  const capped = scheduleTickets(tickets(), { done: [], running: [], maxParallel: 1 });
  assert.deepEqual(capped.map((t) => t.id), ['T1']);
});

test('a dependent ticket waits until every dependency is done', () => {
  assert.deepEqual(scheduleTickets(tickets(), { done: ['T1'], running: [], maxParallel: 3 }).map((t) => t.id), ['T2']);
  assert.deepEqual(scheduleTickets(tickets(), { done: ['T1', 'T2'], running: [], maxParallel: 3 }).map((t) => t.id), ['T3']);
});

test('maxParallel counts tickets already running', () => {
  const wave = scheduleTickets(tickets(), { done: [], running: ['T1'], maxParallel: 2 });
  assert.deepEqual(wave.map((t) => t.id), ['T2']);
  assert.deepEqual(scheduleTickets(tickets(), { done: [], running: ['T1', 'T2'], maxParallel: 2 }), []);
});

test('a ticket whose files overlap a running ticket is deferred, not run in parallel', () => {
  // T3 touches src/invoice.js, which T1 is editing. Even with dependencies met,
  // running them together invites a merge conflict at fan-in.
  const done = ['T1', 'T2'];
  const overlapping = scheduleTickets(
    [...tickets()],
    { done, running: [], maxParallel: 3, runningFiles: { R1: ['src/invoice.js'] }, serializeOnFileOverlap: true },
  );
  assert.deepEqual(overlapping, []);
  const disjoint = scheduleTickets(
    [...tickets()],
    { done, running: [], maxParallel: 3, runningFiles: { R1: ['src/other.js'] }, serializeOnFileOverlap: true },
  );
  assert.deepEqual(disjoint.map((t) => t.id), ['T3']);
});

test('file-overlap serialization can be turned off', () => {
  const wave = scheduleTickets(tickets(), {
    done: ['T1', 'T2'], running: [], maxParallel: 3,
    runningFiles: { R1: ['src/invoice.js'] }, serializeOnFileOverlap: false,
  });
  assert.deepEqual(wave.map((t) => t.id), ['T3']);
});

test('a ticket that is already done or running is never scheduled again', () => {
  const wave = scheduleTickets(tickets(), { done: ['T1'], running: ['T2'], maxParallel: 5 });
  assert.deepEqual(wave, []);
});

test('a ticket depending on something that does not exist never becomes runnable', () => {
  const orphan = [{ id: 'T1', title: 'x', files: [], dependsOn: ['T9'], body: 'b' }];
  assert.deepEqual(scheduleTickets(orphan, { done: [], running: [], maxParallel: 3 }), []);
});
