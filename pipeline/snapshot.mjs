// The pool snapshot: one JSON document that the dashboard, the coordinator
// session and the `/digest` skill all read.
//
// Having a single contract matters more than its shape. When the UI derives run
// state one way and the coordinator another, they eventually disagree in front
// of the operator — one says a feature landed, the other still shows it
// running. Everything derived is computed here, once, from state on disk.
//
// The four sections mirror how an operator actually reads a status board:
// what needs me, what finished, what is happening, what is next.

export const POOL_SNAPSHOT_CONTRACT = 'orchestrator-pool-snapshot.v1';

const LANDED_LIMIT = 5;

export function buildSnapshot({
  roadmap = null, runs = [], decisions = [], attention = [],
  supervisor = null, skills = [], repoRoot = null, now = new Date(),
}) {
  const features = roadmap?.features || [];
  const byFeature = new Map(features.map((f) => [f.id, f]));

  // Anything waiting on a person belongs here, not only formal decisions. A
  // feature that failed, or an escalation with no question attached, still
  // needs someone to look — and a digest that says "nothing needs your
  // decision" while the roadmap is stuck is worse than no digest at all.
  const needsDecision = decisions
    .filter((d) => d.status === 'open')
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)))
    .map((d) => ({
      decisionId: d.decisionId,
      kind: d.kind || 'needs-decision',
      runId: d.runId ?? null,
      featureId: d.featureId ?? null,
      featureTitle: byFeature.get(d.featureId)?.title ?? null,
      question: d.question || '',
      options: d.options || [],
      recommended: d.recommended ?? null,
      artifacts: d.artifacts || [],
      since: d.ts ?? null,
    }));

  const covered = new Set(needsDecision.map((d) => d.featureId).filter(Boolean));
  if (roadmap?.review === 'end' && roadmap.roadmapStatus === 'awaiting_final_review'
    && !needsDecision.some((d) => d.kind === 'roadmap-merge')) {
    needsDecision.push({
      decisionId: null,
      kind: 'roadmap-merge',
      runId: null,
      featureId: null,
      featureTitle: roadmap.title,
      question: `All features of "${roadmap.title}" are tested and accepted onto ${roadmap.workingBranch}. Land them into ${roadmap.base}?`,
      options: ['approve', 'request-changes'],
      recommended: 'approve',
      artifacts: [roadmap.workingBranch, roadmap.base].filter(Boolean),
      since: null,
    });
  }
  for (const feature of features) {
    if (!['failed', 'held'].includes(feature.status) || covered.has(feature.id)) continue;
    needsDecision.push({
      decisionId: null,
      kind: feature.status === 'held' ? 'held' : 'feature-failed',
      runId: feature.integrationRunId ?? null,
      featureId: feature.id,
      featureTitle: feature.title,
      question: feature.status === 'held'
        ? `${feature.id} (${feature.title}) is on hold${feature.heldReason ? `: ${feature.heldReason}` : ''}.`
        : `${feature.id} (${feature.title}) did not complete and the roadmap cannot continue past it.`,
      options: feature.status === 'held' ? ['release', 'skip'] : ['retry', 'skip', 'hold'],
      recommended: null,
      artifacts: [],
      since: feature.startedAt ?? null,
    });
    covered.add(feature.id);
  }

  // Escalations the supervisor raised that are not attached to a decision.
  for (const item of attention) {
    if (!item.escalate || item.decisionId || covered.has(item.featureId)) continue;
    needsDecision.push({
      decisionId: null,
      attentionId: item.id ?? null,
      kind: item.kind || 'attention',
      runId: item.runId ?? null,
      featureId: item.featureId ?? null,
      featureTitle: byFeature.get(item.featureId)?.title ?? null,
      question: item.summary || 'Something needs your attention.',
      options: [],
      recommended: null,
      artifacts: [],
      since: item.ts ?? null,
    });
  }

  const recentlyLanded = features
    .filter((f) => f.status === 'landed')
    .sort((a, b) => String(b.landedAt || '').localeCompare(String(a.landedAt || '')))
    .slice(0, LANDED_LIMIT)
    .map((f) => ({
      featureId: f.id, title: f.title, pr: f.pr ?? null,
      landedSha: f.landedSha ?? null, landedAt: f.landedAt ?? null,
      reportRel: f.reportRel ?? null,
    }));

  const inProgress = runs.map((r) => {
    const feature = byFeature.get(r.featureId);
    const next = features.find((f) => f.status === 'queued' && (f.dependsOn || []).includes(r.featureId))
      || features.find((f) => f.status === 'queued');
    return {
      runId: r.runId,
      featureId: r.featureId ?? null,
      ticketId: r.ticketId ?? null,
      title: r.title ?? feature?.title ?? null,
      kind: r.kind || 'ticket',
      stage: r.stage ?? null,
      cycle: r.cycle ?? null,
      maxCycles: r.maxCycles ?? null,
      state: r.state || 'unknown',
      verb: r.verb ?? null,
      lastOutputAt: r.lastOutputAt ?? null,
      worktree: r.worktree ?? null,
      branch: r.branch ?? null,
      costUsd: r.costUsd ?? 0,
      goal: feature
        ? {
          featureId: feature.id,
          title: feature.title,
          status: feature.status,
          dependsOn: feature.dependsOn || [],
          acceptance: feature.acceptance || null,
          specRunId: feature.specRunId ?? null,
          integrationRunId: feature.integrationRunId ?? null,
          nextFeatureId: next?.id ?? null,
          nextTitle: next?.title ?? null,
        }
        : null,
    };
  });

  // Queued features, plus the tickets of the feature currently executing that
  // have not started yet — both answer "what happens next".
  const upNext = features
    .filter((f) => f.status === 'queued')
    .map((f) => ({
      featureId: f.id,
      title: f.title,
      blockedBy: (f.dependsOn || []).filter((d) => !['landed', 'skipped'].includes(byFeature.get(d)?.status)),
    }));

  const costUsd = Number(runs.reduce((sum, r) => sum + (Number(r.costUsd) || 0), 0).toFixed(6));

  return {
    contract: POOL_SNAPSHOT_CONTRACT,
    generatedAt: (now instanceof Date ? now : new Date(now)).toISOString(),
    repoRoot,
    supervisor: supervisor
      ? {
        pid: supervisor.pid ?? null,
        alive: !!supervisor.alive,
        startedAt: supervisor.startedAt ?? null,
        heartbeatAt: supervisor.heartbeatAt ?? null,
        paused: !!supervisor.paused,
      }
      : { pid: null, alive: false, startedAt: null, heartbeatAt: null, paused: false },
    roadmap: roadmap
      ? {
        title: roadmap.title, base: roadmap.base, merge: roadmap.merge,
        review: roadmap.review || 'feature',
        workingBranch: roadmap.workingBranch ?? null,
        roadmapStatus: roadmap.roadmapStatus || 'running',
        currentFeatureId: roadmap.currentFeatureId ?? null,
        features: features.map((f) => ({
          id: f.id, title: f.title, status: f.status, dependsOn: f.dependsOn || [],
          mode: f.mode || 'build', branch: f.branch ?? null, pr: f.pr ?? null,
          landedSha: f.landedSha ?? null, reportRel: f.reportRel ?? null,
          acceptance: f.acceptance || null,
          specRunId: f.specRunId ?? null,
          integrationRunId: f.integrationRunId ?? null,
          runIds: [f.specRunId, ...(f.tickets || []).map((t) => t.runId), f.integrationRunId].filter(Boolean),
          tickets: (f.tickets || []).map((t) => ({ id: t.id, title: t.title ?? null, runId: t.runId ?? null, status: t.status ?? null })),
        })),
      }
      : null,
    needsDecision,
    recentlyLanded,
    inProgress,
    upNext,
    skills: skills.map((s) => ({ name: s.name, status: s.status })),
    attentionPending: attention.length,
    totals: { costUsd, runsActive: inProgress.filter((r) => r.state === 'busy' || r.state === 'stale').length },
    counts: {
      inProgress: inProgress.length,
      decisions: needsDecision.length,
      landed: features.filter((f) => f.status === 'landed').length,
      queued: upNext.length,
    },
  };
}

function section(title, lines, emptyText) {
  return [`## ${title}`, '', ...(lines.length ? lines : [emptyText]), ''].join('\n');
}

/**
 * The digest an operator actually reads. Deliberately plain: a run that is
 * stuck should look stuck, so no status is dressed up as progress.
 */
export function renderDigest(snapshot) {
  const parts = [];
  const title = snapshot.roadmap?.title;
  parts.push(`# ${title ? `${title} — pool status` : 'Pool status'}`, '');

  if (!snapshot.supervisor.alive) {
    parts.push('> The supervisor is not running. Start it with `bash .pipeline/orchestrate.sh pool start`.', '');
  } else if (snapshot.supervisor.paused) {
    parts.push('> The pool is paused. Resume it with `bash .pipeline/orchestrate.sh pool resume`.', '');
  }

  parts.push(section('Needs your decision', snapshot.needsDecision.map((d) => {
    const where = [d.featureId, d.runId].filter(Boolean).join(' · ');
    const options = d.options.length ? ` Options: ${d.options.join(', ')}.` : '';
    const recommended = d.recommended ? ` Recommended: ${d.recommended}.` : '';
    const how = d.decisionId
      ? ` — answer with \`pool decide ${d.decisionId} "<answer>"\``
      : d.kind === 'feature-failed'
        ? ` — retry with \`pool retry ${d.featureId}\`, or skip with \`roadmap skip ${d.featureId}\``
        : d.kind === 'held'
          ? ` — release with \`roadmap release ${d.featureId}\``
          : d.kind === 'claim-run'
            ? ` — pick it up with \`pool claim ${d.runId}\``
            : d.kind === 'roadmap-merge'
              ? ' — land with `pool approve-merge` or `pool land-roadmap`'
              : '';
    return `- **${d.question}** (${where})${how}.${options}${recommended}`;
  }), 'Nothing needs your decision right now.'));

  parts.push(section('Recently landed', snapshot.recentlyLanded.map((f) => {
    const pr = f.pr?.url ? ` — ${f.pr.url}` : '';
    const report = f.reportRel ? ` — report: ${f.reportRel}` : '';
    return `- **${f.featureId}: ${f.title}**${pr}${report}`;
  }), 'Nothing has landed yet.'));

  parts.push(section('In progress', snapshot.inProgress.map((r) => {
    const what = [r.featureId, r.ticketId].filter(Boolean).join('/');
    const stage = r.stage ? ` — ${r.stage}${r.cycle > 1 ? ` (cycle ${r.cycle})` : ''}` : '';
    const flag = r.state === 'stale' ? ' — **quiet for a long time**'
      : r.state === 'dead' ? ' — **the worker process is gone**'
        : r.state === 'awaiting' ? ' — waiting on a decision' : '';
    return `- ${what || r.runId}${stage}${flag}`;
  }), 'No runs are in progress.'));

  parts.push(section('Up next', snapshot.upNext.map((f) => {
    const blocked = f.blockedBy.length ? ` — waiting on ${f.blockedBy.join(', ')}` : '';
    return `- **${f.featureId}: ${f.title}**${blocked}`;
  }), 'Nothing is queued.'));

  const unverified = snapshot.skills.filter((s) => s.status !== 'verified');
  if (unverified.length) {
    parts.push(`> Skills not in use: ${unverified.map((s) => `${s.name} (${s.status})`).join(', ')} — run \`node pipeline/skills.mjs pin <name>\` after reviewing the change.`, '');
  }
  return parts.join('\n').trimEnd() + '\n';
}
