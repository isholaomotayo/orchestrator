// The control room.
//
// One dashboard watches a whole pool: a roadmap of features, several workers
// building in parallel, and the decisions waiting on a person. The sidebar
// answers "what needs me / what is happening / what landed / what is next";
// tabs hold whatever you opened, each keeping its own place.
//
// Design rules worth stating, because they are easy to break later:
//  - Only the active tab re-renders on an update. A background run finishing
//    must never move the view someone is reading.
//  - Nothing is dressed up. A stuck run looks stuck; a failed feature says so.
//  - No feature is hidden when there is no pool: a plain single-run project
//    gets the same tabs with a runs list instead of a roadmap.

import { esc, renderMd } from './md.mjs';
import { renderDiff } from './diff.mjs';
import { createTabStore } from './tabs.mjs';
import { buildTree, attentionByRun, featureLabel } from './pool-tree.mjs';
import { createApi } from './api.mjs';
import { stageIcon, agentMeta, STAGE_ORDER } from './stages.mjs';
import {
  describeEvent, isStaleRefresh, conversationItems, estimateItemHeight,
  visibleRange, isNearBottom, itemKey, feedSignature, FEED_GAP,
} from './feed.mjs';
import { runBucket, BUCKET_LABEL, ageMs, formatAge, allRuns, filterRuns } from './runs.mjs';
import { unavailableReason } from './actions.mjs';

const $ = (id) => document.getElementById(id);
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const el = (tag, attrs = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
};

const state = {
  project: new URLSearchParams(location.search).get('project') || '',
  projects: [],
  pool: null,
  runs: [],
  status: null,
  sse: null,
  seq: 0,
  refreshGen: 0,
  degraded: false,
  degradedError: null,
  lastGoodAt: null,
};

const api = createApi(() => state.project);
const tabs = createTabStore();

// ---- shell ----------------------------------------------------------------

function toast(message) {
  const node = $('toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { node.hidden = true; }, 3200);
}

// Connection health: a failed poll never blanks the page (refresh() keeps the
// last good state.pool/state.runs untouched), but it must not look silent
// either — this chip is the only visible sign anything is stale.
function renderDegraded() {
  const chip = $('degraded');
  if (!state.degraded) { chip.hidden = true; return; }
  chip.hidden = false;
  const age = state.lastGoodAt ? Math.round((Date.now() - state.lastGoodAt) / 1000) : null;
  chip.textContent = age != null
    ? `disconnected — showing data from ${age}s ago, retrying…`
    : 'disconnected — retrying…';
  chip.onclick = () => refresh();
}

function setTheme(next) {
  const root = document.documentElement;
  if (next === 'system') delete root.dataset.theme;
  else root.dataset.theme = next;
  try { localStorage.setItem('orchestrator-theme', next); } catch {}
}

function currentTheme() {
  return document.documentElement.dataset.theme || 'system';
}

// ---- sidebar --------------------------------------------------------------

function renderSidebar() {
  const side = $('side');
  side.replaceChildren();
  const tree = buildTree(state.pool?.snapshot ?? null);

  if (!tree.enabled) {
    // Single-run project: the sidebar is a plain overview — every run, live
    // one first. The pipeline itself (all 7 stages, with progress) lives in
    // that run's own tab, not here — the sidebar has to stay a navigation
    // list once more than one run's tab can be open at a time.
    side.append(sectionNode({
      key: 'runs', title: 'Runs', count: state.runs.length, emptyText: 'No runs yet.',
      items: state.runs.map((r) => ({
        id: r.id, kind: 'run',
        label: r.task ? String(r.task).slice(0, 60) : (r.id || 'Current run'),
        sub: [r.overall, r.verdict].filter(Boolean).join(' · '),
        dot: r.overall === 'done' ? 'done' : r.overall === 'halted' ? 'fail' : 'run',
      })),
    }));
    return renderSideFoot(tree);
  }

  for (const section of tree.sections) side.append(sectionNode(section));
  renderSideFoot(tree);
}

// The pipeline rail: every stage a run has, in order, each a full row (icon,
// name, description, a progress track for its state) — not just the one
// stage being read. Lives inside a run's own tab, so it scales to as many
// open runs as there are tabs, unlike a single sidebar ever could.
function buildStageRail(stages, activeName, onSelect) {
  const rail = el('div', { class: 'rail' });
  for (const stage of stages) {
    const cls = stage.status === 'passed' ? 'is-passed'
      : stage.status === 'running' ? 'is-running'
        : stage.status === 'failed' ? 'is-failed'
          : stage.status === 'skipped' ? 'is-skipped' : 'is-pending';
    rail.append(el('button', {
      class: `rail-row ${cls}${stage.name === activeName ? ' selected' : ''}`,
      title: agentMeta(stage.name).sub,
      onclick: () => onSelect(stage.name),
    }, [
      el('div', { class: 'rail-top' }, [
        el('span', { class: `agent-ico ${stage.name}`, html: stageIcon(stage.name) }),
        el('span', { class: 'rail-nm', text: cap(stage.name) }),
      ]),
      el('div', { class: 'rail-sub', text: agentMeta(stage.name).sub }),
      el('span', { class: 'rail-track' }, el('span', { class: 'rail-bar' })),
    ]));
  }
  return rail;
}

function sectionNode(section) {
  const title = el('div', { class: `side-title${section.key === 'needsDecision' && section.count ? ' attn' : ''}` }, [
    el('span', { text: section.title }),
    section.count ? el('span', { class: 'n', text: String(section.count) }) : null,
  ]);
  const body = section.items.length
    ? section.items.flatMap((item) => [nodeButton(item), ...(item.children || []).map((c) => nodeButton(c, true))])
    : [el('div', { class: 'side-empty', text: section.emptyText })];
  return el('div', { class: 'side-section' }, [title, ...body]);
}

function nodeButton(item, child = false) {
  return el('button', {
    class: `node${child ? ' child' : ''}`,
    title: item.warn || item.label,
    onclick: () => openFor(item),
  }, [
    el('span', { class: `dot ${item.dot}` }),
    el('span', { class: 'label' }, [
      el('b', { text: item.label }),
      item.sub || item.warn ? el('span', { text: item.warn || item.sub }) : null,
    ]),
  ]);
}

function openFor(item) {
  // Empty id is the live single-run (root .pipeline/); keep it falsy so
  // api.state omits ?run= and the server serves the project-root status.
  if (item.kind === 'run') return open({ kind: 'run', subject: item.id || '', title: item.label });
  if (item.kind === 'decision') {
    if (item.featureId && item.level === 'merge') return open({ kind: 'review', subject: item.runId || item.featureId, feature: item.featureId, title: `Review ${item.featureId}` });
    return open({ kind: 'attention', title: 'Attention' });
  }
  if (item.kind === 'feature') {
    if (item.reportRel) return open({ kind: 'report', subject: item.id, file: item.reportRel, title: `${item.id} report` });
    return open({ kind: 'feature', subject: item.id, title: item.label });
  }
}

function renderSideFoot(tree) {
  const foot = $('side-foot');
  foot.replaceChildren();
  if (tree.enabled) {
    foot.append(el('button', {
      class: 'btn ghost', text: tree.paused ? 'Resume pool' : 'Pause pool',
      onclick: async () => {
        try {
          await (tree.paused ? api.resumePool() : api.pausePool('paused from the dashboard'));
          toast(tree.paused ? 'Pool resumed.' : 'Pool paused; running workers finish their current stage.');
          refresh();
        } catch (err) { toast(err.message); }
      },
    }));
  }
}

// ---- tabs -----------------------------------------------------------------

function open(spec) {
  tabs.open(spec);
  syncUrl();
  render();
}

function renderTabs() {
  const strip = $('tabs');
  strip.replaceChildren();
  for (const tab of tabs.list()) {
    const selected = tab.id === tabs.activeId();
    strip.append(el('button', {
      class: 'tab', role: 'tab', 'aria-selected': String(selected),
      onclick: () => { tabs.activate(tab.id); syncUrl(); render(); },
    }, [
      tab.attention ? el('span', { class: `badge ${tab.attention}` }) : null,
      el('span', { class: 't', text: tab.title || tab.id }),
      tab.pinned ? null : el('span', {
        class: 'x', text: '×', title: 'Close',
        onclick: (e) => { e.stopPropagation(); tabs.close(tab.id); syncUrl(); render(); },
      }),
    ]));
  }
}

function syncUrl() {
  const search = state.project ? `?project=${encodeURIComponent(state.project)}` : '';
  history.replaceState(null, '', `${location.pathname}${search}#${tabs.serialize()}`);
}

// ---- panels ---------------------------------------------------------------

// The panel/wrap elements are only recreated when the active tab actually
// changes. A background refresh of the same tab (an SSE event, the 15s
// fallback poll) reuses them, so scroll position survives and the view
// function below decides for itself how much of its own content to disturb
// — most of them only need to touch the one piece of data that changed.
let lastPanelTabId = null;

function render() {
  renderTabs();
  const host = $('panels');
  const tab = tabs.active();
  if (!tab) {
    host.replaceChildren(el('div', { class: 'panel' }, el('div', { class: 'empty', text: 'Nothing open.' })));
    lastPanelTabId = null;
    return;
  }
  let panel = host.querySelector('.panel');
  let wrap = panel?.querySelector('.wrap');
  if (tab.id !== lastPanelTabId || !panel || !wrap) {
    host.replaceChildren();
    panel = el('div', { class: 'panel' });
    wrap = el('div', { class: 'wrap' });
    panel.append(wrap);
    host.append(panel);
    panel.scrollTop = tab.scrollTop || 0;
    panel.addEventListener('scroll', () => { tab.scrollTop = panel.scrollTop; }, { passive: true });
    lastPanelTabId = tab.id;
  }
  panel.classList.toggle('is-run', tab.kind === 'run');
  const view = VIEWS[tab.kind] || VIEWS.home;
  view(wrap, tab);
}

const VIEWS = {
  overview: viewOverview,
  run: viewRun,
  feature: viewFeature,
  review: viewReview,
  attention: viewAttention,
  report: viewReport,
  runs: viewRuns,
  messages: viewMessages,
  reports: viewReports,
};

// The five fixed destinations, always open, always in this order, never
// closable — the plan calls these "clear destinations", not tabs you opened.
const DESTINATIONS = [
  { kind: 'overview', title: 'Overview' },
  { kind: 'runs', title: 'Runs' },
  { kind: 'attention', title: 'Attention' },
  { kind: 'messages', title: 'Messages' },
  { kind: 'reports', title: 'Reports' },
];

function viewOverview(wrap) {
  wrap.replaceChildren();
  const snap = state.pool?.snapshot;
  if (!snap) {
    wrap.append(el('h1', { text: 'Orchestrator' }));
    wrap.append(el('p', { class: 'sub', text: 'No roadmap is running in this project. Open a run from the sidebar, or start one with the orchestrate command.' }));
    return;
  }
  wrap.append(el('h1', { text: snap.roadmap?.title || 'Pool' }));
  wrap.append(el('p', {
    class: 'sub',
    text: `${snap.counts.landed} landed so far`,
  }));

  // Six buckets, each its own thing a person might need to do: work is moving
  // (executing), a host is between checkpoints (awaiting-agent), a human is
  // needed (awaiting-user), nobody is currently driving it (disconnected), it
  // is stuck (blocked), or it has not started (queued). A single "N runs" tally
  // hides which of these is actually true.
  const TILES = [
    { key: 'executing', label: 'Executing', filter: { bucket: 'executing' } },
    { key: 'awaitingAgent', label: 'Awaiting agent', filter: { bucket: 'awaiting-agent' } },
    { key: 'awaitingUser', label: 'Awaiting you', cls: 'warn', dest: 'attention' },
    { key: 'blocked', label: 'Blocked', cls: 'fail', filter: { bucket: 'blocked' } },
    { key: 'disconnected', label: 'Disconnected', cls: 'warn', filter: { bucket: 'disconnected' } },
    // Queued features have no run yet, so there is nothing for the Runs table
    // to filter to — the count here just mirrors the Roadmap list below.
    { key: 'queued', label: 'Queued', dest: null },
  ];
  const grid = el('div', { class: 'stat-grid' });
  for (const t of TILES) {
    const n = snap.counts[t.key] ?? 0;
    const dest = t.dest === null ? null : t.dest || 'runs';
    grid.append(el('button', {
      class: `stat-tile${t.cls && n ? ` ${t.cls}` : ''}`,
      disabled: dest === null,
      onclick: dest ? () => open({ kind: dest, title: dest === 'attention' ? 'Attention' : 'Runs', runsFilter: t.filter || null }) : null,
    }, [el('span', { class: 'n', text: String(n) }), el('span', { class: 'lbl', text: t.label })]));
  }
  wrap.append(grid);

  if (!snap.supervisor.alive) {
    wrap.append(el('div', { class: 'banner fail', html: 'The supervisor is not running, so nothing will advance. Start it with <code>bash .pipeline/orchestrate.sh pool start</code>.' }));
  } else if (snap.supervisor.paused) {
    wrap.append(el('div', { class: 'banner warn', text: 'The pool is paused. Running workers will finish their current stage and stop there.' }));
  }

  for (const skill of snap.skills || []) {
    if (skill.status === 'verified') continue;
    wrap.append(el('div', {
      class: 'banner warn',
      html: `Skill <code>${esc(skill.name)}</code> is not in use (${esc(skill.status)}). Run <code>node pipeline/skills.mjs pin ${esc(skill.name)}</code> after reviewing it.`,
    }));
  }

  if (snap.needsDecision.length) {
    wrap.append(el('h2', { text: 'Needs your decision' }));
    for (const item of snap.needsDecision) wrap.append(decisionCard(item));
  }

  wrap.append(el('h2', { text: 'Roadmap' }));
  for (const feature of snap.roadmap?.features || []) {
    wrap.append(el('div', { class: 'card' }, [
      el('h4', { text: `${feature.id}: ${feature.title}` }),
      el('div', { class: 'meta', text: featureLabel(feature.status) + (feature.pr?.url ? ' · pull request open' : '') }),
      el('div', { class: 'row', style: 'margin-top:8px' }, [
        feature.reportRel ? el('button', { class: 'btn ghost', text: 'Report', onclick: () => open({ kind: 'report', subject: feature.id, file: feature.reportRel, title: `${feature.id} report` }) }) : null,
        feature.runIds?.length ? el('button', { class: 'btn ghost', text: 'Runs', onclick: () => open({ kind: 'feature', subject: feature.id, title: `${feature.id}: ${feature.title}` }) }) : null,
      ]),
    ]));
  }
}

// A feature stuck on 'failed' or 'held' synthesizes its own needsDecision
// item with no real decisionId — its "options" are pool verbs (retry/hold/
// release/skip), not free-text answers, so they get their own explicit
// action buttons rather than routing through the answer-a-decision flow.
const FEATURE_ACTION_KINDS = new Set(['feature-failed', 'held']);

function decisionCard(item) {
  const isFeatureAction = !item.decisionId && item.featureId && FEATURE_ACTION_KINDS.has(item.kind);
  const answer = el('textarea', {
    placeholder: isFeatureAction ? 'Optional reason, recorded with whichever action you pick below.'
      : item.options?.length ? `One of: ${item.options.join(', ')}` : 'Your answer',
  });
  const actions = el('div', { class: 'row', style: 'margin-top:8px' });

  for (const option of item.options || []) {
    actions.append(el('button', {
      class: 'btn ghost', text: option,
      onclick: isFeatureAction
        ? async () => {
          try {
            await api.poolAction(option, item.featureId, answer.value.trim() || undefined);
            toast(`${option} recorded for ${item.featureId}.`);
            refresh();
          } catch (err) { toast(err.message); }
        }
        : () => { answer.value = option; },
    }));
  }
  if (item.decisionId) {
    actions.append(el('button', {
      class: 'btn', text: 'Answer',
      onclick: async () => {
        if (!answer.value.trim()) return toast('Write an answer first.');
        try {
          await api.answerDecision(item.decisionId, answer.value.trim());
          toast('Recorded. The run has been asked to continue.');
          refresh();
        } catch (err) { toast(err.message); }
      },
    }));
  }
  if (item.runId) actions.append(el('button', {
    class: 'btn ghost', text: item.kind === 'claim-run' ? 'Claim / connect' : 'Open run',
    onclick: () => open({ kind: 'run', subject: item.runId, title: item.runId }),
  }));

  return el('div', { class: 'card' }, [
    el('h4', { text: item.question }),
    el('div', { class: 'meta', text: [item.featureId, item.runId, item.kind].filter(Boolean).join(' · ') }),
    item.recommended ? el('div', { class: 'meta', text: `Recommended: ${item.recommended}` }) : null,
    ...(item.artifacts || []).map((a) => el('div', { class: 'meta', html: `<code>${esc(a)}</code>` })),
    item.decisionId || isFeatureAction ? answer
      : item.kind === 'claim-run' ? el('div', { class: 'meta', text: 'Run `pool claim` (or open the run and complete its stage) to pick this up.' })
        : el('div', { class: 'meta', text: 'This needs action elsewhere — see the run.' }),
    actions,
  ]);
}

function viewAttention(wrap) {
  wrap.replaceChildren();
  wrap.append(el('h1', { text: 'Attention' }));
  const items = state.pool?.snapshot?.needsDecision || [];
  if (!items.length) return wrap.append(el('div', { class: 'empty', text: 'Nothing is waiting for you.' }));
  wrap.append(el('p', { class: 'sub', text: 'Every open question and escalation, oldest first. Answering one lets its run continue.' }));
  for (const item of items) wrap.append(decisionCard(item));
}

function viewFeature(wrap, tab) {
  wrap.replaceChildren();
  const feature = state.pool?.snapshot?.roadmap?.features?.find((f) => f.id === tab.subject);
  if (!feature) return wrap.append(el('div', { class: 'empty', text: 'That feature is no longer in the roadmap.' }));
  wrap.append(el('h1', { text: `${feature.id}: ${feature.title}` }));
  wrap.append(el('p', { class: 'sub', text: featureLabel(feature.status) }));
  if (feature.pr?.url) wrap.append(el('p', {}, el('a', { href: feature.pr.url, text: feature.pr.url, target: '_blank', rel: 'noreferrer' })));
  wrap.append(el('h2', { text: 'Runs' }));
  // A run's own directory (status, events, reports) outlives its worktree —
  // cleanup on merge only removes the worktree. So a landed/accepted feature's
  // past attempts still belong here, not just whatever is currently active:
  // `inProgress` alone would make every run vanish from view the moment it
  // finishes, even though its history is still on disk.
  const live = (state.pool?.snapshot?.inProgress || []).filter((r) => r.featureId === feature.id);
  const done = (state.pool?.snapshot?.history || []).filter((r) => r.featureId === feature.id);
  const runs = [...live, ...done];
  if (!runs.length) wrap.append(el('div', { class: 'empty', text: 'No runs recorded for this feature.' }));
  for (const run of runs) {
    wrap.append(el('div', { class: 'card' }, [
      el('h4', { text: run.ticketId || run.kind }),
      el('div', { class: 'meta', text: `${run.overall ?? run.state}${run.stage ? ` · ${run.stage}` : ''}${run.haltReason ? ` · ${run.haltReason}` : ''}` }),
      el('button', { class: 'btn ghost', text: 'Open', onclick: () => open({ kind: 'run', subject: run.runId, title: run.ticketId || run.runId }) }),
    ]));
  }
}

// ---- runs / attention / messages / reports destinations -------------------

function projectRuns() { return allRuns(state.pool?.snapshot, state.runs); }

function viewRuns(wrap, tab) {
  tab.runsFilter = tab.runsFilter || {};
  const f = tab.runsFilter;
  wrap.replaceChildren();
  wrap.append(el('h1', { text: 'Runs' }));
  wrap.append(el('p', { class: 'sub', text: 'Every attempt this project has a record of — including failed, orphaned, and historical runs.' }));

  const runs = projectRuns();
  const features = [...new Set(runs.map((r) => r.featureId).filter(Boolean))].sort();
  const hosts = [...new Set(runs.map((r) => r.runner).filter(Boolean))].sort();

  const filters = el('div', { class: 'filters' });
  const featureSel = el('select', {}, [
    el('option', { value: '', text: 'Any feature' }),
    ...features.map((id) => el('option', { value: id, text: id, selected: f.feature === id })),
  ]);
  featureSel.onchange = () => { f.feature = featureSel.value || null; render(); };
  const hostSel = el('select', {}, [
    el('option', { value: '', text: 'Any host' }),
    ...hosts.map((h) => el('option', { value: h, text: h, selected: f.host === h })),
  ]);
  hostSel.onchange = () => { f.host = hostSel.value || null; render(); };
  const bucketSel = el('select', {}, [
    el('option', { value: '', text: 'Any state' }),
    ...Object.entries(BUCKET_LABEL).map(([v, label]) => el('option', { value: v, text: label, selected: f.bucket === v })),
  ]);
  bucketSel.onchange = () => { f.bucket = bucketSel.value || null; render(); };
  const ageSel = el('select', {}, [
    ['', 'Any age'], ['1', 'Older than 1h'], ['6', 'Older than 6h'], ['24', 'Older than 24h'], ['168', 'Older than 7d'],
  ].map(([v, label]) => el('option', { value: v, text: label, selected: f.olderThanH === v })));
  ageSel.onchange = () => { f.olderThanH = ageSel.value || null; render(); };
  const q = el('input', { type: 'text', placeholder: 'Search run or ticket id…', value: f.q || '' });
  q.oninput = () => { f.q = q.value; render(); };
  filters.append(featureSel, hostSel, bucketSel, ageSel, q);
  if (f.feature || f.host || f.bucket || f.olderThanH || f.q) {
    filters.append(el('button', {
      class: 'btn ghost', text: 'Clear filters',
      onclick: () => { tab.runsFilter = {}; render(); },
    }));
  }
  wrap.append(filters);

  const filtered = filterRuns(runs, f);

  if (!filtered.length) return wrap.append(el('div', { class: 'empty', text: runs.length ? 'No runs match these filters.' : 'No runs recorded yet.' }));

  const table = el('table', { class: 'tbl' }, [
    el('thead', {}, el('tr', {}, ['Run', 'Feature', 'Host', 'State', 'Stage', 'Last activity', 'Age'].map((h) => el('th', { text: h })))),
  ]);
  const tbody = el('tbody');
  for (const r of filtered) {
    const bucket = runBucket(r);
    tbody.append(el('tr', {}, [
      el('td', {}, el('a', { href: '#', text: r.ticketId || r.runId, onclick: (e) => { e.preventDefault(); open({ kind: 'run', subject: r.runId, title: r.ticketId || r.runId }); } })),
      el('td', { text: r.featureId || '—' }),
      el('td', { text: r.runner || '—' }),
      el('td', {}, el('span', { class: `chip${bucket === 'blocked' ? ' fail' : bucket === 'disconnected' ? ' warn' : ''}`, text: BUCKET_LABEL[bucket] || bucket })),
      el('td', { text: r.stage || '—' }),
      el('td', { text: formatAge(ageMs(r.lastOutputAt || r.spawnedAt)) }),
      el('td', { text: formatAge(ageMs(r.spawnedAt)) }),
    ]));
  }
  table.append(tbody);
  wrap.append(table);
}

function viewMessages(wrap, tab) {
  tab._msgFilter = tab._msgFilter || '';
  wrap.replaceChildren();
  wrap.append(el('h1', { text: 'Messages' }));
  wrap.append(el('p', { class: 'sub', text: 'Every operator note sent to an agent through the bridge, and its delivery status.' }));

  const filters = el('div', { class: 'filters' });
  const statusSel = el('select', {}, [
    ['', 'Any status'], ['queued', 'Queued'], ['delivered', 'Delivered'], ['acknowledged', 'Acknowledged'],
    ['addressed', 'Addressed'], ['deferred', 'Deferred'], ['rejected', 'Rejected'],
  ].map(([v, label]) => el('option', { value: v, text: label, selected: tab._msgFilter === v })));
  statusSel.onchange = () => { tab._msgFilter = statusSel.value; renderMessagesBody(); };
  filters.append(statusSel);
  wrap.append(filters);
  const body = el('div', { text: 'Loading…' });
  wrap.append(body);

  function renderMessagesBody() {
    const all = (tab._messages || []).slice().sort((a, b) => (b.sequence || 0) - (a.sequence || 0));
    const filtered = tab._msgFilter ? all.filter((m) => m.status === tab._msgFilter) : all;
    if (!filtered.length) return body.replaceChildren(el('div', { class: 'empty', text: all.length ? 'No messages match this filter.' : 'No messages have been sent yet.' }));
    const table = el('table', { class: 'tbl' }, [
      el('thead', {}, el('tr', {}, ['When', 'Run', 'Stage', 'Priority', 'Status', 'Text', 'Reason'].map((h) => el('th', { text: h })))),
    ]);
    const tbody = el('tbody');
    for (const m of filtered) {
      tbody.append(el('tr', {}, [
        el('td', { text: m.createdAt ? new Date(m.createdAt).toLocaleString() : '—' }),
        el('td', {}, m.runId ? el('a', { href: '#', text: m.runId, onclick: (e) => { e.preventDefault(); open({ kind: 'run', subject: m.runId, title: m.runId }); } }) : el('span', { text: '(root run)' })),
        el('td', { text: m.stage || '—' }),
        el('td', {}, el('span', { class: `chip${m.priority === 'priority' ? ' warn' : ''}`, text: m.priority || 'normal' })),
        el('td', {}, el('span', { class: `chip${['deferred', 'rejected'].includes(m.status) ? ' fail' : m.status === 'addressed' ? ' done' : ''}`, text: m.status })),
        el('td', { text: m.text ? (m.text.length > 140 ? `${m.text.slice(0, 140)}…` : m.text) : '' }),
        el('td', { text: m.reason || '—' }),
      ]));
    }
    table.append(tbody);
    body.replaceChildren(table);
  }

  api.bridge().then((data) => { tab._messages = data.messages || []; renderMessagesBody(); })
    .catch((err) => body.replaceChildren(el('div', { class: 'empty', text: err.message })));
}

function viewReports(wrap) {
  wrap.replaceChildren();
  wrap.append(el('h1', { text: 'Reports' }));
  wrap.append(el('p', { class: 'sub', text: 'Every work-done report this project has produced, run or feature level.' }));

  const snap = state.pool?.snapshot;
  const rows = [];
  for (const f of snap?.roadmap?.features || []) {
    if (f.reportRel) rows.push({ id: f.id, label: `${f.id}: ${f.title}`, kind: 'feature', reportRel: f.reportRel });
  }
  for (const r of projectRuns()) {
    if (r.reportRel && !rows.some((row) => row.reportRel === r.reportRel)) {
      rows.push({ id: r.runId, label: r.ticketId ? `${r.ticketId} (${r.runId})` : r.runId, kind: r.kind || 'run', reportRel: r.reportRel });
    }
  }
  if (!rows.length) return wrap.append(el('div', { class: 'empty', text: 'No reports have been produced yet.' }));

  const table = el('table', { class: 'tbl' }, [
    el('thead', {}, el('tr', {}, ['Report', 'Kind'].map((h) => el('th', { text: h })))),
  ]);
  const tbody = el('tbody');
  for (const row of rows) {
    tbody.append(el('tr', {}, [
      el('td', {}, el('a', {
        href: '#', text: row.label,
        onclick: (e) => { e.preventDefault(); open({ kind: 'report', subject: row.id, file: row.reportRel, title: `${row.id} report` }); },
      })),
      el('td', { text: row.kind }),
    ]));
  }
  table.append(tbody);
  wrap.append(table);
}

// ---- run view -------------------------------------------------------------

// Which artifact each stage is contracted to produce, so a run tab shows the
// output of the stage you are looking at rather than everything at once.
const STAGE_ARTIFACT = {
  planner: 'specs.md',
  designer: 'design.md',
  coder: 'changes.md',
  tester: 'test_suite.md',
  reviewer: 'review_report.md',
  handoff: 'handoff.md',
  reporter: 'reporter.md',
};

async function viewRun(wrap, tab) {
  // Keep the chrome in place across SSE refreshes. Replacing the whole tree
  // is what made a live stream steal the scrollbar and flash the page.
  const firstMount = !wrap.querySelector('.agent-header');
  if (firstMount) wrap.replaceChildren(el('p', { class: 'sub', text: 'Loading…' }));

  tab._fetchGen = (tab._fetchGen || 0) + 1;
  const gen = tab._fetchGen;

  let data;
  try { data = await api.state(tab.subject); }
  catch (err) {
    if (firstMount) wrap.replaceChildren(el('p', { class: 'sub', text: err.message }));
    return;
  }
  if (isStaleRefresh(tab._fetchGen, gen) || tabs.activeId() !== tab.id) return;

  const status = data.status || {};
  const byName = new Map((status.stages || []).map((s) => [s.name, s]));
  const stages = STAGE_ORDER.map((name) => byName.get(name) || { name, status: 'pending' });
  const active = tab.stage
    || status.awaitingStage
    || stages.find((s) => ['running', 'awaiting_host'].includes(s.status))?.name
    || [...stages].reverse().find((s) => ['passed', 'failed', 'blocked', 'interrupted'].includes(s.status))?.name
    || 'planner';
  const meta = agentMeta(active);
  const remount = wrap.dataset.stage !== active || wrap.dataset.subject !== String(tab.subject || '');

  if (firstMount || remount) mountRunChrome(wrap, tab, { status, stages, active, meta, data });
  else patchRunChrome(wrap, tab, { status, stages, active, meta, data });

  const items = conversationItems((data.events || {})[active] || [], data.followups, active);
  paintVirtualFeed(wrap.querySelector('.feed-shell'), items, tab, active);
}

function mountRunChrome(wrap, tab, { status, stages, active, meta, data }) {
  wrap.dataset.stage = active;
  wrap.dataset.subject = String(tab.subject || '');
  wrap.replaceChildren();

  wrap.append(el('div', { class: 'agent-header' }, [
    el('span', { class: `agent-ico ${active}`, html: stageIcon(active) }),
    el('div', {}, [
      el('div', { class: 'nm', text: (tab.title || tab.subject || active).toString() }),
      el('div', { class: 'desc', text: meta.desc }),
    ]),
    el('span', { class: 'spacer' }),
    el('span', { class: `pill ${status.overall || ''}`, 'data-role': 'pill', text: (status.overall || 'no state recorded').replace(/_/g, ' ') }),
  ]));

  const railHost = el('div', { 'data-role': 'rail' });
  railHost.append(buildStageRail(stages, active, (name) => { tab.stage = name; render(); }));
  railHost.dataset.sig = `${active}|${stages.map((s) => `${s.name}:${s.status}`).join(',')}`;
  wrap.append(railHost);

  wrap.append(el('div', { 'data-role': 'goal' }));
  wrap.append(el('div', { 'data-role': 'controls' }));
  wrap.append(el('div', { 'data-role': 'banners' }));
  wrap.append(el('h3', { 'data-role': 'feed-title', text: `${active} activity` }));
  wrap.append(el('div', { class: 'feed-shell' }, el('div', { class: 'feed' })));
  wrap.append(el('div', { 'data-role': 'artifact' }));

  const logDetails = el('details', { class: 'diagnostics' }, [
    el('summary', { text: 'Diagnostics — raw stage log' }),
    el('pre', {}, el('code', { text: 'Open to load the raw stage log.' })),
  ]);
  logDetails.addEventListener('toggle', () => {
    if (!logDetails.open || logDetails.dataset.loaded === wrap.dataset.stage) return;
    const stage = wrap.dataset.stage;
    api.log(stage, tab.subject).then((log) => {
      if (wrap.dataset.stage !== stage) return;
      logDetails.querySelector('code').textContent = log.text || 'No log for this stage.';
      logDetails.dataset.loaded = stage;
    }).catch(() => { logDetails.querySelector('code').textContent = 'No log for this stage.'; });
  });
  wrap.append(logDetails);

  const note = el('textarea', {
    placeholder: `Note for the ${active} stage — it is picked up on the next cycle.`,
    oninput: (e) => { tab._noteDraft = e.target.value; },
  });
  note.value = tab._noteDraft || '';
  wrap.append(el('h3', { text: 'Send a note' }), note, el('div', { class: 'row', style: 'margin-top:8px' }, [
    el('button', {
      class: 'btn', text: 'Send',
      onclick: async () => {
        if (!note.value.trim()) return toast('Write a note first.');
        try {
          await api.followup(wrap.dataset.stage, note.value.trim(), tab.subject);
          note.value = ''; tab._noteDraft = ''; toast('Queued for the agent.');
        } catch (err) { toast(err.message); }
      },
    }),
    el('button', { class: 'btn ghost', text: 'Review this run', onclick: () => open({ kind: 'review', subject: tab.subject, title: `Review ${tab.title || tab.subject}` }) }),
  ]));

  fillGoal(wrap, data.goal);
  fillControls(wrap, tab, data);
  fillBanners(wrap, status);
  fillArtifact(wrap, tab, active, data);
}

function patchRunChrome(wrap, tab, { status, stages, active, meta, data }) {
  const pill = wrap.querySelector('[data-role="pill"]');
  if (pill) {
    const label = (status.overall || 'no state recorded').replace(/_/g, ' ');
    const cls = `pill ${status.overall || ''}`;
    if (pill.className !== cls) pill.className = cls;
    if (pill.textContent !== label) pill.textContent = label;
  }
  const railHost = wrap.querySelector('[data-role="rail"]');
  if (railHost) {
    const railSig = `${active}|${stages.map((s) => `${s.name}:${s.status}`).join(',')}`;
    if (railHost.dataset.sig !== railSig) {
      railHost.dataset.sig = railSig;
      railHost.replaceChildren(buildStageRail(stages, active, (name) => { tab.stage = name; render(); }));
    }
  }
  fillGoal(wrap, data.goal);
  fillControls(wrap, tab, data);
  fillBanners(wrap, status);
  fillArtifact(wrap, tab, active, data);
}

function fillGoal(wrap, goal) {
  const host = wrap.querySelector('[data-role="goal"]');
  if (!host) return;
  const sig = goal ? `${goal.title || ''}|${(goal.dependsOn || []).join(',')}|${goal.nextTitle || ''}|${goal.acceptance || ''}` : '';
  if (host.dataset.sig === sig) return;
  host.dataset.sig = sig;
  host.replaceChildren();
  if (!goal) return;
  const bits = [
    goal.title,
    (goal.dependsOn || []).length ? `depends on ${goal.dependsOn.join(', ')}` : null,
    goal.nextTitle ? `next: ${goal.nextTitle}` : null,
  ].filter(Boolean);
  if (bits.length) host.append(el('p', { class: 'sub', text: bits.join(' · ') }));
  if (goal.acceptance) host.append(el('div', { class: 'meta', text: goal.acceptance }));
}


function fillControls(wrap, tab, data) {
  const host = wrap.querySelector('[data-role="controls"]');
  if (!host) return;
  const sig = [!!data.canCancel, !!data.canResume, !!data.canExtend, !!data.canContinue, data.status?.overall, data.status?.haltReason, !!data.live, !!data.stale].join();
  if (host.dataset.sig === sig) return;
  host.dataset.sig = sig;
  host.replaceChildren();
  const run = tab.subject || undefined;
  const list = el('div', { style: 'margin:2px 0 16px' });

  const row = (available, button, reason) => list.append(el('div', { class: 'row', style: 'margin-bottom:6px;align-items:center' }, [
    button,
    !available && reason ? el('span', { class: 'meta', text: reason }) : null,
  ]));

  row(data.canContinue, el('button', {
    class: 'btn', text: 'Continue', disabled: !data.canContinue,
    onclick: async () => { try { await api.continueRun(false, run); toast('Resuming — the stage you completed will be picked up.'); refresh(); } catch (err) { toast(err.message); } },
  }), unavailableReason('continue', data));

  row(data.canResume, el('button', {
    class: 'btn ghost', text: 'Resume', disabled: !data.canResume,
    onclick: async () => { try { await api.resumeRun(run); toast('Asked the run to resume.'); refresh(); } catch (err) { toast(err.message); } },
  }), unavailableReason('resume', data));

  const cycles = el('input', { type: 'text', value: '5', style: 'width:52px', disabled: !data.canExtend });
  list.append(el('div', { class: 'row', style: 'margin-bottom:6px;align-items:center' }, [
    cycles,
    el('button', {
      class: 'btn ghost', text: 'Extend', disabled: !data.canExtend,
      onclick: async () => { try { await api.extendRun(cycles.value, run); toast('Extended.'); refresh(); } catch (err) { toast(err.message); } },
    }),
    !data.canExtend ? el('span', { class: 'meta', text: unavailableReason('extend', data) }) : null,
  ]));

  row(data.canCancel, el('button', {
    class: 'btn danger', text: 'Stop run', disabled: !data.canCancel,
    onclick: async () => { try { await api.cancelRun(run); toast('Stopping — the current stage will finish first.'); refresh(); } catch (err) { toast(err.message); } },
  }), unavailableReason('cancel', data));

  host.append(list);
}

function fillBanners(wrap, status) {
  const host = wrap.querySelector('[data-role="banners"]');
  if (!host) return;
  const sig = `${status.haltReason || ''}|${status.overall || ''}`;
  if (host.dataset.sig === sig) return;
  host.dataset.sig = sig;
  host.replaceChildren();
  if (status.haltReason) {
    host.append(el('div', { class: 'banner fail', text: `Halted: ${status.haltReason}. ${status.stages?.find((s) => s.detail)?.detail || ''}` }));
  }
  if (status.overall === 'awaiting_plan_approval') {
    host.append(el('div', { class: 'banner warn', text: 'This run is waiting for its plan to be approved. Answer it in Decisions, or read the specification below first.' }));
  }
}

function fillArtifact(wrap, tab, active, data) {
  const host = wrap.querySelector('[data-role="artifact"]');
  if (!host) return;
  const wanted = STAGE_ARTIFACT[active];
  const key = wanted && (data.artifacts || []).includes(wanted) ? `${active}:${wanted}` : '';
  if (host.dataset.key === key) return;
  host.dataset.key = key;
  host.replaceChildren();
  if (!key) return;
  host.append(el('div', { class: 'sec-label', text: `Output — ${wanted}` }));
  const card = el('div', { class: 'artifact-card', text: 'Loading…' });
  host.append(card);
  api.artifact(wanted, tab.subject)
    .then((a) => { if (host.dataset.key === key) card.innerHTML = renderMd(a.content || ''); })
    .catch(() => { if (host.dataset.key === key) card.textContent = 'Could not read this artifact.'; });
}

function paintVirtualFeed(shell, items, tab, stage) {
  if (!shell) return;
  const feed = shell.querySelector('.feed') || shell.appendChild(el('div', { class: 'feed' }));
  shell._feedItems = items;
  shell._feedStage = stage;
  if (!items.length) {
    feed.style.paddingTop = '0px';
    feed.style.paddingBottom = '0px';
    feed.replaceChildren(el('div', { class: 'empty', text: 'Nothing recorded for this stage yet.' }));
    tab._feedSig = '0';
    tab._feedRange = '0:0';
    return;
  }

  tab._heights = tab._heights || {};

  const paint = () => {
    const list = shell._feedItems || [];
    if (!list.length) return;
    const heightKey = `${shell._feedStage}:`;
    const heights = list.map((ev, i) => tab._heights[heightKey + itemKey(ev, i)] || estimateItemHeight(ev));
    const sig = feedSignature(list);
    const range = visibleRange({
      heights,
      scrollTop: shell.scrollTop,
      viewportHeight: shell.clientHeight || 360,
    });
    const rangeKey = `${range.start}:${range.end}:${list.length}`;
    if (tab._feedSig === sig && tab._feedRange === rangeKey) return;
    tab._feedSig = sig;
    tab._feedRange = rangeKey;
    feed.style.paddingTop = `${range.padTop}px`;
    feed.style.paddingBottom = `${range.padBottom}px`;
    feed.replaceChildren();
    for (let i = range.start; i < range.end; i++) feed.append(eventBlock(list[i]));
    requestAnimationFrame(() => {
      if (tab._feedMeasuring) return;
      const nodes = feed.children;
      let dirty = false;
      for (let n = 0; n < nodes.length; n++) {
        const i = range.start + n;
        if (!list[i]) continue;
        const measured = nodes[n].offsetHeight + FEED_GAP;
        if (measured <= FEED_GAP) continue;
        const key = heightKey + itemKey(list[i], i);
        if (Math.abs((tab._heights[key] || heights[i]) - measured) > 8) {
          tab._heights[key] = measured;
          dirty = true;
        }
      }
      if (dirty) {
        tab._feedMeasuring = true;
        tab._feedRange = '';
        paint();
        tab._feedMeasuring = false;
        if (tab._feedPinned !== false) shell.scrollTop = shell.scrollHeight;
      }
    });
  };

  shell._paintFeed = paint;
  if (!shell._feedBound) {
    shell._feedBound = true;
    shell.addEventListener('scroll', () => {
      if (shell._pinning) return;
      tab._feedPinned = isNearBottom(shell.scrollTop, shell.scrollHeight, shell.clientHeight);
      tab.feedScrollTop = shell.scrollTop;
      tab._feedRange = '';
      shell._paintFeed?.();
    }, { passive: true });
  }

  paint();
  if (tab._feedPinned !== false) {
    shell._pinning = true;
    shell.scrollTop = shell.scrollHeight;
    shell._pinning = false;
  } else if (tab.feedScrollTop != null) {
    shell._pinning = true;
    shell.scrollTop = tab.feedScrollTop;
    shell._pinning = false;
  }
}

function eventBlock(ev) {
  const d = describeEvent(ev);
  const node = el('div', { class: d.className });
  if (d.role) node.append(el('span', { class: 'role', text: d.role }));
  if (d.markdown) node.insertAdjacentHTML('beforeend', renderMd(d.text || ''));
  else if (d.text) node.append(document.createTextNode(d.text));
  if (d.noteStatus) node.append(el('div', { class: 'note-state', text: d.noteStatus }));
  return node;
}

// ---- review view ----------------------------------------------------------

async function viewReview(wrap, tab) {
  wrap.replaceChildren();
  wrap.append(el('h1', { text: tab.title || `Review ${tab.subject}` }));
  const sub = el('p', { class: 'sub', text: 'Loading…' });
  wrap.append(sub);
  const body = el('div');
  wrap.append(body);

  let data;
  try { data = await api.state(tab.subject); } catch (err) { sub.textContent = err.message; return; }
  if (tabs.activeId() !== tab.id) return;
  const status = data.status || {};
  const feature = tab.feature || status.featureId;
  sub.textContent = [status.verdict ? `verdict ${status.verdict}` : null, feature, status.branch].filter(Boolean).join(' · ');

  const present = new Set(data.artifacts || []);
  // Every review lens the panel produced, then the tests, then the diff — the
  // order someone actually reviews in: verdict first, evidence after.
  const sections = [
    ['review_report.md', 'Review'],
    ['review_correctness.md', 'Correctness'],
    ['review_security.md', 'Security'],
    ['review_architecture.md', 'Architecture'],
    ['test_suite.md', 'Tests'],
  ].filter(([name]) => present.has(name));

  for (const [name, heading] of sections) {
    body.append(el('h2', { text: heading }));
    const card = el('div', { class: 'card', text: 'Loading…' });
    body.append(card);
    api.artifact(name, tab.subject)
      .then((a) => { card.innerHTML = renderMd(a.content || ''); })
      .catch(() => { card.textContent = `Could not read ${name}.`; });
  }
  if (present.has('diff.patch')) {
    body.append(el('h2', { text: 'Diff' }));
    const holder = el('div', { text: 'Loading…' });
    body.append(holder);
    api.artifact('diff.patch', tab.subject)
      .then((a) => { holder.innerHTML = renderDiff(a.content || ''); })
      .catch(() => { holder.textContent = 'Could not read the diff.'; });
  }
  if (!sections.length && !present.has('diff.patch')) {
    body.append(el('div', { class: 'empty', text: 'This run has no review to show yet.' }));
  }

  // The decision this review exists to support.
  const pending = (state.pool?.snapshot?.needsDecision || []).find((d) => d.featureId === feature && d.kind === 'merge-approval');
  if (feature) {
    const changes = el('textarea', { placeholder: 'What should change? This goes to the coder and reopens review.' });
    body.append(el('h2', { text: 'Decision' }));
    body.append(el('div', { class: 'card' }, [
      el('div', { class: 'meta', text: pending ? pending.question : `Feature ${feature}` }),
      changes,
      el('div', { class: 'row', style: 'margin-top:8px' }, [
        el('button', {
          class: 'btn', text: 'Approve merge', disabled: !pending,
          onclick: async () => {
            try { await api.approveMerge(feature); toast('Approved. The supervisor verifies it is still mergeable before merging.'); refresh(); }
            catch (err) { toast(err.message); }
          },
        }),
        el('button', {
          class: 'btn ghost', text: 'Request changes',
          onclick: async () => {
            if (!changes.value.trim()) return toast('Say what should change first.');
            try { await api.requestChanges(feature, changes.value.trim()); toast('Sent to the coder.'); refresh(); }
            catch (err) { toast(err.message); }
          },
        }),
      ]),
      pending ? null : el('div', { class: 'meta', style: 'margin-top:6px', text: 'Approving is available once the feature is reviewed and waiting for you.' }),
    ]));
  }
}

// ---- report view ----------------------------------------------------------

function viewReport(wrap, tab) {
  // An iframe must never be torn down and recreated on a background refresh
  // — that reloads it, discarding whatever state the report itself holds.
  // Its content is static once generated, so build it once and leave it.
  if (wrap.querySelector('iframe.report')) return;
  wrap.replaceChildren();
  wrap.append(el('h1', { text: tab.title || 'Report' }));
  // A roadmap records a repo-relative path (`.pipeline/runs/<runId>/reports/<file>`);
  // the endpoint wants the run id and the file relative to that run's reports
  // dir, so its root survives the run's worktree being cleaned up after landing
  // — a run's own directory (and its reports) are never removed, only its
  // worktree is.
  const runReport = /^\.pipeline\/runs\/([^/]+)\/reports\/(.+)$/.exec(tab.file || '');
  const params = runReport
    ? { run: runReport[1], file: runReport[2] }
    : { feature: tab.subject, file: tab.file || 'work-done.html' };
  const src = api.reportUrl(params);
  wrap.append(el('p', { class: 'sub' }, el('a', { href: src, target: '_blank', rel: 'noreferrer', text: 'Open in a new tab' })));
  // Sandboxed without same-origin: a report may run its own scripts to be
  // interactive, but can never read this page or call the API.
  wrap.append(el('iframe', { class: 'report', src, sandbox: 'allow-scripts', referrerpolicy: 'no-referrer', title: 'Work-done report' }));
}

// ---- data -----------------------------------------------------------------

async function refresh() {
  // A project switch mid-flight must not let a slow fetch from the OLD
  // project land after a faster one from the new project and clobber it.
  state.refreshGen = (state.refreshGen || 0) + 1;
  const gen = state.refreshGen;
  const project = state.project;

  try {
    const [pool, runs] = await Promise.all([api.pool(), api.runs()]);
    if (gen !== state.refreshGen || project !== state.project) return;
    state.pool = pool.enabled ? pool : null;
    state.runs = runs.runs || [];
    state.degraded = false;
    state.lastGoodAt = Date.now();
  } catch (err) {
    if (gen !== state.refreshGen || project !== state.project) return;
    // Keep the last good view on screen rather than blanking the page; only
    // the degraded indicator changes, so whatever tab is open stays exactly
    // as it was.
    state.degraded = true;
    state.degradedError = err.message;
  }
  renderDegraded();

  // Badge the tabs whose runs need someone, without stealing focus.
  const attention = attentionByRun(state.pool?.snapshot ?? null);
  for (const [runId, level] of attention) tabs.markAttention(runId, level, { seq: ++state.seq });

  const decisions = state.pool?.snapshot?.counts?.decisions ?? 0;
  document.title = decisions ? `(${decisions}) Orchestrator` : 'Orchestrator';
  const poolChip = $('pool-state');
  if (state.pool) {
    const s = state.pool.snapshot.supervisor;
    poolChip.hidden = false;
    poolChip.textContent = !s.alive ? 'supervisor stopped' : s.paused ? 'paused' : `${state.pool.snapshot.counts.inProgress} running`;
    poolChip.className = `chip ${!s.alive ? 'fail' : s.paused ? 'warn' : ''}`;
  } else poolChip.hidden = true;

  const totals = $('totals');
  const cost = state.pool?.snapshot?.totals?.costUsd;
  if (cost) { totals.hidden = false; totals.textContent = `$${cost.toFixed(2)}`; } else totals.hidden = true;

  $('live-dot').className = `dot${state.pool?.snapshot?.supervisor?.alive ? '' : ' idle'}`;
  renderSidebar();
  render();
}

// A run writing output can fire several file-change events a second; a
// refresh per event would re-render that often. Coalesce a burst into one
// refresh shortly after it quiets down instead.
let refreshTimer = null;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 350);
}

function connect() {
  if (state.sse) state.sse.close();
  const source = new EventSource(`/events?project=${encodeURIComponent(state.project)}`);
  source.onmessage = (message) => {
    try {
      const data = JSON.parse(message.data);
      if (data.type === 'change') scheduleRefresh();
    } catch { /* a malformed frame is not worth breaking the page over */ }
  };
  source.onerror = () => { /* EventSource retries on its own */ };
  state.sse = source;
}

async function initProjects() {
  try {
    const { projects } = await api.projects();
    state.projects = projects || [];
    if (!state.project && state.projects.length) state.project = state.projects[0].repoRoot;
    const select = $('project');
    select.replaceChildren();
    for (const project of state.projects) {
      select.append(el('option', { value: project.repoRoot, text: project.name || project.repoRoot, selected: project.repoRoot === state.project }));
    }
    select.hidden = state.projects.length < 2;
    select.onchange = () => { state.project = select.value; connect(); refresh(); };
  } catch { $('project').hidden = true; }
}

// ---- keyboard -------------------------------------------------------------

const SHORTCUTS = [
  ['[ / ]', 'previous / next tab'],
  ['x', 'close tab'],
  ['g o', 'overview'], ['g r', 'runs'], ['g a', 'attention'], ['g m', 'messages'], ['g p', 'reports'],
  ['?', 'this list'],
];
const DESTINATION_KEYS = { o: 'overview', r: 'runs', a: 'attention', m: 'messages', p: 'reports' };

function onKey(event) {
  const target = event.target;
  if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key === '[') { tabs.move(-1); syncUrl(); render(); }
  else if (event.key === ']') { tabs.move(1); syncUrl(); render(); }
  else if (event.key === 'x') { const t = tabs.active(); if (t) { tabs.close(t.id); syncUrl(); render(); } }
  else if (event.key === '?') showHelp();
  else if (event.key === 'g') {
    const next = (e2) => {
      document.removeEventListener('keydown', next, true);
      const kind = DESTINATION_KEYS[e2.key];
      if (kind) open({ kind, title: DESTINATIONS.find((d) => d.kind === kind)?.title || kind });
    };
    document.addEventListener('keydown', next, true);
  }
}

function showHelp() {
  toast(SHORTCUTS.map(([k, v]) => `${k}: ${v}`).join('   ·   '));
}

// ---- boot -----------------------------------------------------------------

function initResize() {
  const handle = $('resize');
  let dragging = false;
  handle.addEventListener('mousedown', () => { dragging = true; document.body.style.userSelect = 'none'; });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.userSelect = '';
    try { localStorage.setItem('orchestrator-sidebar-w', String(parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w'), 10))); } catch {}
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const width = Math.max(220, Math.min(440, e.clientX));
    document.documentElement.style.setProperty('--sidebar-w', `${width}px`);
  });
}

async function boot() {
  $('theme').onclick = () => {
    const order = ['system', 'light', 'dark'];
    setTheme(order[(order.indexOf(currentTheme()) + 1) % order.length]);
  };
  $('help').onclick = showHelp;
  document.addEventListener('keydown', onKey, true);
  initResize();

  await initProjects();
  let restoredActive = null;
  if (location.hash.includes('tabs=')) {
    // A restored tab has no live data yet, so its label comes from what it is.
    tabs.restore(location.hash, {
      titleFor: (spec) => (spec.kind === 'review' ? `Review ${spec.subject}`
        : spec.kind === 'report' ? `${spec.subject} report`
          : DESTINATIONS.find((d) => d.kind === spec.kind)?.title || spec.subject || spec.kind),
    });
    restoredActive = tabs.activeId();
  }
  // The five destinations are always open, in this fixed order, and never
  // closable — restoring an older saved workspace (or a first boot) must not
  // leave one of them missing. Opening one activates it, so the deliberate
  // tab the hash asked for (if any) is restored as active afterward.
  for (const dest of DESTINATIONS) tabs.open({ ...dest, pinned: true });
  tabs.activate((restoredActive && tabs.get(restoredActive)) ? restoredActive : 'overview');
  connect();
  await refresh();
  // A slow fallback: the watcher is the primary signal, this only covers a
  // dropped stream.
  setInterval(refresh, 15000);
}

boot();
