import test from 'node:test';
import assert from 'node:assert/strict';
import {
  describeEvent, isStaleRefresh, queuedNotes,
  conversationItems, estimateItemHeight, visibleRange, isNearBottom, feedSignature,
} from './feed.mjs';

test('assistant text is a role-aware markdown block, not a raw dump', () => {
  const d = describeEvent({ type: 'agent_output', kind: 'text', role: 'assistant', text: 'Looking at the spec.' });
  assert.equal(d.role, 'Assistant');
  assert.equal(d.markdown, true);
  assert.equal(d.text, 'Looking at the spec.');
});

test('human notes keep a You label and pending/applied state', () => {
  const pending = describeEvent({ kind: 'note', role: 'human', text: 'Keep the API small.', noteStatus: 'pending' });
  assert.equal(pending.role, 'You');
  assert.equal(pending.noteStatus, 'pending');
  const applied = describeEvent({ type: 'followup_applied', text: 'Keep the API small.' });
  assert.equal(applied.noteStatus, 'applied');
});

test('tool, retry, reconnect, parked, timeout, and checker cards stay compact', () => {
  assert.match(describeEvent({ kind: 'tool', tool: 'read', file: 'a.ts', status: 'started' }).text, /read/);
  assert.match(describeEvent({ type: 'agent_retry', attempt: 2, of: 3, reason: 'transient' }).text, /Retrying/);
  assert.match(describeEvent({ kind: 'sys', subtype: 'reconnected', text: 'reconnected' }).text, /reconnected/);
  assert.match(describeEvent({ type: 'agent_parked', hostHandoff: true }).text, /Parked/);
  assert.match(describeEvent({ type: 'agent_timeout' }).text, /time limit/);
  assert.equal(describeEvent({ type: 'checks_start' }).className, 'divider');
  assert.match(describeEvent({ type: 'check_end', check: 'test', ok: true }).text, /test/);
  assert.match(describeEvent({ type: 'chat_handoff' }).text, /Handed off/);
});

test('a stale overlapping refresh is rejected', () => {
  assert.equal(isStaleRefresh(4, 3), true);
  assert.equal(isStaleRefresh(4, 4), false);
});

test('queued followups surface as pending You notes', () => {
  const notes = queuedNotes({ planner: 'one\ntwo' }, 'planner');
  assert.equal(notes.length, 2);
  assert.equal(describeEvent(notes[0]).role, 'You');
  assert.equal(describeEvent(notes[0]).noteStatus, 'pending');
});

test('conversationItems appends queued notes that are not already in the stream', () => {
  const items = conversationItems(
    [{ kind: 'text', text: 'hello' }, { kind: 'note', text: 'one' }],
    { planner: 'one\ntwo' },
    'planner',
  );
  assert.equal(items.length, 3);
  assert.equal(items[2].text, 'two');
});

test('visibleRange only covers the viewport plus overscan', () => {
  const heights = Array.from({ length: 100 }, () => 40);
  const range = visibleRange({ heights, scrollTop: 800, viewportHeight: 200, overscan: 2 });
  assert.ok(range.start >= 16);
  assert.ok(range.end <= 29);
  assert.equal(range.padTop + heights.slice(range.start, range.end).reduce((s, h) => s + h, 0) + range.padBottom, range.total);
  assert.equal(range.total, 4000);
});

test('a long assistant message is estimated taller than a tool card', () => {
  const tool = estimateItemHeight({ kind: 'tool', tool: 'read', file: 'a.ts' });
  const essay = estimateItemHeight({ kind: 'text', role: 'assistant', text: 'word '.repeat(400) });
  assert.ok(essay > tool);
});

test('isNearBottom is true at the end of the stream and false after scrolling up', () => {
  assert.equal(isNearBottom(930, 1000, 80, 72), true);
  assert.equal(isNearBottom(100, 1000, 80, 72), false);
});

test('feedSignature changes when a new event arrives', () => {
  const a = [{ ts: '1', kind: 'text', text: 'hi' }];
  const b = [...a, { ts: '2', kind: 'text', text: 'there' }];
  assert.notEqual(feedSignature(a), feedSignature(b));
});
