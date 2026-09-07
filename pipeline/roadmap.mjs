// The roadmap: what the pool is working through, and how far it has got.
//
// Two files, deliberately separated:
//   .pipeline/roadmap.md        intent, authored by a human or an agent, tracked
//   .pipeline/control/roadmap.json  state, owned by the supervisor
//
// Keeping status out of the markdown is what makes the source editable at any
// time: recompiling merges progress by feature id, so fixing a typo in a
// description mid-run can never reset a landed feature to queued.
//
// The markdown dialect is deliberately tiny — flat `key: value` frontmatter, one
// H2 per feature, key/value bullets, two named subsections. Anything more
// (nesting, anchors, multi-line scalars) is a validation error with a line
// number rather than a guess, because a misread roadmap silently builds the
// wrong product.

import { RUNNER_BINS } from './adapters.mjs';

export const ROADMAP_CONTRACT = 'orchestrator-roadmap.v1';

// 'auto' prefers an authenticated CLI for real unattended parallelism, but
// falls back to 'host' — a feature/ticket never has to name a CLI to be
// runnable; the roadmap works with zero CLI auth on the machine by default.
export const POOL_RUNNERS = ['auto', ...Object.keys(RUNNER_BINS)];

export const FEATURE_STATUSES = [
  'queued',
  'planning',
  'awaiting_plan_approval',
  'executing',
  'integrating',
  'reviewing',
  'awaiting_merge_approval',
  // Consent recorded, but not yet merged: the supervisor still performs a live
  // mergeability read before touching the base branch.
  'merge_approved',
  'merging',
  'landed',
  'failed',
  'held',
  'skipped',
];

// A dependency is satisfied when it landed, or when the operator deliberately
// skipped it. "held" and "failed" must block: continuing past them would build
// on work the operator has not accepted.
const SATISFIED_STATUSES = ['landed', 'skipped'];

export const FEATURE_MODES = ['build', 'research'];
export const MERGE_MODES = ['pr', 'local-only'];
export const REVIEW_GATES = ['feature', 'end'];
export const ROADMAP_STATUSES = ['running', 'awaiting_final_review', 'merge_approved', 'landed'];

/** Long-lived branch that `review: end` accumulates accepted features onto. */
export function roadmapWorkingBranch(title) {
  const slug = String(title || 'roadmap')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'roadmap';
  return `pipeline/roadmap/${slug}`;
}

const FEATURE_ID_RE = /^[A-Za-z][\w-]{0,31}$/;

/**
 * Parse `--- ... ---` frontmatter restricted to flat `key: scalar` lines.
 * @returns {{data: Record<string,string>, body: string, bodyOffset: number, errors: {line:number,message:string}[]}}
 */
export function parseFrontmatter(text) {
  const lines = String(text ?? '').split('\n');
  const errors = [];
  if (lines[0]?.trim() !== '---') {
    return { data: {}, body: String(text ?? ''), bodyOffset: 0, errors: [{ line: 1, message: 'Missing frontmatter: the file must start with a "---" line.' }] };
  }
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end === -1) {
    return { data: {}, body: '', bodyOffset: 0, errors: [{ line: 1, message: 'Unterminated frontmatter: no closing "---" line.' }] };
  }
  const data = {};
  for (let i = 1; i < end; i++) {
    const raw = lines[i];
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    if (/^\s+/.test(raw)) {
      errors.push({ line: i + 1, message: 'Indented line: roadmap frontmatter must be flat "key: value" pairs, with no nesting.' });
      continue;
    }
    const match = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(raw);
    if (!match) {
      errors.push({ line: i + 1, message: `Not a "key: value" pair: ${JSON.stringify(raw.trim())}.` });
      continue;
    }
    if (match[2].trim() === '') {
      // A key with no value followed by indented lines is a nested block. Report
      // it once, against the key that opened it — that is the line the author
      // has to change — and consume the indented lines so one mistake yields
      // exactly one error.
      errors.push({ line: i + 1, message: `"${match[1]}" has no value; roadmap frontmatter must be flat "key: value" pairs, with no nesting or multi-line values.` });
      while (i + 1 < end && /^\s+\S/.test(lines[i + 1])) i++;
      continue;
    }
    data[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
  }
  return { data, body: lines.slice(end + 1).join('\n'), bodyOffset: end + 1, errors };
}

function bulletValue(block, key) {
  const re = new RegExp(`^\\s*[-*]\\s*${key}\\s*:\\s*(.+)$`, 'im');
  return re.exec(block)?.[1]?.trim() ?? '';
}

function subsection(block, name) {
  // `(?![\s\S])` is end-of-input: JavaScript has no \Z, and using it would make
  // the final subsection in a block silently unparseable.
  const re = new RegExp(`^###\\s+${name}\\s*$([\\s\\S]*?)(?=^###\\s|(?![\\s\\S]))`, 'im');
  return (re.exec(block)?.[1] ?? '').trim();
}

/**
 * Parse the whole roadmap document.
 * @returns {{roadmap: object|null, errors: {line:number,message:string}[]}}
 */
export function parseRoadmapMd(text) {
  const { data, body, bodyOffset, errors } = parseFrontmatter(text);
  if (errors.length) return { roadmap: null, errors };

  const lines = body.split('\n');
  const headings = [];
  lines.forEach((line, i) => {
    const match = /^##\s+([^:]+):\s*(.+?)\s*$/.exec(line);
    if (match) headings.push({ idRaw: match[1].trim(), title: match[2].trim(), index: i, line: bodyOffset + i + 1 });
  });

  const features = [];
  const seen = new Map();
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    const block = lines.slice(h.index + 1, i + 1 < headings.length ? headings[i + 1].index : lines.length).join('\n');
    if (!FEATURE_ID_RE.test(h.idRaw)) {
      errors.push({ line: h.line, message: `Invalid feature id "${h.idRaw}": use a letter followed by letters, digits, dash or underscore (e.g. F1).` });
      continue;
    }
    if (seen.has(h.idRaw)) {
      errors.push({ line: h.line, message: `Duplicate feature id "${h.idRaw}" (first defined on line ${seen.get(h.idRaw)}).` });
      continue;
    }
    seen.set(h.idRaw, h.line);

    const description = subsection(block, 'Description');
    if (!description) {
      errors.push({ line: h.line, message: `Feature "${h.idRaw}" has no "### Description" section; a worker cannot be briefed without one.` });
    }
    const mode = bulletValue(block, 'mode') || 'build';
    if (!FEATURE_MODES.includes(mode)) {
      errors.push({ line: h.line, message: `Feature "${h.idRaw}" has unknown mode "${mode}"; expected one of: ${FEATURE_MODES.join(', ')}.` });
    }
    const depsRaw = bulletValue(block, 'depends_on');
    const dependsOn = /^\s*(none)?\s*$/i.test(depsRaw)
      ? []
      : depsRaw.split(/[,;]/).map((d) => d.trim()).filter(Boolean);
    const maxParallelRaw = bulletValue(block, 'max_parallel');
    const maxParallel = maxParallelRaw ? Number(maxParallelRaw) : null;
    if (maxParallelRaw && (!Number.isInteger(maxParallel) || maxParallel < 1)) {
      errors.push({ line: h.line, message: `Feature "${h.idRaw}" has invalid max_parallel "${maxParallelRaw}"; expected a positive integer.` });
    }
    const runner = bulletValue(block, 'runner') || 'auto';
    if (!POOL_RUNNERS.includes(runner)) {
      errors.push({ line: h.line, message: `Feature "${h.idRaw}" has unknown runner "${runner}"; expected one of: ${POOL_RUNNERS.join(', ')}.` });
    }

    features.push({
      id: h.idRaw,
      title: h.title,
      description,
      acceptance: subsection(block, 'Acceptance')
        .split('\n')
        .map((l) => l.replace(/^\s*[-*]\s*(\[[ xX]\]\s*)?/, '').trim())
        .filter(Boolean),
      dependsOn,
      mode,
      maxParallel: Number.isInteger(maxParallel) && maxParallel > 0 ? maxParallel : null,
      runner,
      line: h.line,
    });
  }

  const ids = new Set(features.map((f) => f.id));
  for (const f of features) {
    for (const dep of f.dependsOn) {
      if (!ids.has(dep)) {
        errors.push({ line: f.line, message: `Feature "${f.id}" depends on unknown feature "${dep}".` });
      }
    }
  }
  if (!features.length) errors.push({ line: bodyOffset + 1, message: 'Roadmap has no features; add at least one "## <ID>: <title>" section.' });

  const merge = (data.merge || 'pr').trim();
  if (!MERGE_MODES.includes(merge)) {
    errors.push({ line: 1, message: `Unknown merge mode "${merge}"; expected one of: ${MERGE_MODES.join(', ')}.` });
  }
  const review = (data.review || 'feature').trim();
  if (!REVIEW_GATES.includes(review)) {
    errors.push({ line: 1, message: `Unknown review gate "${review}"; expected one of: ${REVIEW_GATES.join(', ')}.` });
  }
  if (errors.length) return { roadmap: null, errors };

  try { orderFeatures(features); } catch (err) {
    return { roadmap: null, errors: [{ line: 1, message: err.message }] };
  }

  return {
    roadmap: { title: data.title || 'Untitled roadmap', base: data.base || 'main', merge, review, features },
    errors: [],
  };
}

/** Topological order; throws on a cycle rather than deadlocking the pool. */
export function orderFeatures(features) {
  const byId = new Map(features.map((f) => [f.id, f]));
  const state = new Map();
  const order = [];
  const visit = (id, trail) => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') {
      throw new Error(`Dependency cycle in roadmap: ${[...trail, id].join(' -> ')}.`);
    }
    const feature = byId.get(id);
    if (!feature) return;
    state.set(id, 'visiting');
    for (const dep of feature.dependsOn || []) visit(dep, [...trail, id]);
    state.set(id, 'done');
    order.push(id);
  };
  for (const f of features) visit(f.id, []);
  return order;
}

/**
 * Merge parsed intent with previously recorded state.
 *
 * Status lives only here, so an operator may edit roadmap.md at any time. A
 * feature the source no longer mentions is moved to `orphans` rather than
 * deleted: it may have landed work or an open PR, and losing that record
 * silently would be worse than carrying it.
 */
export function compileRoadmap(roadmap, previous = null, { sourceSha256 = null, now = new Date() } = {}) {
  const prior = new Map((previous?.features || []).map((f) => [f.id, f]));
  const features = roadmap.features.map((f) => {
    const before = prior.get(f.id);
    return {
      id: f.id,
      title: f.title,
      description: f.description,
      acceptance: f.acceptance,
      dependsOn: f.dependsOn,
      mode: f.mode,
      maxParallel: f.maxParallel,
      runner: f.runner,
      // State, carried across recompiles.
      status: before?.status ?? 'queued',
      branch: before?.branch ?? `pipeline/feature/${f.id}`,
      baseRef: before?.baseRef ?? null,
      specRunId: before?.specRunId ?? null,
      tickets: before?.tickets ?? [],
      integrationRunId: before?.integrationRunId ?? null,
      pr: before?.pr ?? null,
      landedSha: before?.landedSha ?? null,
      startedAt: before?.startedAt ?? null,
      landedAt: before?.landedAt ?? null,
      reportRel: before?.reportRel ?? null,
    };
  });
  const liveIds = new Set(features.map((f) => f.id));
  const orphans = [
    ...(previous?.orphans || []),
    ...(previous?.features || []).filter((f) => !liveIds.has(f.id)),
  ].filter((f, i, all) => all.findIndex((o) => o.id === f.id) === i);

  const compiled = {
    contract: ROADMAP_CONTRACT,
    source: '.pipeline/roadmap.md',
    sourceSha256,
    compiledAt: now.toISOString(),
    title: roadmap.title,
    base: roadmap.base,
    merge: roadmap.merge,
    review: roadmap.review || 'feature',
    workingBranch: previous?.workingBranch || roadmapWorkingBranch(roadmap.title),
    workingSha: previous?.workingSha ?? null,
    roadmapStatus: previous?.roadmapStatus || 'running',
    currentFeatureId: null,
    features,
    orphans,
  };
  compiled.currentFeatureId = currentFeatureId(compiled);
  return compiled;
}

function currentFeatureId(json) {
  const active = json.features.find((f) => !['landed', 'skipped', 'failed'].includes(f.status) && f.status !== 'queued');
  if (active) return active.id;
  return nextFeature(json)?.id ?? null;
}

/**
 * The next feature that may start: the first queued one whose dependencies are
 * all satisfied. Features run one at a time, so this returns at most one.
 */
export function nextFeature(json) {
  const byId = new Map(json.features.map((f) => [f.id, f]));
  // A feature already in flight means nothing new may start.
  if (json.features.some((f) => !['queued', 'landed', 'skipped', 'failed', 'held'].includes(f.status))) return null;
  for (const f of json.features) {
    if (f.status !== 'queued') continue;
    const ready = (f.dependsOn || []).every((d) => SATISFIED_STATUSES.includes(byId.get(d)?.status));
    if (ready) return f;
  }
  return null;
}

/** Pure status update; returns a new document. */
export function setFeatureStatus(json, featureId, status, patch = {}) {
  if (!FEATURE_STATUSES.includes(status)) {
    throw new Error(`Unknown feature status "${status}"; expected one of: ${FEATURE_STATUSES.join(', ')}.`);
  }
  const features = json.features.map((f) => (f.id === featureId ? { ...f, ...patch, status } : f));
  const updated = { ...json, features };
  updated.currentFeatureId = currentFeatureId(updated);
  return updated;
}

/** Roadmap-level status (used by `review: end` for the final land-on-base gate). */
export function setRoadmapStatus(json, status, patch = {}) {
  if (!ROADMAP_STATUSES.includes(status)) {
    throw new Error(`Unknown roadmap status "${status}"; expected one of: ${ROADMAP_STATUSES.join(', ')}.`);
  }
  const updated = { ...json, ...patch, roadmapStatus: status };
  updated.currentFeatureId = currentFeatureId(updated);
  return updated;
}

/**
 * Context a planner brief should include so a slice of a larger product does
 * not pull in sibling features or ignore what has already landed.
 */
export function featureBriefContext(json, feature) {
  const others = (json.features || []).filter((f) => f.id !== feature.id);
  return {
    roadmapTitle: json.title || 'Untitled roadmap',
    dependsOn: (feature.dependsOn || []).map((id) => {
      const dep = (json.features || []).find((f) => f.id === id);
      return dep ? `${dep.id}: ${dep.title} (${dep.status})` : id;
    }),
    landed: others.filter((f) => f.status === 'landed').map((f) => `${f.id}: ${f.title}`),
    remaining: others.filter((f) => ['queued', 'held'].includes(f.status)).map((f) => `${f.id}: ${f.title}`),
  };
}
