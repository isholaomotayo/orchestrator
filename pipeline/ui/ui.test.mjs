import test from 'node:test';
import assert from 'node:assert/strict';
import { esc, renderMd } from './md.mjs';
import { splitDiffFiles, renderDiff } from './diff.mjs';
import { createTabStore, tabId, MAX_TABS } from './tabs.mjs';
import { buildTree, attentionByRun, attentionLevel, featureLabel } from './pool-tree.mjs';

// ---- rendering safety ------------------------------------------------------

test('markdown escapes before it decorates, so agent text cannot become markup', () => {
  const html = renderMd('# <script>alert(1)</script>\n\n**bold** and `code`');
  assert.ok(!html.includes('<script>'));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<code>code<\/code>/);
});

test('escaping covers the characters that break out of markup', () => {
  assert.equal(esc('<a & b>'), '&lt;a &amp; b&gt;');
});

test('a diff splits per file and per repository section', () => {
  const patch = [
    '## repo `app`',
    'diff --git a/a.js b/a.js',
    '+one',
    'diff --git a/b.js b/b.js',
    '-two',
  ].join('\n');
  const files = splitDiffFiles(patch).filter((f) => f.name);
  assert.equal(files.length, 2);
  // The repository heading is folded into each file name, so a run spanning
  // several clones cannot show two same-named files with no way to tell them apart.
  assert.deepEqual(files.map((f) => f.name), ['app/a.js', 'app/b.js']);
});

test('a diff renders collapsed markup without executing anything', () => {
  const html = renderDiff('diff --git a/x.js b/x.js\n+<script>bad</script>\n');
  assert.ok(!html.includes('<script>bad'));
  assert.match(html, /&lt;script&gt;/);
});

// ---- tab store -------------------------------------------------------------

test('opening the same subject twice focuses the existing tab', () => {
  const tabs = createTabStore();
  const a = tabs.open({ kind: 'run', subject: 'r1', title: 'r1' });
  const b = tabs.open({ kind: 'run', subject: 'r1', title: 'r1' });
  assert.equal(tabs.list().length, 1);
  assert.equal(a.id, b.id);
  assert.equal(tabs.activeId(), 'run:r1');
});

test('different subjects get different tabs, singletons do not', () => {
  const tabs = createTabStore();
  tabs.open({ kind: 'run', subject: 'r1' });
  tabs.open({ kind: 'run', subject: 'r2' });
  tabs.open({ kind: 'decisions' });
  tabs.open({ kind: 'decisions' });
  assert.deepEqual(tabs.list().map((t) => t.id), ['run:r1', 'run:r2', 'decisions']);
  assert.equal(tabId({ kind: 'review', subject: 'r1' }), 'review:r1');
});

test('each tab keeps its own view state', () => {
  const tabs = createTabStore();
  const a = tabs.open({ kind: 'run', subject: 'r1', stage: 'coder' });
  const b = tabs.open({ kind: 'run', subject: 'r2', stage: 'tester' });
  a.filter = 'error';
  assert.equal(tabs.get('run:r1').stage, 'coder');
  assert.equal(tabs.get('run:r2').stage, 'tester');
  assert.equal(tabs.get('run:r2').filter, '', 'a filter in one tab does not leak into another');
  assert.equal(b.stage, 'tester');
});

test('closing a tab activates a neighbour, and a pinned tab cannot be closed', () => {
  const tabs = createTabStore();
  tabs.open({ kind: 'home', pinned: true });
  tabs.open({ kind: 'run', subject: 'r1' });
  tabs.open({ kind: 'run', subject: 'r2' });
  tabs.activate('run:r1');
  tabs.close('run:r1');
  assert.equal(tabs.activeId(), 'run:r2');
  assert.equal(tabs.close('home'), false);
  assert.ok(tabs.get('home'));
});

test('attention marks background tabs only, and looking clears it', () => {
  const tabs = createTabStore();
  tabs.open({ kind: 'run', subject: 'r1' });
  tabs.open({ kind: 'run', subject: 'r2' });   // r2 is active
  tabs.markAttention('r1', 'decision');
  tabs.markAttention('r2', 'decision');
  assert.equal(tabs.get('run:r1').attention, 'decision');
  assert.equal(tabs.get('run:r2').attention, null, 'the tab you are reading is not flagged');
  tabs.activate('run:r1');
  assert.equal(tabs.get('run:r1').attention, null);
  assert.equal(tabs.get('run:r1').unread, false);
});

test('a more urgent signal upgrades a badge, a lesser one does not downgrade it', () => {
  const tabs = createTabStore();
  tabs.open({ kind: 'run', subject: 'r1' });
  tabs.open({ kind: 'home' });
  tabs.markAttention('r1', 'done');
  tabs.markAttention('r1', 'decision');
  assert.equal(tabs.get('run:r1').attention, 'decision');
  tabs.markAttention('r1', 'done');
  assert.equal(tabs.get('run:r1').attention, 'decision');
});

test('an event already seen does not re-flag a tab', () => {
  const tabs = createTabStore();
  tabs.open({ kind: 'run', subject: 'r1' });
  tabs.open({ kind: 'home' });
  assert.equal(tabs.markAttention('r1', 'decision', { seq: 5 }), true);
  tabs.activate('run:r1');
  tabs.activate('home');
  assert.equal(tabs.markAttention('r1', 'decision', { seq: 5 }), false, 'the same event must not nag twice');
  assert.equal(tabs.markAttention('r1', 'decision', { seq: 6 }), true);
});

test('too many open tabs evicts the oldest non-pinned one, and pinned tabs are never evicted', () => {
  const tabs = createTabStore({ max: 3 });
  tabs.open({ kind: 'home', pinned: true });
  tabs.open({ kind: 'run', subject: 'old' });
  tabs.open({ kind: 'run', subject: 'mid' });
  tabs.open({ kind: 'run', subject: 'third' });
  tabs.open({ kind: 'run', subject: 'new' }); // 4th non-pinned tab crosses max:3
  const ids = tabs.list().map((t) => t.id);
  assert.ok(ids.includes('home'), 'pinned survives');
  assert.ok(!ids.includes('run:old'), 'the oldest non-pinned tab is evicted (opening a new tab always makes it the active one)');
  assert.ok(ids.includes('run:new'), 'the just-opened tab is never evicted, being both active and newest');
  assert.equal(ids.filter((id) => id !== 'home').length, 3, 'non-pinned tabs are capped at max');
});

test('pinned tabs never count toward the open-tab eviction budget', () => {
  const tabs = createTabStore({ max: 2 });
  tabs.open({ kind: 'a', pinned: true });
  tabs.open({ kind: 'b', pinned: true });
  tabs.open({ kind: 'c', pinned: true });
  tabs.open({ kind: 'run', subject: 'x' });
  tabs.open({ kind: 'run', subject: 'y' });
  assert.equal(tabs.list().length, 5, 'three pinned + two non-pinned, none evicted at max:2');
});

test('tabs round-trip through the url so a reload restores the workspace', () => {
  const tabs = createTabStore();
  tabs.open({ kind: 'home', pinned: true });
  tabs.open({ kind: 'run', subject: 'r1', stage: 'coder' });
  tabs.open({ kind: 'review', subject: 'r1' });
  const hash = tabs.serialize();

  const restored = createTabStore();
  restored.restore(`#${hash}`);
  assert.deepEqual(restored.list().map((t) => t.id), ['home', 'run:r1', 'review:r1']);
  assert.equal(restored.get('run:r1').stage, 'coder');
  assert.equal(restored.get('home').pinned, true);
  assert.equal(restored.activeId(), 'review:r1');
});

test('restoring from an empty or malformed hash leaves the workspace untouched', () => {
  const tabs = createTabStore();
  assert.deepEqual(tabs.restore(''), []);
  assert.deepEqual(tabs.restore('#nonsense=1'), []);
});

test('restore drops a tab whose kind this build no longer knows, keeping the rest', () => {
  const tabs = createTabStore();
  tabs.open({ kind: 'home', pinned: true });
  tabs.open({ kind: 'diff', subject: 'r1' }); // a kind removed from a later build
  tabs.open({ kind: 'run', subject: 'r1' });
  const hash = tabs.serialize();

  const restored = createTabStore();
  restored.restore(`#${hash}`, { isKnownKind: (kind) => kind !== 'diff' });
  assert.deepEqual(restored.list().map((t) => t.id), ['home', 'run:r1'], 'the diff tab is gone, nothing else is');
});

test('restore re-maps the active tab correctly when an earlier tab is dropped for an unknown kind', () => {
  const tabs = createTabStore();
  tabs.open({ kind: 'diff', subject: 'r1' }); // index 0, will be dropped
  tabs.open({ kind: 'run', subject: 'r1' }); // index 1
  tabs.open({ kind: 'review', subject: 'r1' }); // index 2, was active
  const hash = tabs.serialize();
  assert.match(hash, /active=2/);

  const restored = createTabStore();
  restored.restore(`#${hash}`, { isKnownKind: (kind) => kind !== 'diff' });
  assert.equal(restored.activeId(), 'review:r1', 'still the review tab, not shifted onto run:r1');
});

test('restore falls back to the first surviving tab when the requested active tab itself was dropped', () => {
  const tabs = createTabStore();
  tabs.open({ kind: 'run', subject: 'r1' });
  tabs.open({ kind: 'diff', subject: 'r1' }); // active, but will be dropped
  const hash = tabs.serialize();

  const restored = createTabStore();
  restored.restore(`#${hash}`, { isKnownKind: (kind) => kind !== 'diff' });
  assert.equal(restored.activeId(), 'run:r1');
});

test('setBadgeCount marks a specific tab by id, independent of subject matching', () => {
  const tabs = createTabStore();
  tabs.open({ kind: 'attention', pinned: true });
  tabs.setBadgeCount('attention', 3);
  assert.equal(tabs.get('attention').badgeCount, 3);
  tabs.setBadgeCount('attention', 0);
  assert.equal(tabs.get('attention').badgeCount, 0);
  assert.equal(tabs.setBadgeCount('does-not-exist', 5), null);
});

test('moving cycles through open (non-pinned) tabs only, skipping pinned destinations', () => {
  const tabs = createTabStore();
  tabs.open({ kind: 'home', pinned: true });
  tabs.open({ kind: 'run', subject: 'a' });
  tabs.open({ kind: 'run', subject: 'b' });
  tabs.activate('run:a');
  assert.equal(tabs.move(1).id, 'run:b');
  assert.equal(tabs.move(1).id, 'run:a', 'wraps around within open tabs, never lands on home');
  assert.equal(tabs.move(-1).id, 'run:b');
});

test('moving from an active destination enters the open-tabs list', () => {
  const tabs = createTabStore();
  tabs.open({ kind: 'home', pinned: true });
  tabs.open({ kind: 'run', subject: 'a' });
  tabs.open({ kind: 'run', subject: 'b' });
  tabs.activate('home');
  assert.equal(tabs.move(1).id, 'run:a');
});

test('moving with no open tabs is a no-op', () => {
  const tabs = createTabStore();
  tabs.open({ kind: 'home', pinned: true });
  assert.equal(tabs.move(1), null);
});

// ---- sidebar tree ----------------------------------------------------------

const snapshot = {
  supervisor: { alive: true, paused: false },
  roadmap: {
    title: 'Billing', currentFeatureId: 'F2',
    features: [
      { id: 'F1', title: 'Model', status: 'landed', dependsOn: [] },
      { id: 'F2', title: 'Export', status: 'executing', dependsOn: ['F1'] },
      { id: 'F3', title: 'Email', status: 'queued', dependsOn: ['F2'] },
    ],
  },
  needsDecision: [
    { decisionId: 'd1', kind: 'merge-approval', question: 'Merge F2?', featureId: 'F2', runId: 'r9' },
    { decisionId: null, kind: 'feature-failed', question: 'F4 did not complete.', featureId: 'F4' },
  ],
  inProgress: [
    { runId: 'r1', featureId: 'F2', ticketId: 'T1', kind: 'ticket', stage: 'coder', cycle: 2, state: 'busy' },
    { runId: 'r2', featureId: 'F2', ticketId: 'T2', kind: 'ticket', stage: 'tester', state: 'stale' },
    { runId: 'r3', featureId: null, kind: 'adhoc', stage: 'planner', state: 'busy' },
  ],
  recentlyLanded: [{ featureId: 'F1', title: 'Model', pr: { url: 'https://x/1' }, reportRel: 'runs/x/reports/work-done.html' }],
  upNext: [{ featureId: 'F3', title: 'Email', blockedBy: ['F2'] }],
};

test('the sidebar has the four sections in the order an operator reads them', () => {
  const tree = buildTree(snapshot);
  assert.deepEqual(tree.sections.map((s) => s.key), ['needsDecision', 'inProgress', 'recentlyLanded', 'upNext']);
  assert.equal(tree.enabled, true);
});

test('runs are nested under the feature they belong to', () => {
  const tree = buildTree(snapshot);
  const inProgress = tree.sections.find((s) => s.key === 'inProgress');
  const f2 = inProgress.items.find((i) => i.id === 'F2');
  assert.deepEqual(f2.children.map((c) => c.id), ['r1', 'r2']);
  assert.equal(f2.sub, 'building', 'internal state names are translated for the reader');
});

test('a run with no feature is still reachable', () => {
  const other = buildTree(snapshot).sections.find((s) => s.key === 'inProgress').items.find((i) => i.id === '_other');
  assert.ok(other, 'an orphaned run must not be invisible');
  assert.deepEqual(other.children.map((c) => c.id), ['r3']);
});

test('a quiet or dead worker is flagged in the tree', () => {
  const f2 = buildTree(snapshot).sections.find((s) => s.key === 'inProgress').items.find((i) => i.id === 'F2');
  const stale = f2.children.find((c) => c.id === 'r2');
  assert.equal(stale.dot, 'warn');
  assert.match(stale.warn, /quiet/);
});

test('landed and queued features carry what the operator needs next', () => {
  const tree = buildTree(snapshot);
  assert.equal(tree.sections.find((s) => s.key === 'recentlyLanded').items[0].reportRel, 'runs/x/reports/work-done.html');
  assert.match(tree.sections.find((s) => s.key === 'upNext').items[0].sub, /waiting on F2/);
});

test('an item with no formal decision still appears with the right urgency', () => {
  const items = buildTree(snapshot).sections.find((s) => s.key === 'needsDecision').items;
  assert.equal(items.length, 2);
  assert.equal(items.find((i) => i.featureId === 'F4').level, 'blocked');
  assert.equal(items.find((i) => i.featureId === 'F2').level, 'merge');
});

test('attention maps to the runs that deserve a badge', () => {
  const map = attentionByRun(snapshot);
  assert.equal(map.get('r9'), 'merge');
  assert.equal(map.get('r2'), 'blocked', 'a stale worker earns a badge');
  assert.equal(map.get('r1'), undefined, 'a healthy worker does not');
});

test('no snapshot means single-run mode, not a crash', () => {
  const tree = buildTree(null);
  assert.equal(tree.enabled, false);
  assert.deepEqual(tree.sections, []);
});

test('state names are translated into words an operator understands', () => {
  assert.equal(featureLabel('awaiting_merge_approval'), 'ready to merge');
  assert.equal(featureLabel('integrating'), 'combining work');
  assert.equal(attentionLevel({ kind: 'merge-approval' }), 'merge');
});
