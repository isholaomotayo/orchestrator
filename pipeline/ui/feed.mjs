// Pure conversation-feed helpers so the dashboard can be tested without a DOM.

export function describeEvent(ev) {
  if (!ev || typeof ev !== 'object') return { className: 'block', text: '' };
  if (ev.type === 'checks_start') return { className: 'divider', text: 'verification' };
  if (ev.type === 'check_start') return { className: 'block sys card', text: `checking ${ev.check}` };
  if (ev.type === 'check_end') return { className: 'block sys card', text: `${ev.ok ? '✓' : '✗'} ${ev.check}` };
  if (ev.type === 'agent_start') return { className: 'divider', text: ev.cycle > 1 ? `cycle ${ev.cycle}` : 'started' };
  if (ev.type === 'agent_parked') return { className: 'block sys card', text: 'Parked — waiting for the IDE session to finish this stage.' };
  if (ev.type === 'agent_retry') return { className: 'block sys card', text: `Retrying${ev.attempt ? ` (attempt ${ev.attempt}${ev.of ? `/${ev.of}` : ''})` : ''}${ev.reason ? ` — ${ev.reason}` : ''}` };
  if (ev.type === 'agent_timeout') return { className: 'block err card', text: 'The agent was stopped after it exceeded the time limit.' };
  if (ev.type === 'agent_end') {
    if (ev.hostHandoff) return { className: 'block sys card', text: 'Parked — waiting for the IDE session to finish this stage.' };
    return { className: 'block sys card', text: ev.ok ? 'Stage process finished.' : `Stage process exited${ev.exitCode != null ? ` (${ev.exitCode})` : ''}.` };
  }
  if (ev.type === 'followup_applied') return { className: 'block note', role: 'You', text: ev.text || 'A note from you was applied here.', noteStatus: 'applied' };
  if (ev.type === 'chat_handoff') return { className: 'block sys card', text: 'Handed off to the IDE chat session.' };
  if (ev.kind === 'note' || ev.role === 'human') {
    return { className: 'block note', role: 'You', text: ev.text || '', noteStatus: ev.noteStatus || 'pending' };
  }
  if (ev.kind === 'err') return { className: 'block err', text: ev.text || '' };
  if (ev.kind === 'tool') {
    const bits = [ev.tool || 'tool', ev.status, ev.file, ev.cmd].filter(Boolean);
    return { className: 'block sys card', text: bits.join(' · ') };
  }
  if (ev.kind === 'sys') return { className: 'block sys card', text: ev.text || '' };
  return { className: 'block assistant', role: 'Assistant', markdown: true, text: ev.text || '' };
}

export function isStaleRefresh(currentGen, fetchGen) {
  return currentGen !== fetchGen;
}

export function queuedNotes(followups, stage) {
  const text = followups?.[stage];
  if (!text || !String(text).trim()) return [];
  return String(text).trim().split('\n').filter(Boolean).map((line) => ({
    kind: 'note', role: 'human', text: line, noteStatus: 'pending',
  }));
}

export const FEED_GAP = 9;
export const FEED_OVERSCAN = 6;
export const FEED_PIN_PX = 72;

export function conversationItems(events, followups, stage) {
  const list = [...(events || [])];
  for (const note of queuedNotes(followups, stage)) {
    if (!list.some((ev) => ev.kind === 'note' && ev.text === note.text)) list.push(note);
  }
  return list;
}

export function itemKey(ev, index) {
  const stamp = ev?.ts || ev?.id || '';
  const hint = String(ev?.text || ev?.tool || ev?.type || ev?.kind || '').slice(0, 48);
  return `${index}:${stamp}:${ev?.type || ev?.kind || ''}:${hint}`;
}

export function estimateItemHeight(ev) {
  const d = describeEvent(ev);
  const className = d.className || '';
  if (className.includes('divider')) return 28 + FEED_GAP;
  if (className.includes('card')) return 46 + FEED_GAP;
  const text = d.text || '';
  const lines = Math.max(1, text.split('\n').reduce((n, line) => (
    n + Math.max(1, Math.ceil(Math.max(line.length, 1) / 88))
  ), 0));
  return Math.min(520, 48 + lines * 22) + FEED_GAP;
}

export function visibleRange({ heights, scrollTop, viewportHeight, overscan = FEED_OVERSCAN }) {
  const n = heights.length;
  if (!n) return { start: 0, end: 0, padTop: 0, padBottom: 0, total: 0 };
  let total = 0;
  for (const h of heights) total += h;
  const top = Math.max(0, Number(scrollTop) || 0);
  const view = Math.max(1, Number(viewportHeight) || 1);
  const bottom = top + view;
  let acc = 0;
  let start = 0;
  for (let i = 0; i < n; i++) {
    const next = acc + heights[i];
    if (next > top) { start = i; break; }
    acc = next;
    start = i;
  }
  start = Math.max(0, start - overscan);
  let padTop = 0;
  for (let i = 0; i < start; i++) padTop += heights[i];
  let end = start;
  acc = padTop;
  while (end < n && acc < bottom) {
    acc += heights[end];
    end += 1;
  }
  end = Math.min(n, end + overscan);
  let padBottom = 0;
  for (let i = end; i < n; i++) padBottom += heights[i];
  return { start, end, padTop, padBottom, total };
}

export function isNearBottom(scrollTop, scrollHeight, clientHeight, threshold = FEED_PIN_PX) {
  return (Number(scrollTop) || 0) + (Number(clientHeight) || 0) >= (Number(scrollHeight) || 0) - threshold;
}

export function feedSignature(items) {
  const last = items[items.length - 1];
  if (!last) return '0';
  return `${items.length}:${last.ts || ''}:${last.type || last.kind || ''}:${String(last.text || last.tool || '').length}`;
}
