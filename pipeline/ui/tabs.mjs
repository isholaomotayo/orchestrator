// The tab store.
//
// The old dashboard held one project, one run and one stage in module globals.
// Watching several workers at once means each open thing needs its own state —
// its own stage selection, its own scroll position, its own filter — so that
// switching tabs shows you exactly what you left, and a background run
// finishing does not move the view you are reading.
//
// Pure and DOM-free: the store decides what is open and what deserves
// attention; rendering is somebody else's job.

export const MAX_TABS = 12;

// Which kinds may be opened more than once (one per subject).
const SUBJECT_KINDS = new Set(['run', 'feature', 'review', 'report']);

export function tabId(spec) {
  return SUBJECT_KINDS.has(spec.kind)
    ? `${spec.kind}:${spec.subject}${spec.file ? `/${spec.file}` : ''}`
    : spec.kind;
}

export function createTabStore({ max = MAX_TABS } = {}) {
  /** @type {Array<object>} */
  let tabs = [];
  let activeId = null;

  function open(spec) {
    const id = tabId(spec);
    const existing = tabs.find((t) => t.id === id);
    if (existing) {
      Object.assign(existing, { ...spec, id, openedAt: existing.openedAt });
      activeId = id;
      existing.attention = null;
      existing.unread = false;
      return existing;
    }
    const tab = {
      id,
      kind: spec.kind,
      subject: spec.subject ?? null,
      title: spec.title ?? spec.kind,
      file: spec.file ?? null,
      pinned: !!spec.pinned,
      // Per-tab view state, so tabs never share a stage selection or a filter.
      stage: spec.stage ?? null,
      filter: '',
      showAll: false,
      scrollTop: 0,
      unread: false,
      attention: null,
      lastSeenSeq: 0,
      openedAt: Date.now(),
      // A numeric count shown on the tab itself, set by id (not by subject
      // match like markAttention) — for a destination like Attention that
      // has no single run/feature subject of its own but still needs to
      // surface "N things are waiting" on the tab strip.
      badgeCount: 0,
    };
    tabs.push(tab);
    activeId = id;
    evict();
    return tab;
  }

  function close(id) {
    const tab = tabs.find((t) => t.id === id);
    if (!tab || tab.pinned) return false;
    const index = tabs.indexOf(tab);
    tabs = tabs.filter((t) => t.id !== id);
    if (activeId === id) {
      const next = tabs[index] || tabs[index - 1] || tabs[0];
      activeId = next ? next.id : null;
    }
    return true;
  }

  function activate(id) {
    const tab = tabs.find((t) => t.id === id);
    if (!tab) return null;
    activeId = id;
    // Looking at something clears its claim on your attention.
    tab.unread = false;
    tab.attention = null;
    return tab;
  }

  function evict() {
    // Never evict what is pinned or being looked at; drop the least recently
    // opened of the rest, so a burst of new runs cannot bury the tab you are in.
    while (tabs.length > max) {
      const victim = tabs
        .filter((t) => !t.pinned && t.id !== activeId)
        .sort((a, b) => a.openedAt - b.openedAt)[0];
      if (!victim) break;
      tabs = tabs.filter((t) => t !== victim);
    }
  }

  // Priority order matters: a decision waiting on a person outranks a failure,
  // which outranks a finished run.
  const RANK = { decision: 4, blocked: 3, merge: 2, done: 1 };

  function markAttention(subject, level, { seq = null } = {}) {
    let marked = false;
    for (const tab of tabs) {
      if (tab.subject !== subject) continue;
      if (seq != null && seq <= tab.lastSeenSeq) continue;
      if (tab.id === activeId) { tab.lastSeenSeq = seq ?? tab.lastSeenSeq; continue; }
      if (!tab.attention || (RANK[level] ?? 0) > (RANK[tab.attention] ?? 0)) tab.attention = level;
      tab.unread = true;
      if (seq != null) tab.lastSeenSeq = seq;
      marked = true;
    }
    return marked;
  }

  function setBadgeCount(id, count) {
    const tab = tabs.find((t) => t.id === id);
    if (tab) tab.badgeCount = count || 0;
    return tab ?? null;
  }

  function pin(id, pinned = true) {
    const tab = tabs.find((t) => t.id === id);
    if (tab) tab.pinned = pinned;
    return tab ?? null;
  }

  function move(delta) {
    if (!tabs.length) return null;
    const index = tabs.findIndex((t) => t.id === activeId);
    const next = tabs[(((index === -1 ? 0 : index) + delta) % tabs.length + tabs.length) % tabs.length];
    return activate(next.id);
  }

  /** Serialise to a hash fragment so a reload restores the same workspace. */
  function serialize() {
    const parts = tabs.map((t) => `${t.id}${t.stage ? `.${t.stage}` : ''}`);
    const active = tabs.findIndex((t) => t.id === activeId);
    const pins = tabs.filter((t) => t.pinned).map((t) => t.id);
    return `tabs=${encodeURIComponent(parts.join(','))}&active=${active}${pins.length ? `&pin=${encodeURIComponent(pins.join(','))}` : ''}`;
  }

  // A saved/bookmarked hash can reference a tab kind this version of the
  // dashboard no longer knows (removed, or from a newer build) — isKnownKind
  // lets the caller drop just that one entry instead of the whole restore
  // silently misbehaving or a later render() crashing on an unrecognized kind.
  function restore(hash, { titleFor = (spec) => spec.subject || spec.kind, isKnownKind = () => true } = {}) {
    const params = new URLSearchParams(String(hash || '').replace(/^#/, ''));
    const raw = params.get('tabs');
    if (!raw) return [];
    const pins = new Set((params.get('pin') || '').split(',').filter(Boolean));
    tabs = [];
    activeId = null;
    const rawParts = raw.split(',').filter(Boolean);
    const requestedActiveIndex = Number(params.get('active'));
    let resolvedActiveId = null;
    rawParts.forEach((part, i) => {
      const [idPart, stage] = part.split('.');
      const [kind, ...rest] = idPart.split(':');
      if (!isKnownKind(kind)) return;
      const subject = rest.join(':') || null;
      const spec = { kind, subject, stage: stage || null, pinned: pins.has(idPart) };
      const tab = open({ ...spec, title: titleFor(spec) });
      if (i === requestedActiveIndex) resolvedActiveId = tab.id;
    });
    activeId = resolvedActiveId ?? tabs[0]?.id ?? null;
    return tabs;
  }

  return {
    open, close, activate, pin, move, markAttention, setBadgeCount, serialize, restore,
    list: () => tabs.slice(),
    active: () => tabs.find((t) => t.id === activeId) ?? null,
    activeId: () => activeId,
    get: (id) => tabs.find((t) => t.id === id) ?? null,
    attentionCount: () => tabs.filter((t) => t.attention).length,
  };
}
