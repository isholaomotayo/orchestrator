// Stage identity: one small SVG icon and a short description per agent, so a
// run reads as a sequence of distinct specialists rather than a list of
// strings. Ported from the pre-tabs dashboard, which drew every stage this
// way — the icons and colors are the product's visual identity, not
// decoration to be rebuilt from scratch every time the shell changes.

function svg(inner) {
  return `<svg class="ic" viewBox="0 0 24 24">${inner}</svg>`;
}

export const ICONS = {
  planner: svg('<circle cx="12" cy="12" r="9"/><polygon points="15.5,8.5 13.5,13.5 8.5,15.5 10.5,10.5" fill="currentColor" stroke="none"/>'),
  designer: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="12" y1="3" x2="12" y2="12"/>'),
  coder: svg('<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>'),
  tester: svg('<path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z"/><polyline points="9 12 11 14 15 10"/>'),
  reviewer: svg('<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16" y2="16"/>'),
  handoff: svg('<path d="M4 12h11"/><polyline points="11,6 17,12 11,18"/><line x1="20" y1="5" x2="20" y2="19"/>'),
  reporter: svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>'),
};

export const AGENTS = {
  planner: { sub: 'Spec writer', desc: 'Turns vague requests into precise specs' },
  designer: { sub: 'Architecture', desc: 'Design-It-Twice: explores alternatives, locks contracts' },
  coder: { sub: 'Implementation', desc: 'Implements the spec, self-heals until checks pass' },
  tester: { sub: 'QA & coverage', desc: 'Writes rigorous tests for the implementation' },
  reviewer: { sub: 'Code review', desc: 'Read-only security & architecture audit' },
  handoff: { sub: 'Continuation doc', desc: 'Compiles the handoff document for the next session' },
  reporter: { sub: 'Work-done report', desc: 'Compiles a measured summary of what changed' },
};

export const STAGE_ORDER = ['planner', 'designer', 'coder', 'tester', 'reviewer', 'handoff', 'reporter'];

export function stageIcon(name) {
  return ICONS[name] || ICONS.coder;
}

export function agentMeta(name) {
  return AGENTS[name] || { sub: name, desc: '' };
}

// Why a stage shows as skipped, not just that it is. Keyed by stage name so a
// future optional stage that isn't listed here falls back to a generic
// pointer instead of inheriting Designer's reason.
const SKIP_REASONS = {
  designer: (status) => (status?.flags?.design
    ? null
    : 'Skipped — Designer is opt-in (`--design` flag / `"designStage": true` in .pipeline/config.json was not set for this run).'),
};

export function skipReason(stage, status) {
  if (!stage || stage.status !== 'skipped') return null;
  const reasonFn = SKIP_REASONS[stage.name];
  if (reasonFn) return reasonFn(status) ?? 'Skipped for this run (reason not recorded).';
  return 'Skipped for this run (see status.json for details).';
}
