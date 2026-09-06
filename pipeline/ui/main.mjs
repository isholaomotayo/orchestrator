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
import { createTabStore, tabId } from './tabs.mjs';
import { buildTree, attentionByRun, featureLabel } from './pool-tree.mjs';
import { createApi } from './api.mjs';
import { stageIcon, agentMeta, STAGE_ORDER } from './stages.mjs';

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
  primary: null, // full state of the live legacy run, for the sidebar rail
  status: null,
  sse: null,
  seq: 0,
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
    // Single-run project: the live run gets the rich pipeline rail (this is
    // the everyday view for a plain, non-roadmap project); anything archived
    // falls back to a plain list underneath.
    if (state.primary) side.append(...renderPrimaryRail(state.primary));
    const archived = state.runs.filter((r) => r.id !== '');
    if (archived.length || !state.primary) {
      side.append(sectionNode({
        key: 'runs', title: state.primary ? 'Previous runs' : 'Runs',
        count: archived.length, emptyText: 'No runs yet.',
        items: archived.map((r) => ({
          id: r.id, kind: 'run',
          label: r.task ? String(r.task).slice(0, 60) : r.id,
          sub: [r.overall, r.verdict].filter(Boolean).join(' · '),
          dot: r.overall === 'done' ? 'done' : r.overall === 'halted' ? 'fail' : 'run',
        })),
      }));
    }
    return renderSideFoot(tree);
  }

  for (const section of tree.sections) side.append(sectionNode(section));
  renderSideFoot(tree);
}

// The pipeline rail: one row per stage of the live legacy run, in place of
// the flat runs list — restores the pre-tabs single-run sidebar, which this
// is still the everyday view for (a plain project with no roadmap).
function renderPrimaryRail(data) {
  const status = data.status || {};
  const nodes = [];

  if (status.task) {
    nodes.push(el('div', { class: 'side-section' }, [
      el('div', { class: 'side-title' }, el('span', { text: 'Current task' })),
      el('div', { class: 'task-box' }, [
        el('div', { class: 'task-text', text: status.task }),
        status.startedAt ? el('div', { class: 'when', text: `Started ${agoText(status.startedAt)}` }) : null,
      ]),
    ]));
  }

  const stages = status.stages?.length ? status.stages : STAGE_ORDER.map((name) => ({ name, status: 'pending' }));
  const activeTab = tabs.get(tabId({ kind: 'run', subject: '' }));
  const isRunTabActive = !!activeTab && tabs.activeId() === activeTab.id;
  const effectiveStage = activeTab?.stage
    || stages.find((s) => s.status === 'running')?.name
    || stages[stages.length - 1]?.name;
  const rail = el('div', { class: 'rail' });
  for (const stage of stages) {
    const cls = stage.status === 'passed' ? 'is-passed'
      : stage.status === 'running' ? 'is-running'
        : stage.status === 'failed' ? 'is-failed'
          : stage.status === 'skipped' ? 'is-skipped' : 'is-pending';
    const selected = isRunTabActive && stage.name === effectiveStage;
    rail.append(el('button', {
      class: `rail-row ${cls}${selected ? ' selected' : ''}`,
      onclick: () => {
        open({ kind: 'run', subject: '', title: status.task || 'Current run' });
        const tab = tabs.get(tabId({ kind: 'run', subject: '' }));
        if (tab) { tab.stage = stage.name; render(); }
      },
    }, [
      el('span', { class: `agent-ico ${stage.name}`, html: stageIcon(stage.name) }),
      el('div', { class: 'rail-main' }, [
        el('div', { class: 'rail-top' }, el('span', { class: 'rail-nm', text: cap(stage.name) })),
        el('div', { class: 'rail-sub', text: agentMeta(stage.name).sub }),
        el('span', { class: 'rail-track' }, el('span', { class: 'rail-bar' })),
      ]),
    ]));
  }
  nodes.push(el('div', { class: 'side-section' }, [
    el('div', { class: 'side-title' }, el('span', { text: 'Pipeline' })),
    rail,
  ]));
  return nodes;
}

function agoText(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const mins = Math.round(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
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
  if (item.kind === 'run') return open({ kind: 'run', subject: item.id, title: item.label });
  if (item.kind === 'decision') {
    if (item.featureId && item.level === 'merge') return open({ kind: 'review', subject: item.runId || item.featureId, feature: item.featureId, title: `Review ${item.featureId}` });
    return open({ kind: 'decisions', title: 'Decisions' });
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
  foot.append(el('button', { class: 'btn ghost', text: 'Decisions', onclick: () => open({ kind: 'decisions', title: 'Decisions' }) }));
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

function render() {
  renderTabs();
  const host = $('panels');
  host.replaceChildren();
  const tab = tabs.active();
  if (!tab) return host.append(el('div', { class: 'panel' }, el('div', { class: 'empty', text: 'Nothing open.' })));
  const panel = el('div', { class: 'panel' });
  const wrap = el('div', { class: 'wrap' });
  panel.append(wrap);
  host.append(panel);
  const view = VIEWS[tab.kind] || VIEWS.home;
  view(wrap, tab);
  panel.scrollTop = tab.scrollTop || 0;
  panel.addEventListener('scroll', () => { tab.scrollTop = panel.scrollTop; }, { passive: true });
}

const VIEWS = {
  home: viewHome,
  run: viewRun,
  feature: viewFeature,
  review: viewReview,
  decisions: viewDecisions,
  report: viewReport,
};

function viewHome(wrap) {
  const snap = state.pool?.snapshot;
  if (!snap) {
    wrap.append(el('h1', { text: 'Orchestrator' }));
    wrap.append(el('p', { class: 'sub', text: 'No roadmap is running in this project. Open a run from the sidebar, or start one with the orchestrate command.' }));
    return;
  }
  wrap.append(el('h1', { text: snap.roadmap?.title || 'Pool' }));
  wrap.append(el('p', {
    class: 'sub',
    text: `${snap.counts.inProgress} run(s) in progress · ${snap.counts.decisions} waiting on you · ${snap.counts.landed} landed · ${snap.counts.queued} queued`,
  }));

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

function decisionCard(item) {
  const answer = el('textarea', { placeholder: item.options?.length ? `One of: ${item.options.join(', ')}` : 'Your answer' });
  const actions = el('div', { class: 'row', style: 'margin-top:8px' });

  for (const option of item.options || []) {
    actions.append(el('button', {
      class: 'btn ghost', text: option,
      onclick: () => { answer.value = option; },
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
  if (item.runId) actions.append(el('button', { class: 'btn ghost', text: 'Open run', onclick: () => open({ kind: 'run', subject: item.runId, title: item.runId }) }));

  return el('div', { class: 'card' }, [
    el('h4', { text: item.question }),
    el('div', { class: 'meta', text: [item.featureId, item.runId, item.kind].filter(Boolean).join(' · ') }),
    item.recommended ? el('div', { class: 'meta', text: `Recommended: ${item.recommended}` }) : null,
    ...(item.artifacts || []).map((a) => el('div', { class: 'meta', html: `<code>${esc(a)}</code>` })),
    item.decisionId ? answer : el('div', { class: 'meta', text: 'This needs action elsewhere — see the run.' }),
    actions,
  ]);
}

function viewDecisions(wrap) {
  wrap.append(el('h1', { text: 'Decisions' }));
  const items = state.pool?.snapshot?.needsDecision || [];
  if (!items.length) return wrap.append(el('div', { class: 'empty', text: 'Nothing is waiting for you.' }));
  wrap.append(el('p', { class: 'sub', text: 'Every open question, oldest first. Answering one lets its run continue.' }));
  for (const item of items) wrap.append(decisionCard(item));
}

function viewFeature(wrap, tab) {
  const feature = state.pool?.snapshot?.roadmap?.features?.find((f) => f.id === tab.subject);
  if (!feature) return wrap.append(el('div', { class: 'empty', text: 'That feature is no longer in the roadmap.' }));
  wrap.append(el('h1', { text: `${feature.id}: ${feature.title}` }));
  wrap.append(el('p', { class: 'sub', text: featureLabel(feature.status) }));
  if (feature.pr?.url) wrap.append(el('p', {}, el('a', { href: feature.pr.url, text: feature.pr.url, target: '_blank', rel: 'noreferrer' })));
  wrap.append(el('h2', { text: 'Runs' }));
  const runs = (state.pool?.snapshot?.inProgress || []).filter((r) => r.featureId === feature.id);
  if (!runs.length) wrap.append(el('div', { class: 'empty', text: 'No runs are active for this feature.' }));
  for (const run of runs) {
    wrap.append(el('div', { class: 'card' }, [
      el('h4', { text: run.ticketId || run.kind }),
      el('div', { class: 'meta', text: `${run.state}${run.stage ? ` · ${run.stage}` : ''}` }),
      el('button', { class: 'btn ghost', text: 'Open', onclick: () => open({ kind: 'run', subject: run.runId, title: run.ticketId || run.runId }) }),
    ]));
  }
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
  const sub = el('p', { class: 'sub', text: 'Loading…' });
  wrap.append(sub);
  const body = el('div');
  wrap.append(body);

  let data;
  try { data = await api.state(tab.subject); } catch (err) { sub.textContent = err.message; return; }
  if (tabs.activeId() !== tab.id) return; // the reader moved on while we fetched

  const status = data.status || {};
  sub.remove();

  const stages = (status.stages || []).filter((s) => s.status !== 'skipped');
  const active = tab.stage || stages.find((s) => s.status === 'running')?.name || stages[stages.length - 1]?.name || 'planner';
  const meta = agentMeta(active);

  // The header every run opens with: which specialist is at work, what it
  // does, and the run's overall state as a pill — not a wall of plain text.
  body.append(el('div', { class: 'agent-header' }, [
    el('span', { class: `agent-ico ${active}`, html: stageIcon(active) }),
    el('div', {}, [
      el('div', { class: 'nm', text: (tab.title || tab.subject || active).toString() }),
      el('div', { class: 'desc', text: meta.desc }),
    ]),
    el('span', { class: 'spacer' }),
    el('span', { class: `pill ${status.overall || ''}`, text: (status.overall || 'no state recorded').replace(/_/g, ' ') }),
  ]));

  const bar = el('div', { class: 'stagebar' });
  body.append(bar);
  for (const stage of stages) {
    bar.append(el('button', {
      class: 'stagebtn', 'aria-current': stage.name === active ? 'step' : null,
      onclick: () => { tab.stage = stage.name; render(); },
    }, [
      el('span', { class: `agent-ico ${stage.name}`, html: stageIcon(stage.name) }),
      el('span', { text: stage.name }),
      el('span', { class: `dot ${stage.status === 'passed' ? 'done' : stage.status === 'running' ? 'run' : stage.status === 'failed' ? 'fail' : 'pending'}` }),
    ]));
  }

  // Run controls: only the live run (no runId — the root .pipeline/ state)
  // can be steered from here; an archived run is read-only history.
  if (data.live && (data.canCancel || data.canResume || data.canExtend || data.canContinue)) {
    const controls = el('div', { class: 'row', style: 'margin:2px 0 16px' });
    if (data.canContinue) controls.append(el('button', {
      class: 'btn', text: 'Continue',
      onclick: async () => { try { await api.continueRun(); toast('Resuming — the stage you completed will be picked up.'); refresh(); } catch (err) { toast(err.message); } },
    }));
    if (data.canResume) controls.append(el('button', {
      class: 'btn ghost', text: 'Resume',
      onclick: async () => { try { await api.resumeRun(); toast('Asked the run to resume.'); refresh(); } catch (err) { toast(err.message); } },
    }));
    if (data.canExtend) {
      const cycles = el('input', { type: 'text', value: '5', style: 'width:52px' });
      controls.append(cycles, el('button', {
        class: 'btn ghost', text: 'Extend',
        onclick: async () => { try { await api.extendRun(cycles.value); toast('Extended.'); refresh(); } catch (err) { toast(err.message); } },
      }));
    }
    if (data.canCancel) controls.append(el('button', {
      class: 'btn danger', text: 'Stop run',
      onclick: async () => { try { await api.cancelRun(); toast('Stopping — the current stage will finish first.'); refresh(); } catch (err) { toast(err.message); } },
    }));
    body.append(controls);
  }

  if (status.haltReason) {
    body.append(el('div', { class: 'banner fail', text: `Halted: ${status.haltReason}. ${status.stages?.find((s) => s.detail)?.detail || ''}` }));
  }
  if (status.overall === 'awaiting_plan_approval') {
    body.append(el('div', { class: 'banner warn', text: 'This run is waiting for its plan to be approved. Answer it in Decisions, or read the specification below first.' }));
  }

  // Activity, rebuilt from the events the engine recorded for this stage.
  const events = (data.events || {})[active] || [];
  body.append(el('h3', { text: `${active} activity` }));
  if (!events.length) body.append(el('div', { class: 'empty', text: 'Nothing recorded for this stage yet.' }));
  const feed = el('div', { class: 'feed' });
  for (const ev of events.slice(-120)) feed.append(eventBlock(ev));
  body.append(feed);

  // The artifact this stage produced. `data.artifacts` is a list of file names
  // that exist and are non-empty; content is fetched separately.
  const wanted = STAGE_ARTIFACT[active];
  if (wanted && (data.artifacts || []).includes(wanted)) {
    body.append(el('div', { class: 'sec-label', text: `Output — ${wanted}` }));
    const card = el('div', { class: 'artifact-card', text: 'Loading…' });
    body.append(card);
    api.artifact(wanted, tab.subject)
      .then((a) => { card.innerHTML = renderMd(a.content || ''); })
      .catch(() => { card.textContent = 'Could not read this artifact.'; });
  }

  body.append(el('h3', { text: 'Log' }));
  const logBox = el('pre', {}, el('code', { text: 'Loading…' }));
  body.append(logBox);
  api.log(active, tab.subject).then((log) => {
    logBox.replaceChildren(el('code', { text: log.text || 'No log for this stage.' }));
  }).catch(() => logBox.replaceChildren(el('code', { text: 'No log for this stage.' })));

  // A note for the agent working this stage.
  const note = el('textarea', { placeholder: `Note for the ${active} stage — it is picked up on the next cycle.` });
  body.append(el('h3', { text: 'Send a note' }), note, el('div', { class: 'row', style: 'margin-top:8px' }, [
    el('button', {
      class: 'btn', text: 'Send',
      onclick: async () => {
        if (!note.value.trim()) return toast('Write a note first.');
        try { await api.followup(active, note.value.trim(), tab.subject); note.value = ''; toast('Queued for the agent.'); }
        catch (err) { toast(err.message); }
      },
    }),
    el('button', { class: 'btn ghost', text: 'Review this run', onclick: () => open({ kind: 'review', subject: tab.subject, title: `Review ${tab.title || tab.subject}` }) }),
  ]));
}

function eventBlock(ev) {
  if (ev.type === 'checks_start') return el('div', { class: 'divider', text: 'verification' });
  if (ev.type === 'check_end') return el('div', { class: 'block sys', text: `${ev.ok ? '✓' : '✗'} ${ev.check}` });
  if (ev.type === 'agent_start') return el('div', { class: 'divider', text: ev.cycle > 1 ? `cycle ${ev.cycle}` : 'started' });
  if (ev.type === 'followup_applied') return el('div', { class: 'block sys', text: 'A note from you was applied here.' });
  if (ev.kind === 'err') return el('div', { class: 'block err', text: ev.text || '' });
  if (ev.kind === 'tool') return el('div', { class: 'block sys', text: `${ev.tool || 'tool'}${ev.file ? ` · ${ev.file}` : ''}${ev.cmd ? ` · ${ev.cmd}` : ''}` });
  if (ev.kind === 'sys') return el('div', { class: 'block sys', text: ev.text || '' });
  return el('div', { class: 'block', html: renderMd(ev.text || '') });
}

// ---- review view ----------------------------------------------------------

async function viewReview(wrap, tab) {
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
  wrap.append(el('h1', { text: tab.title || 'Report' }));
  const params = tab.file?.startsWith('runs/')
    // A roadmap records a repo-relative path; the endpoint wants run + file.
    ? { run: tab.file.split('/')[1], file: tab.file.split('/').slice(3).join('/') }
    : { feature: tab.subject, file: tab.file || 'work-done.html' };
  const src = api.reportUrl(params);
  wrap.append(el('p', { class: 'sub' }, el('a', { href: src, target: '_blank', rel: 'noreferrer', text: 'Open in a new tab' })));
  // Sandboxed without same-origin: a report may run its own scripts to be
  // interactive, but can never read this page or call the API.
  wrap.append(el('iframe', { class: 'report', src, sandbox: 'allow-scripts', referrerpolicy: 'no-referrer', title: 'Work-done report' }));
}

// ---- data -----------------------------------------------------------------

async function refresh() {
  try {
    const [pool, runs] = await Promise.all([
      api.pool().catch(() => ({ enabled: false })),
      api.runs().catch(() => ({ runs: [] })),
    ]);
    state.pool = pool.enabled ? pool : null;
    state.runs = runs.runs || [];
    // The sidebar's pipeline rail needs per-stage detail that /api/runs does
    // not carry — only fetch it when it will actually be shown (single-run
    // mode with a live run), not on every poll of a pool project.
    const live = !state.pool && state.runs.find((r) => r.id === '' && r.live);
    state.primary = live ? await api.state('').catch(() => null) : null;
  } catch { /* keep the last good view rather than blanking the page */ }

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

function connect() {
  if (state.sse) state.sse.close();
  const source = new EventSource(`/events?project=${encodeURIComponent(state.project)}`);
  source.onmessage = (message) => {
    try {
      const data = JSON.parse(message.data);
      if (data.type === 'change') refresh();
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
  ['g h', 'home'],
  ['g d', 'decisions'],
  ['?', 'this list'],
];

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
      if (e2.key === 'h') open({ kind: 'home', title: 'Overview' });
      if (e2.key === 'd') open({ kind: 'decisions', title: 'Decisions' });
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
  tabs.open({ kind: 'home', title: 'Overview', pinned: true });
  if (location.hash.includes('tabs=')) {
    // A restored tab has no live data yet, so its label comes from what it is.
    tabs.restore(location.hash, {
      titleFor: (spec) => (spec.kind === 'review' ? `Review ${spec.subject}`
        : spec.kind === 'report' ? `${spec.subject} report`
          : spec.subject || (spec.kind === 'home' ? 'Overview' : spec.kind)),
    });
    if (!tabs.list().length) tabs.open({ kind: 'home', title: 'Overview', pinned: true });
  }
  connect();
  await refresh();
  // A slow fallback: the watcher is the primary signal, this only covers a
  // dropped stream.
  setInterval(refresh, 15000);
}

boot();
