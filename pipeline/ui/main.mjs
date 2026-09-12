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
import { stageIcon, agentMeta, skipReason, STAGE_ORDER } from './stages.mjs';
import {
  describeEvent, isStaleRefresh, conversationItems, estimateItemHeight,
  visibleRange, isNearBottom, itemKey, feedSignature, FEED_GAP,
} from './feed.mjs';
import { runBucket, BUCKET_LABEL, ageMs, formatAge, allRuns, filterRuns, hostLabel } from './runs.mjs';
import { unavailableReason } from './actions.mjs';
import { patchRegion, patchList } from './patch.mjs';

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
  const tree = buildTree(state.pool?.snapshot ?? null, state.runs);

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
function buildStageRail(stages, activeName, onSelect, status) {
  const rail = el('div', { class: 'rail' });
  for (const stage of stages) {
    const cls = stage.status === 'passed' ? 'is-passed'
      : stage.status === 'running' ? 'is-running'
        : stage.status === 'failed' ? 'is-failed'
          : stage.status === 'skipped' ? 'is-skipped' : 'is-pending';
    // A pending stage has not been reached yet — clicking it would only show
    // "nothing recorded," so the row is disabled rather than clickable, with
    // the reason as its title instead of the stage's usual description.
    const notReached = stage.status === 'pending';
    const reason = stage.status === 'skipped' ? skipReason(stage, status) : null;
    rail.append(el('button', {
      class: `rail-row ${cls}${stage.name === activeName ? ' selected' : ''}`,
      title: notReached ? 'This stage hasn\'t started yet.' : (reason || agentMeta(stage.name).sub),
      disabled: notReached,
      onclick: () => onSelect(stage.name),
    }, [
      el('div', { class: 'rail-top' }, [
        el('span', { class: `agent-ico ${stage.name}`, html: stageIcon(stage.name) }),
        el('span', { class: 'rail-nm', text: cap(stage.name) }),
      ]),
      el('div', { class: 'rail-sub', text: reason || agentMeta(stage.name).sub }),
      el('span', { class: 'rail-track' }, el('span', { class: 'rail-bar' })),
      stage.status === 'running' && stage.startedAt
        ? el('span', { class: 'rail-elapsed', text: `running ${formatAge(ageMs(stage.startedAt))}` }) : null,
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

// Fixed nav — the five destinations — in a strip of its own, separate from
// whatever you opened. Rendered in DESTINATIONS' own canonical order rather
// than tabs.list()'s array order, since a restored hash can interleave a
// destination anywhere among dynamic tabs.
function renderDestinations() {
  const strip = $('destinations');
  strip.replaceChildren();
  for (const dest of DESTINATIONS) {
    const tab = tabs.get(dest.kind);
    if (!tab) continue; // boot() guarantees all five exist before the first render
    const selected = tab.id === tabs.activeId();
    strip.append(el('button', {
      class: 'dest', role: 'tab', 'aria-selected': String(selected),
      onclick: () => { tabs.activate(tab.id); syncUrl(); render(); },
    }, [
      el('span', { class: 't', text: tab.title || tab.id }),
      tab.badgeCount ? el('span', { class: 'n', text: String(tab.badgeCount) }) : null,
    ]));
  }
}

// A small kind glyph so an open tab's type is scannable before reading its
// title. review/report reuse stageIcon's existing reviewer/reporter glyphs —
// a literal fit for what those tabs are, not a repurposing of stage identity.
const TAB_KIND_ICON = {
  run: '<svg class="ic" viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-3-6.7"/><polyline points="21 3 21 9 15 9"/></svg>',
  feature: '<svg class="ic" viewBox="0 0 24 24"><polygon points="12 3 21 8 12 13 3 8"/><polyline points="3 14 12 19 21 14"/></svg>',
  review: stageIcon('reviewer'),
  report: stageIcon('reporter'),
};

// Everything you opened — a run, feature, review, or report — separate from
// the destinations above it. These are the ones that can be closed.
function renderTabs() {
  const strip = $('tabs');
  strip.replaceChildren();
  const open = tabs.list().filter((t) => !t.pinned);
  if (!open.length) {
    strip.append(el('span', { class: 'tabstrip-empty', text: 'No open tabs — open a run, feature, review, or report to see it here.' }));
    return;
  }
  for (const tab of open) {
    const selected = tab.id === tabs.activeId();
    strip.append(el('button', {
      class: 'tab', role: 'tab', 'aria-selected': String(selected),
      onclick: () => { tabs.activate(tab.id); syncUrl(); render(); },
    }, [
      TAB_KIND_ICON[tab.kind] ? el('span', { html: TAB_KIND_ICON[tab.kind] }) : null,
      tab.attention ? el('span', { class: `badge ${tab.attention}` }) : null,
      el('span', { class: 't', text: tab.title || tab.id }),
      // Reserved for a per-run mode indicator (chat/live vs. cli/unattended,
      // see main.mjs's fillMode) — not built here; the full version already
      // lives in the run's own tab header.
      tab.badgeCount ? el('span', { class: 'n', text: String(tab.badgeCount) }) : null,
      el('span', {
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
  renderDestinations();
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
  const view = VIEWS[tab.kind] || VIEWS.unknown;
  // A bug in any one view must not freeze the whole dashboard for this
  // browser tab — render an inline failure in its place instead of letting
  // the exception propagate up through refresh()/boot(), which have no
  // try/catch of their own around this call.
  try { view(wrap, tab); }
  catch (err) {
    console.error(`[dashboard] "${tab.kind}" view failed:`, err);
    wrap.replaceChildren(el('div', { class: 'empty' }, [
      el('p', { text: 'This tab hit an error and could not be shown.' }),
      el('p', { class: 'sub', text: err.message }),
      el('button', { class: 'btn ghost', text: 'Close tab', onclick: () => { tabs.close(tab.id); syncUrl(); render(); } }),
    ]));
  }
}

function viewUnknown(wrap, tab) {
  wrap.replaceChildren(el('div', { class: 'empty' }, [
    el('p', { text: 'This tab type isn\'t supported by this version of the dashboard.' }),
    el('p', { class: 'sub', text: `kind: ${tab.kind}` }),
    el('button', { class: 'btn ghost', text: 'Close tab', onclick: () => { tabs.close(tab.id); syncUrl(); render(); } }),
  ]));
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
  unknown: viewUnknown,
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

// The six overview stat tiles. Module-level so both viewOverview and its
// signature computation share one definition.
const OVERVIEW_TILES = [
  { key: 'executing', label: 'Executing', filter: { bucket: 'executing' } },
  { key: 'awaitingAgent', label: 'Awaiting agent', filter: { bucket: 'awaiting-agent' } },
  { key: 'awaitingUser', label: 'Awaiting you', cls: 'warn', dest: 'attention' },
  { key: 'blocked', label: 'Blocked', cls: 'fail', filter: { bucket: 'blocked' } },
  { key: 'disconnected', label: 'Disconnected', cls: 'warn', filter: { bucket: 'disconnected' } },
  // Queued features have no run yet, so there is nothing for the Runs table
  // to filter to — the count here just mirrors the Roadmap list below.
  { key: 'queued', label: 'Queued', dest: null },
];

// A decision's identity and "what would render" signature, shared by Overview
// and Attention so patching one list keeps both consistent — see pool-tree.mjs
// for the same decisionId-or-kind:featureId/runId scheme used in the sidebar.
function decisionKey(d) { return d.decisionId ?? `${d.kind}:${d.featureId ?? d.runId ?? ''}`; }
function decisionSig(d) { return JSON.stringify([d.question, d.options, d.recommended, d.artifacts, d.decisionId]); }

// Status lanes for Overview's Roadmap section — the same vocabulary
// pool-tree.mjs's FEATURE_DOT/FEATURE_LABEL already classify each feature
// into, grouped into the five questions an operator actually asks at a
// glance: what hasn't started, what's being built, what's waiting on review,
// what's done, and what needs intervention.
const ROADMAP_LANES = [
  { key: 'queued', title: 'Queued', statuses: ['queued'] },
  { key: 'building', title: 'Building', statuses: ['planning', 'awaiting_plan_approval', 'executing', 'integrating'] },
  { key: 'review', title: 'In review', statuses: ['reviewing', 'awaiting_merge_approval', 'merge_approved', 'merging'] },
  { key: 'landed', title: 'Landed', statuses: ['accepted', 'landed', 'skipped'] },
  { key: 'failed', title: 'Failed or held', statuses: ['failed', 'held'] },
];

function featureCard(feature) {
  const depLine = (feature.dependsOn || []).length ? `depends on ${feature.dependsOn.join(', ')}` : null;
  return el('div', { class: 'card' }, [
    el('h4', { text: `${feature.id}: ${feature.title}` }),
    el('div', { class: 'meta', text: featureLabel(feature.status) + (feature.pr?.url ? ' · pull request open' : '') }),
    depLine ? el('div', { class: 'meta', text: depLine }) : null,
    el('div', { class: 'row', style: 'margin-top:8px' }, [
      feature.reportRel ? el('button', { class: 'btn ghost', text: 'Report', onclick: () => open({ kind: 'report', subject: feature.id, file: feature.reportRel, title: `${feature.id} report` }) }) : null,
      el('button', { class: 'btn ghost', text: 'Open', onclick: () => open({ kind: 'feature', subject: feature.id, title: `${feature.id}: ${feature.title}` }) }),
    ]),
  ]);
}

// Flattens the lane grouping into one ordered list patchList can reconcile: a
// lane heading (re-rendered only if the lane's title changes, i.e. never) and
// one row per feature, keyed by feature.id so an unrelated feature changing
// elsewhere in the roadmap does not recreate this one's card.
function roadmapRows(features) {
  const rows = [];
  for (const lane of ROADMAP_LANES) {
    const inLane = features.filter((f) => lane.statuses.includes(f.status));
    if (!inLane.length) continue;
    rows.push({ key: `lane:${lane.key}`, sig: lane.title, render: () => el('h3', { class: 'lane-title', text: lane.title }) });
    for (const feature of inLane) {
      rows.push({
        key: feature.id,
        sig: JSON.stringify([feature.status, feature.pr?.url, feature.reportRel, feature.dependsOn]),
        render: () => featureCard(feature),
      });
    }
  }
  return rows;
}

// Patches a persistent decisions-list container against `items` — the shared
// fix behind both Overview and Attention: a decision an operator is mid-typing
// an answer into keeps its exact DOM node (and that typed text) across any
// unrelated background refresh, instead of being torn down and rebuilt.
function renderDecisionList(host, items) {
  patchList(host, items, { key: decisionKey, sig: decisionSig, render: decisionCard });
}

function viewOverview(wrap) {
  const snap = state.pool?.snapshot;
  if (!snap) {
    if (wrap.dataset.view !== 'overview-empty') {
      wrap.dataset.view = 'overview-empty';
      wrap.replaceChildren();
      wrap.append(el('h1', { text: 'Orchestrator' }));
      wrap.append(el('p', { class: 'sub', text: 'No roadmap is running in this project. Open a run from the sidebar, or start one with the orchestrate command.' }));
    }
    return;
  }

  // Mount the static shell once; every call below only patches the region
  // whose own signature actually changed — so a decision card mid-typed-into
  // (or, once Phase 4 lands, a roadmap card) survives a background refresh
  // that touches an unrelated part of the page.
  if (wrap.dataset.view !== 'overview-pool') {
    wrap.dataset.view = 'overview-pool';
    wrap.replaceChildren();
    wrap.append(el('h1', { 'data-role': 'title' }));
    wrap.append(el('p', { class: 'sub', 'data-role': 'sub' }));
    wrap.append(el('div', { 'data-role': 'tiles' }));
    wrap.append(el('div', { 'data-role': 'banners' }));
    wrap.append(el('h2', { text: 'Needs your decision', 'data-role': 'decisions-heading' }));
    wrap.append(el('div', { 'data-role': 'decisions' }));
    wrap.append(el('h2', { text: 'Roadmap' }));
    wrap.append(el('div', { 'data-role': 'roadmap' }));
  }

  const title = snap.roadmap?.title || 'Pool';
  const titleEl = wrap.querySelector('[data-role="title"]');
  if (titleEl.textContent !== title) titleEl.textContent = title;

  patchRegion(wrap.querySelector('[data-role="sub"]'), String(snap.counts.landed), (h) => {
    h.textContent = `${snap.counts.landed} landed so far`;
  });

  // Six buckets, each its own thing a person might need to do: work is moving
  // (executing), a host is between checkpoints (awaiting-agent), a human is
  // needed (awaiting-user), nobody is currently driving it (disconnected), it
  // is stuck (blocked), or it has not started (queued). A single "N runs" tally
  // hides which of these is actually true.
  const tileCounts = OVERVIEW_TILES.map((t) => snap.counts[t.key] ?? 0);
  patchRegion(wrap.querySelector('[data-role="tiles"]'), JSON.stringify(tileCounts), (h) => {
    h.className = 'stat-grid';
    OVERVIEW_TILES.forEach((t, i) => {
      const n = tileCounts[i];
      const dest = t.dest === null ? null : t.dest || 'runs';
      h.append(el('button', {
        class: `stat-tile${t.cls && n ? ` ${t.cls}` : ''}`,
        disabled: dest === null,
        onclick: dest ? () => open({ kind: dest, title: dest === 'attention' ? 'Attention' : 'Runs', runsFilter: t.filter || null }) : null,
      }, [el('span', { class: 'n', text: String(n) }), el('span', { class: 'lbl', text: t.label })]));
    });
  });

  const nonVerifiedSkills = (snap.skills || []).filter((s) => s.status !== 'verified');
  const bannerSig = JSON.stringify([snap.supervisor.alive, snap.supervisor.paused, nonVerifiedSkills]);
  patchRegion(wrap.querySelector('[data-role="banners"]'), bannerSig, (h) => {
    if (!snap.supervisor.alive) {
      h.append(el('div', { class: 'banner fail', html: 'The supervisor is not running, so nothing will advance. Start it with <code>bash .pipeline/orchestrate.sh pool start</code>.' }));
    } else if (snap.supervisor.paused) {
      h.append(el('div', { class: 'banner warn', text: 'The pool is paused. Running workers will finish their current stage and stop there.' }));
    }
    for (const skill of nonVerifiedSkills) {
      h.append(el('div', {
        class: 'banner warn',
        html: `Skill <code>${esc(skill.name)}</code> is not in use (${esc(skill.status)}). Run <code>node pipeline/skills.mjs pin ${esc(skill.name)}</code> after reviewing it.`,
      }));
    }
  });

  wrap.querySelector('[data-role="decisions-heading"]').hidden = !snap.needsDecision.length;
  renderDecisionList(wrap.querySelector('[data-role="decisions"]'), snap.needsDecision);

  patchList(wrap.querySelector('[data-role="roadmap"]'), roadmapRows(snap.roadmap?.features || []), {
    key: (row) => row.key,
    sig: (row) => row.sig,
    render: (row) => row.render(),
  });
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
  if (item.runId) {
    actions.append(el('button', {
      class: 'btn ghost', text: item.kind === 'claim-run' ? 'Claim / connect' : 'Open run',
      onclick: () => open({ kind: 'run', subject: item.runId, title: item.runId }),
    }));
    if (['dead', 'unknown', 'stale', 'halted', 'feature-failed'].includes(item.kind) || !item.decisionId) {
      actions.append(el('button', {
        class: 'btn ghost danger', text: 'Dismiss',
        onclick: async () => {
          try {
            await api.dismissRun(item.runId, 'Dismissed from dashboard');
            toast('Run dismissed.');
            refresh();
          } catch (err) { toast(err.message); }
        },
      }));
    }
  }

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
  if (!wrap.querySelector('[data-role="decisions"]')) {
    wrap.replaceChildren();
    wrap.append(el('h1', { text: 'Attention' }));
    wrap.append(el('p', { class: 'sub', 'data-role': 'sub' }));
    wrap.append(el('div', { class: 'empty', 'data-role': 'empty', text: 'Nothing is waiting for you.' }));
    wrap.append(el('div', { 'data-role': 'decisions' }));
  }
  const items = state.pool?.snapshot?.needsDecision || [];
  wrap.querySelector('[data-role="sub"]').hidden = !items.length;
  wrap.querySelector('[data-role="sub"]').textContent = 'Every open question and escalation, oldest first. Answering one lets its run continue.';
  wrap.querySelector('[data-role="empty"]').hidden = !!items.length;
  renderDecisionList(wrap.querySelector('[data-role="decisions"]'), items);
}

function viewFeature(wrap, tab) {
  wrap.replaceChildren();
  const feature = state.pool?.snapshot?.roadmap?.features?.find((f) => f.id === tab.subject);
  if (!feature) return wrap.append(el('div', { class: 'empty', text: 'That feature is no longer in the roadmap.' }));
  wrap.append(el('h1', { text: `${feature.id}: ${feature.title}` }));
  wrap.append(el('p', { class: 'sub', text: featureLabel(feature.status) }));
  if (feature.pr?.url) wrap.append(el('p', {}, el('a', { href: feature.pr.url, text: feature.pr.url, target: '_blank', rel: 'noreferrer' })));

  // "Roadmap" names the whole multi-feature structure; "Plan" is this one
  // feature's specs.md — distinct, non-overlapping referents. Cached on the
  // tab by specRunId so a background refresh (SSE event, 15s poll) neither
  // re-fetches nor flashes "Loading…" over content already shown.
  wrap.append(el('h2', { text: 'Plan' }));
  const planCard = el('div', { class: 'card' });
  wrap.append(planCard);
  if (!feature.specRunId) {
    planCard.textContent = 'No plan has been written for this feature yet.';
  } else if (tab._planRunId === feature.specRunId && tab._planContent != null) {
    planCard.innerHTML = tab._planContent;
  } else {
    planCard.textContent = 'Loading…';
    const runId = feature.specRunId;
    api.artifact('specs.md', runId).then((a) => {
      const html = renderMd(a.content || '');
      tab._planRunId = runId;
      tab._planContent = html;
      if (tabs.activeId() === tab.id && tab.subject === feature.id) planCard.innerHTML = html;
    }).catch(() => {
      if (tabs.activeId() === tab.id) planCard.textContent = 'Could not read this plan.';
    });
  }

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
  const runs = projectRuns();
  const features = [...new Set(runs.map((r) => r.featureId).filter(Boolean))].sort();
  const hosts = [...new Set(runs.map((r) => r.runner).filter(Boolean))].sort();

  const signature = JSON.stringify([features, hosts]);
  if (tab._runsView?.wrap === wrap && tab._runsView.signature === signature) {
    tab._runsView.update();
    return;
  }
  wrap.replaceChildren();
  wrap.append(el('h1', { text: 'Runs' }));
  wrap.append(el('p', { class: 'sub', text: 'Every attempt this project has a record of — including failed, orphaned, and historical runs.' }));
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
  q.oninput = () => { f.q = q.value; updateResults(); };
  filters.append(featureSel, hostSel, bucketSel, ageSel, q);
  const clear = el('button', {
    class: 'btn ghost', text: 'Clear filters',
    onclick: () => { tab.runsFilter = {}; tab._runsView = null; render(); },
  });
  filters.append(clear);
  wrap.append(filters);
  const results = el('div');
  wrap.append(results);
  tab._runsView = { wrap, signature, update: updateResults };
  updateResults();

  function updateResults() {
    clear.hidden = !(f.feature || f.host || f.bucket || f.olderThanH || f.q);
    results.replaceChildren();
    const current = projectRuns();
    const filtered = filterRuns(current, f);
    if (!filtered.length) return results.append(el('div', { class: 'empty', text: current.length ? 'No runs match these filters.' : 'No runs recorded yet.' }));

    const table = el('table', { class: 'tbl' }, [
      el('thead', {}, el('tr', {}, ['Run', 'Feature', 'Host', 'State', 'Stage', 'Last activity', 'Age'].map((h) => el('th', { text: h })))),
    ]);
    const tbody = el('tbody');
    for (const r of filtered) {
      const bucket = runBucket(r);
      tbody.append(el('tr', {}, [
        el('td', {}, el('a', { href: '#', text: r.ticketId || r.runId, onclick: (e) => { e.preventDefault(); open({ kind: 'run', subject: r.runId, title: r.ticketId || r.runId }); } })),
        el('td', { text: r.featureId || '—' }),
        el('td', { text: hostLabel(r) }),
        el('td', {}, el('span', { class: `chip${bucket === 'blocked' ? ' fail' : bucket === 'disconnected' ? ' warn' : ''}`, text: BUCKET_LABEL[bucket] || bucket })),
        el('td', { text: r.stage || '—' }),
        el('td', { text: formatAge(ageMs(r.lastOutputAt || r.spawnedAt)) }),
        el('td', { text: formatAge(ageMs(r.spawnedAt)) }),
      ]));
    }
    table.append(tbody);
    results.append(table);
  }
}

function messageRow(m) {
  return el('tr', {}, [
    el('td', { text: m.createdAt ? new Date(m.createdAt).toLocaleString() : '—' }),
    el('td', {}, m.runId ? el('a', { href: '#', text: m.runId, onclick: (e) => { e.preventDefault(); open({ kind: 'run', subject: m.runId, title: m.runId }); } }) : el('span', { text: '(root run)' })),
    el('td', { text: m.stage || '—' }),
    el('td', {}, el('span', { class: `chip${m.priority === 'priority' ? ' warn' : ''}`, text: m.priority || 'normal' })),
    el('td', {}, el('span', { class: `chip${['deferred', 'rejected'].includes(m.status) ? ' fail' : m.status === 'addressed' ? ' done' : ''}`, text: m.status })),
    el('td', { text: m.text ? (m.text.length > 140 ? `${m.text.slice(0, 140)}…` : m.text) : '' }),
    el('td', { text: m.reason || '—' }),
  ]);
}

function viewMessages(wrap, tab) {
  tab._msgFilter = tab._msgFilter || '';

  if (!wrap.querySelector('[data-role="results"]')) {
    wrap.replaceChildren();
    wrap.append(el('h1', { text: 'Messages' }));
    wrap.append(el('p', { class: 'sub', text: 'Every operator note sent to an agent through the bridge, and its delivery status.' }));
    const filters = el('div', { class: 'filters' });
    const statusSel = el('select', {}, [
      ['', 'Any status'], ['queued', 'Queued'], ['delivered', 'Delivered'], ['acknowledged', 'Acknowledged'],
      ['addressed', 'Addressed'], ['deferred', 'Deferred'], ['rejected', 'Rejected'],
    ].map(([v, label]) => el('option', { value: v, text: label })));
    statusSel.onchange = () => { tab._msgFilter = statusSel.value; renderResults(wrap, tab); };
    filters.append(statusSel);
    wrap.append(filters);
    wrap.append(el('div', { 'data-role': 'results', text: 'Loading…' }));
  }
  wrap.querySelector('select').value = tab._msgFilter;

  tab._msgFetchGen = (tab._msgFetchGen || 0) + 1;
  const gen = tab._msgFetchGen;
  api.bridge().then((data) => {
    if (isStaleRefresh(tab._msgFetchGen, gen) || tabs.activeId() !== tab.id) return;
    tab._messages = data.messages || [];
    renderResults(wrap, tab);
  }).catch((err) => {
    if (isStaleRefresh(tab._msgFetchGen, gen)) return;
    patchRegion(wrap.querySelector('[data-role="results"]'), `error:${err.message}`, (h) => {
      h.append(el('div', { class: 'empty', text: err.message }));
    });
  });
}

// Patches only the rows that changed instead of rebuilding the whole table on
// every refresh — a message's own delivery status is the only thing that
// ever changes for an existing row, so patchList leaves everything else alone.
function renderResults(wrap, tab) {
  const results = wrap.querySelector('[data-role="results"]');
  const all = (tab._messages || []).slice().sort((a, b) => (b.sequence || 0) - (a.sequence || 0));
  const filtered = tab._msgFilter ? all.filter((m) => m.status === tab._msgFilter) : all;

  const emptySig = filtered.length ? '' : (all.length ? 'no-match' : 'no-messages');
  if (!filtered.length) {
    patchRegion(results, `empty:${emptySig}`, (h) => {
      h.append(el('div', { class: 'empty', text: all.length ? 'No messages match this filter.' : 'No messages have been sent yet.' }));
    });
    return;
  }
  patchRegion(results, 'table', (h) => {
    h.append(el('table', { class: 'tbl' }, [
      el('thead', {}, el('tr', {}, ['When', 'Run', 'Stage', 'Priority', 'Status', 'Text', 'Reason'].map((label) => el('th', { text: label })))),
      el('tbody'),
    ]));
  });
  patchList(results.querySelector('tbody'), filtered, {
    key: (m) => m.id,
    sig: (m) => JSON.stringify([m.status, m.reason, m.text]),
    render: messageRow,
  });
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
  const activeStage = stages.find((s) => s.name === active);
  const emptyMessage = activeStage && !['pending', 'skipped'].includes(activeStage.status)
    ? 'This stage ran but recorded no activity.'
    : 'This stage hasn\'t started.';
  paintVirtualFeed(wrap.querySelector('.feed-shell'), items, tab, active, emptyMessage);
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
  wrap.append(el('div', { 'data-role': 'mode', style: 'margin:-6px 0 12px' }));

  const railHost = el('div', { 'data-role': 'rail' });
  railHost.append(buildStageRail(stages, active, (name) => { tab.stage = name; render(); }, status));
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
  fillBanners(wrap, status, active);
  fillArtifact(wrap, tab, active, data);
  fillMode(wrap, status, active);
}

function patchRunChrome(wrap, tab, { status, stages, active, meta, data }) {
  const pill = wrap.querySelector('[data-role="pill"]');
  if (pill) {
    const label = (status.overall || 'no state recorded').replace(/_/g, ' ');
    const cls = `pill ${status.overall || ''}`;
    if (pill.className !== cls) pill.className = cls;
    if (pill.textContent !== label) pill.textContent = label;
  }
  fillMode(wrap, status, active);
  const railHost = wrap.querySelector('[data-role="rail"]');
  if (railHost) {
    const railSig = `${active}|${stages.map((s) => `${s.name}:${s.status}`).join(',')}`;
    if (railHost.dataset.sig !== railSig) {
      railHost.dataset.sig = railSig;
      railHost.replaceChildren(buildStageRail(stages, active, (name) => { tab.stage = name; render(); }, status));
    }
  }
  fillGoal(wrap, data.goal);
  fillControls(wrap, tab, data);
  fillBanners(wrap, status, active);
  fillArtifact(wrap, tab, active, data);
}

// Same wording the engine itself already logs at startup (orchestrator.mjs)
// so the dashboard never invents a second vocabulary for the same fact: is a
// live chat session driving this, or an unattended agent CLI subprocess.
function modeLabel(status, stage) {
  if (stage?.mode) {
    if (stage.mode === 'seeded') return 'seeded';
    if (stage.mode === 'chat') return `chat (IDE host${stage.hostClient ? `: ${stage.hostClient}` : ''})`;
    if (stage.mode === 'cli') return `cli (subprocess: ${stage.runner || 'unknown'})`;
  }
  if (status.executionSurface === 'host-handoff') {
    return `chat (IDE host${status.hostClient ? `: ${status.hostClient}` : ''})`;
  }
  if (status.executionSurface === 'cli-subprocess') {
    return `cli (subprocess: ${status.runner || 'unknown'})`;
  }
  return null;
}

function fillMode(wrap, status, activeStageName) {
  const host = wrap.querySelector('[data-role="mode"]');
  if (!host) return;
  const stage = status.stages?.find(s => s.name === activeStageName);
  const label = modeLabel(status, stage);
  const model = stage?.actualModel || stage?.model || status.models?.stages?.[activeStageName] || null;
  
  const sig = `${label || ''}|${model || ''}|${status.runnerRequested || ''}`;
  if (host.dataset.sig === sig) return;
  host.dataset.sig = sig;
  host.replaceChildren();
  if (!label && !model) return;
  
  if (model) host.append(el('span', { class: 'chip', text: `model: ${model}` }));
  if (label) host.append(el('span', { class: 'chip', style: model ? 'margin-left:6px' : '', text: label }));
  
  if (status.runnerRequested) {
    host.append(el('span', {
      class: 'chip warn', style: 'margin-left:6px',
      text: `requested ${status.runnerRequested} — running as this chat session instead`,
    }));
  }
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

  if (!data.canCancel && run) {
    list.append(el('div', { class: 'row', style: 'margin-bottom:6px;align-items:center' }, [
      el('button', {
        class: 'btn ghost danger', text: 'Dismiss run',
        onclick: async () => {
          try {
            await api.dismissRun(run, 'Dismissed from dashboard');
            toast('Run dismissed.');
            refresh();
          } catch (err) { toast(err.message); }
        },
      }),
      el('span', { class: 'meta', text: 'Dismiss and archive this run.' }),
    ]));
  }

  host.append(list);
}

function fillBanners(wrap, status, active) {
  const host = wrap.querySelector('[data-role="banners"]');
  if (!host) return;
  const activeStage = status.stages?.find((s) => s.name === (active || status.awaitingStage));
  const isAwaitingHost = activeStage?.status === 'awaiting_host' || status.overall === 'awaiting_chat';
  const sig = `${status.haltReason || ''}|${status.overall || ''}|${isAwaitingHost}`;
  if (host.dataset.sig === sig) return;
  host.dataset.sig = sig;
  host.replaceChildren();
  if (status.haltReason) {
    host.append(el('div', { class: 'banner fail', text: `Halted: ${status.haltReason}. ${status.stages?.find((s) => s.detail)?.detail || ''}` }));
  }
  if (status.overall === 'awaiting_plan_approval') {
    host.append(el('div', { class: 'banner warn', text: 'This run is waiting for its plan to be approved. Answer it in Decisions, or read the specification below first.' }));
  }
  if (isAwaitingHost) {
    const hostLabel = status.hostClient ? `${status.hostClient} ` : '';
    host.append(el('div', { class: 'banner', style: 'background:var(--card);border-left:3px solid var(--accent);color:var(--fg)', text: `Active in ${hostLabel}IDE Chat (host) — Stage in progress. Complete work in your IDE chat and run --continue when finished.` }));
  }
}

function fillArtifact(wrap, tab, active, data) {
  const host = wrap.querySelector('[data-role="artifact"]');
  if (!host) return;
  const wanted = STAGE_ARTIFACT[active];
  const hasArtifact = wanted && (data.artifacts || []).includes(wanted);
  const hasDiff = (data.artifacts || []).includes('diff.patch');
  const compareOn = hasDiff && !!tab._compareDiff;
  // tab._compareDiff (same convention as tab._noteDraft) is part of the key so
  // toggling it forces a rebuild even though nothing about the stage's own
  // artifacts changed.
  const key = hasArtifact ? `${active}:${wanted}:${compareOn}` : '';
  if (host.dataset.key === key) return;
  host.dataset.key = key;
  host.replaceChildren();
  if (!hasArtifact) return;

  host.append(el('div', { class: 'row', style: 'align-items:center;justify-content:space-between' }, [
    el('div', { class: 'sec-label', text: `Output — ${wanted}` }),
    hasDiff ? el('label', { class: 'row', style: 'gap:6px;font-size:12px;color:var(--muted);cursor:pointer' }, [
      el('input', {
        type: 'checkbox', checked: compareOn,
        onchange: (e) => { tab._compareDiff = e.target.checked; render(); },
      }),
      el('span', { text: 'Compare with diff' }),
    ]) : null,
  ]));

  if (compareOn) {
    const left = el('div', { class: 'artifact-card', text: 'Loading…' });
    const right = el('div', { class: 'artifact-card', text: 'Loading…' });
    host.append(el('div', { class: 'compare-grid' }, [left, right]));
    Promise.all([api.artifact(wanted, tab.subject), api.artifact('diff.patch', tab.subject)])
      .then(([a, d]) => {
        if (host.dataset.key !== key) return;
        left.innerHTML = renderMd(a.content || '');
        right.innerHTML = renderDiff(d.content || '');
      })
      .catch(() => {
        if (host.dataset.key !== key) return;
        left.textContent = 'Could not read this artifact.';
        right.textContent = 'Could not read the diff.';
      });
    return;
  }

  const card = el('div', { class: 'artifact-card', text: 'Loading…' });
  host.append(card);
  api.artifact(wanted, tab.subject)
    .then((a) => { if (host.dataset.key === key) card.innerHTML = renderMd(a.content || ''); })
    .catch(() => { if (host.dataset.key === key) card.textContent = 'Could not read this artifact.'; });
}

function paintVirtualFeed(shell, items, tab, stage, emptyMessage = 'Nothing recorded for this stage yet.') {
  if (!shell) return;
  const feed = shell.querySelector('.feed') || shell.appendChild(el('div', { class: 'feed' }));
  shell._feedItems = items;
  shell._feedStage = stage;
  if (!items.length) {
    feed.style.paddingTop = '0px';
    feed.style.paddingBottom = '0px';
    feed.replaceChildren(el('div', { class: 'empty', text: emptyMessage }));
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

// Every review lens the panel produced, then the tests — the order someone
// actually reviews in: verdict first, evidence after. Module-level since
// viewReview's patchList needs the same list identity across calls.
const REVIEW_SECTION_DEFS = [
  ['review_report.md', 'Review'],
  ['review_correctness.md', 'Correctness'],
  ['review_security.md', 'Security'],
  ['review_architecture.md', 'Architecture'],
  ['test_suite.md', 'Tests'],
];

async function viewReview(wrap, tab) {
  const firstMount = !wrap.querySelector('[data-role="body"]');
  if (firstMount) {
    wrap.replaceChildren();
    wrap.append(el('h1', { text: tab.title || `Review ${tab.subject}` }));
    wrap.append(el('p', { class: 'sub', 'data-role': 'sub', text: 'Loading…' }));
    wrap.append(el('div', { 'data-role': 'body' }, [
      el('div', { 'data-role': 'sections' }),
      el('div', { 'data-role': 'diff' }),
      el('div', { class: 'empty', 'data-role': 'empty', text: 'This run has no review to show yet.', hidden: true }),
      el('div', { 'data-role': 'decision' }),
    ]));
  }

  // A background refresh must not clobber this tab mid-fetch with an older
  // response that resolves after a newer one — same guard viewRun uses.
  tab._reviewFetchGen = (tab._reviewFetchGen || 0) + 1;
  const gen = tab._reviewFetchGen;
  let data;
  try { data = await api.state(tab.subject); }
  catch (err) { if (firstMount) wrap.querySelector('[data-role="sub"]').textContent = err.message; return; }
  if (isStaleRefresh(tab._reviewFetchGen, gen) || tabs.activeId() !== tab.id) return;

  const status = data.status || {};
  const feature = tab.feature || status.featureId;
  wrap.querySelector('[data-role="sub"]').textContent =
    [status.verdict ? `verdict ${status.verdict}` : null, feature, status.branch].filter(Boolean).join(' · ');

  const present = new Set(data.artifacts || []);
  const sections = REVIEW_SECTION_DEFS.filter(([name]) => present.has(name));

  // Each section is fetched once (its content never changes once written for
  // this run) — patchList only calls render() for a name it hasn't seen yet,
  // so an unrelated background refresh does not re-fetch or re-render it.
  patchList(wrap.querySelector('[data-role="sections"]'), sections, {
    key: ([name]) => name,
    sig: () => 'present',
    render: ([name, heading]) => {
      const section = el('div', {}, [
        el('h2', { text: heading }),
        el('div', { class: 'card', text: 'Loading…' }),
      ]);
      const card = section.querySelector('.card');
      api.artifact(name, tab.subject)
        .then((a) => { card.innerHTML = renderMd(a.content || ''); })
        .catch(() => { card.textContent = `Could not read ${name}.`; });
      return section;
    },
  });

  patchRegion(wrap.querySelector('[data-role="diff"]'), String(present.has('diff.patch')), (h) => {
    if (!present.has('diff.patch')) return;
    h.append(el('h2', { text: 'Diff' }));
    const holder = el('div', { text: 'Loading…' });
    h.append(holder);
    api.artifact('diff.patch', tab.subject)
      .then((a) => { holder.innerHTML = renderDiff(a.content || ''); })
      .catch(() => { holder.textContent = 'Could not read the diff.'; });
  });

  wrap.querySelector('[data-role="empty"]').hidden = !!(sections.length || present.has('diff.patch'));

  // The decision this review exists to support. Patched (not rebuilt every
  // call) so an operator's in-progress "Request changes" text survives any
  // unrelated background refresh — only actually re-rendered if the pending
  // decision itself changed (opened, resolved, or its question changed).
  const pending = (state.pool?.snapshot?.needsDecision || []).find((d) => d.featureId === feature && d.kind === 'merge-approval');
  const decisionSig = JSON.stringify([feature, pending?.decisionId ?? null, pending?.question ?? null, pending?.options ?? null]);
  patchRegion(wrap.querySelector('[data-role="decision"]'), decisionSig, (h) => {
    if (!feature) return;
    const changes = el('textarea', { placeholder: 'What should change? This goes to the coder and reopens review.' });
    h.append(el('h2', { text: 'Decision' }));
    h.append(el('div', { class: 'card' }, [
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
  });
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
  // The Attention tab has no single run/feature subject of its own for
  // markAttention's per-run badging above to ever match, so without this it
  // never shows anything is waiting until you actually click into it.
  tabs.setBadgeCount('attention', decisions);
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
  ['[ / ]', 'previous / next open tab'],
  ['x', 'close open tab'],
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
      // A hash from an older or newer build can name a tab kind this version
      // doesn't implement — drop just that one entry rather than crash or
      // restore something render() has no view for.
      isKnownKind: (kind) => Object.hasOwn(VIEWS, kind) && kind !== 'unknown',
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
