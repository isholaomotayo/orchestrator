// Pure helpers for the Runs destination: the same six-way split Overview's
// tiles count (see snapshot.mjs's `counts`), applied per row so a filter
// picked from a tile lands on exactly the runs that tile counted.

export function runBucket(run) {
  // A finished run (done or halted) is recognized before anything about its
  // bridge owner is consulted: the backend classifies both as state 'idle'
  // (attention.mjs's classifyRun), so overall is the only thing that tells
  // them apart, and a stale/disconnected owner left over from before the run
  // finished must never override that — a done run is 'done', not
  // 'disconnected', and a halted run is 'blocked', not 'disconnected'.
  if (run.overall === 'halted') return 'blocked';
  if (run.overall === 'done') return 'done';
  if (run.state === 'busy' || run.state === 'stale') return 'executing';
  if (run.state === 'awaiting' && !run.owner) return 'awaiting-agent';
  if (run.owner?.capability === 'disconnected') return 'disconnected';
  if (['dead', 'unknown'].includes(run.state)) return 'blocked';
  if (run.state === 'idle') return 'done';
  // Coerced to the fixed vocabulary rather than passing the raw state
  // through: BUCKET_LABEL (and the "Any state" filter dropdown built from
  // it) only ever offers these six values, so a raw state outside that set
  // would otherwise be a bucket no filter could ever select. The stage/state
  // itself is still visible in the table's own columns — only the bucket
  // dimension is constrained.
  return 'unknown';
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
  const poolRuns = pool ? [...(pool.inProgress || []), ...(pool.history || [])] : [];
  const singleRuns = (singleRunList || []).map((r) => ({
    runId: r.id, featureId: r.featureId ?? null, ticketId: r.ticketId ?? null,
    kind: r.kind ?? 'run', stage: r.stage ?? null, state: r.live ? 'busy' : 'idle',
    overall: r.overall, haltReason: r.haltReason,
    runner: r.runner ?? null, hostClient: r.hostClient ?? null, invocationMode: r.invocationMode ?? null, runnerRequested: r.runnerRequested ?? null,
    spawnedAt: r.startedAt ?? null, reportRel: r.reportRel ?? null, title: r.task,
  }));
  if (!pool) return singleRuns;
  const poolIds = new Set(poolRuns.map((r) => r.runId));
  const extras = singleRuns.filter((r) => !poolIds.has(r.runId));
  return [...extras, ...poolRuns];
}

// One label for the Runs table's "Host" column, consistent whether the
// project is in pool mode (rows already carry hostClient/invocationMode
// straight from snapshot.mjs) or single-run mode (mapped the same way just
// above) — previously this column silently meant a runner value in one mode
// and an IDE host name in the other, both crammed into the same field.
export function hostLabel(run) {
  if (run.invocationMode === 'chat') return `chat${run.hostClient ? `: ${run.hostClient}` : ''}`;
  if (run.invocationMode === 'cli') return `cli: ${run.runner || 'unknown'}`;
  // A run recorded before mode-tracking existed, or genuinely unmodeled:
  // fall back to whatever this column always showed before.
  return run.runner || run.hostClient || '—';
}

export function filterRuns(runs, f) {
  return runs.filter((r) => {
    if (f.feature && r.featureId !== f.feature) return false;
    if (f.host && r.runner !== f.host) return false;
    if (f.bucket && runBucket(r) !== f.bucket) return false;
    if (f.olderThanH) {
      const age = ageMs(r.spawnedAt);
      // An unknown age isn't excluded by an "older than" filter — a run with
      // a missing/corrupt spawn timestamp is exactly the kind of run this
      // filter exists to surface, not hide.
      if (age != null && age < Number(f.olderThanH) * 3600000) return false;
    }
    if (f.q && !`${r.runId} ${r.ticketId || ''}`.toLowerCase().includes(f.q.toLowerCase())) return false;
    return true;
  });
}
