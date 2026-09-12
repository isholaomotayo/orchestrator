// Turning a pool snapshot into the sidebar's navigation tree.
//
// The sidebar answers four questions in the order an operator actually asks
// them: what needs me, what is happening, what just landed, what is next. Runs
// hang under the feature they belong to, because "which feature is this worker
// building?" is the only context that makes a run id meaningful.

const STATE_DOT = {
  busy: 'run',
  stale: 'warn',
  awaiting: 'warn',
  dead: 'fail',
  unknown: 'pending',
  idle: 'done',
};

const FEATURE_DOT = {
  accepted: 'done',
  landed: 'done',
  merging: 'run',
  merge_approved: 'run',
  awaiting_merge_approval: 'warn',
  reviewing: 'run',
  integrating: 'run',
  executing: 'run',
  planning: 'run',
  awaiting_plan_approval: 'warn',
  queued: 'pending',
  held: 'warn',
  skipped: 'skip',
  failed: 'fail',
};

// What the operator should call each state. Internal vocabulary ("integrating",
// "executing") means nothing to someone who did not write the state machine.
const FEATURE_LABEL = {
  queued: 'queued',
  planning: 'planning',
  awaiting_plan_approval: 'needs your approval',
  executing: 'building',
  integrating: 'combining work',
  reviewing: 'in review',
  awaiting_merge_approval: 'ready to merge',
  merge_approved: 'merging',
  merging: 'merging',
  accepted: 'accepted onto roadmap branch',
  landed: 'landed',
  failed: 'failed',
  held: 'on hold',
  skipped: 'skipped',
};

export function featureLabel(status) {
  return FEATURE_LABEL[status] ?? status;
}

export function attentionLevel(item) {
  if (item.kind === 'merge-approval') return 'merge';
  if (['blocked', 'merge-conflict', 'feature-failed', 'halted', 'dead', 'review-failed'].includes(item.kind)) return 'blocked';
  return 'decision';
}

/**
 * Build the sidebar model.
 * @param {object|null} snapshot a pool snapshot, or null in single-run mode
 */
export function buildTree(snapshot, singleRunList = []) {
  if (!snapshot) return { enabled: false, sections: [] };

  const runsByFeature = new Map();
  for (const run of snapshot.inProgress || []) {
    const key = run.featureId ?? '_';
    if (!runsByFeature.has(key)) runsByFeature.set(key, []);
    runsByFeature.get(key).push({
      id: run.runId,
      kind: 'run',
      label: run.ticketId || run.kind || run.runId.slice(-8),
      sub: [run.stage, run.cycle > 1 ? `cycle ${run.cycle}` : null].filter(Boolean).join(' · '),
      dot: STATE_DOT[run.state] ?? 'pending',
      state: run.state,
      warn: run.state === 'stale' ? 'quiet for a long time'
        : run.state === 'dead' ? 'the worker process is gone' : null,
      featureId: run.featureId ?? null,
    });
  }

  const features = snapshot.roadmap?.features ?? [];
  const inProgress = features
    .filter((f) => !['queued', 'accepted', 'landed', 'skipped'].includes(f.status))
    .map((f) => ({
      id: f.id,
      kind: 'feature',
      label: `${f.id}: ${f.title}`,
      sub: featureLabel(f.status),
      dot: FEATURE_DOT[f.status] ?? 'pending',
      status: f.status,
      children: runsByFeature.get(f.id) ?? [],
    }));

  // Runs whose feature is not in the roadmap (an ad-hoc or orphaned run) must
  // still be reachable, or a worker could be running with nowhere to see it.
  const orphanRuns = [...runsByFeature.entries()]
    .filter(([key]) => key === '_' || !features.some((f) => f.id === key))
    .flatMap(([, runs]) => runs);
  if (orphanRuns.length) {
    inProgress.push({ id: '_other', kind: 'feature', label: 'Other runs', sub: '', dot: 'pending', children: orphanRuns });
  }

  const sections = [
    {
      key: 'needsDecision',
      title: 'Needs your decision',
      count: (snapshot.needsDecision || []).length,
      emptyText: 'Nothing right now.',
      items: (snapshot.needsDecision || []).map((d) => ({
        id: d.decisionId ?? `${d.kind}:${d.featureId ?? d.runId ?? ''}`,
        kind: 'decision',
        label: d.question,
        sub: [d.featureId, d.runId].filter(Boolean).join(' · '),
        dot: attentionLevel(d) === 'blocked' ? 'fail' : 'warn',
        decisionId: d.decisionId ?? null,
        featureId: d.featureId ?? null,
        runId: d.runId ?? null,
        level: attentionLevel(d),
      })),
    },
    {
      key: 'inProgress',
      title: 'In progress',
      count: inProgress.length,
      emptyText: 'Nothing is running.',
      items: inProgress,
    },
    {
      key: 'recentlyLanded',
      title: 'Recently landed',
      count: (snapshot.recentlyLanded || []).length,
      emptyText: 'Nothing yet.',
      items: (snapshot.recentlyLanded || []).map((f) => ({
        id: f.featureId,
        kind: 'feature',
        label: `${f.featureId}: ${f.title}`,
        sub: f.status === 'accepted' ? `accepted · ${f.deliveryBranch || 'roadmap branch'}` : f.pr?.url ? 'merged · pull request' : 'landed',
        dot: 'done',
        reportRel: f.reportRel ?? null,
        pr: f.pr ?? null,
      })),
    },
    {
      key: 'upNext',
      title: 'Up next',
      count: (snapshot.upNext || []).length,
      emptyText: 'Nothing queued.',
      items: (snapshot.upNext || []).map((f) => ({
        id: f.featureId,
        kind: 'feature',
        label: `${f.featureId}: ${f.title}`,
        sub: f.blockedBy?.length ? `waiting on ${f.blockedBy.join(', ')}` : 'ready',
        dot: 'pending',
      })),
    },
  ];

  const rootRun = (singleRunList || []).find((r) => r.id === '' || r.runId === '');
  if (rootRun && rootRun.task) {
    sections.unshift({
      key: 'currentRun',
      title: rootRun.live ? 'Active chat run' : 'Recent chat run',
      count: 1,
      emptyText: '',
      items: [{
        id: '',
        kind: 'run',
        label: rootRun.task ? String(rootRun.task).slice(0, 50) + (rootRun.task.length > 50 ? '…' : '') : 'Chat run',
        sub: [rootRun.hostClient ? `chat: ${rootRun.hostClient}` : 'chat', rootRun.overall, rootRun.verdict].filter(Boolean).join(' · '),
        dot: rootRun.overall === 'done' ? 'done' : rootRun.overall === 'halted' ? 'fail' : 'run',
      }],
    });
  }

  return {
    enabled: true,
    paused: !!snapshot.supervisor?.paused,
    supervisorAlive: !!snapshot.supervisor?.alive,
    sections,
  };
}

/** Which runs deserve a tab badge, and at what level. */
export function attentionByRun(snapshot) {
  const out = new Map();
  for (const item of snapshot?.needsDecision || []) {
    if (item.runId) out.set(item.runId, attentionLevel(item));
  }
  for (const run of snapshot?.inProgress || []) {
    if (run.state === 'dead' || run.state === 'stale') out.set(run.runId, 'blocked');
  }
  return out;
}
