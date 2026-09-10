// Pure helpers for the Runs destination: the same six-way split Overview's
// tiles count (see snapshot.mjs's `counts`), applied per row so a filter
// picked from a tile lands on exactly the runs that tile counted.

export function runBucket(run) {
  if (run.state === 'busy' || run.state === 'stale') return 'executing';
  if (run.state === 'awaiting' && !run.owner) return 'awaiting-agent';
  if (run.owner?.capability === 'disconnected') return 'disconnected';
  if (run.overall === 'halted' || ['dead', 'unknown'].includes(run.state)) return 'blocked';
  if (run.overall === 'done' || run.state === 'idle') return 'done';
  return run.state || 'unknown';
}

export const BUCKET_LABEL = {
  executing: 'Executing', 'awaiting-agent': 'Awaiting agent', disconnected: 'Disconnected',
  blocked: 'Blocked', done: 'Done', unknown: 'Unknown',
};

export function ageMs(iso, now = Date.now()) {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? null : now - t;
}

export function formatAge(ms) {
  if (ms == null) return '—';
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/**
 * Every attempt a project has a record of, pool or single-run alike, in one
 * shape — including failed/superseded/orphaned/historical runs, not just
 * whatever is currently active. A run's own directory outlives its worktree,
 * so its history stays reachable long after cleanup removes the worktree.
 */
export function allRuns(pool, singleRunList) {
  if (pool) return [...(pool.inProgress || []), ...(pool.history || [])];
  return (singleRunList || []).map((r) => ({
    runId: r.id, featureId: r.featureId ?? null, ticketId: r.ticketId ?? null,
    kind: r.kind ?? 'run', stage: r.stage ?? null, state: r.live ? 'busy' : 'idle',
    overall: r.overall, haltReason: r.haltReason, runner: r.host ?? null,
    spawnedAt: r.startedAt ?? null, reportRel: r.reportRel ?? null, title: r.task,
  }));
}

export function filterRuns(runs, f) {
  return runs.filter((r) => {
    if (f.feature && r.featureId !== f.feature) return false;
    if (f.host && r.runner !== f.host) return false;
    if (f.bucket && runBucket(r) !== f.bucket) return false;
    if (f.olderThanH && (ageMs(r.spawnedAt) ?? 0) < Number(f.olderThanH) * 3600000) return false;
    if (f.q && !`${r.runId} ${r.ticketId || ''}`.toLowerCase().includes(f.q.toLowerCase())) return false;
    return true;
  });
}
