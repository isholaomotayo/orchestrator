// Landing a feature: commit, push, open a pull request, and merge — but only
// after a human says so AND the forge confirms, at that moment, that merging is
// safe.
//
// The rule that shapes this module: recorded metadata is never the authority.
// A PR url and head sha captured when the run finished can be minutes or hours
// stale by the time an operator approves. In between, someone can push to the
// branch, CI can go red, or the base can move. So approval and merge are two
// separate steps, with a live read in between.
//
// Every forge call goes through an injected `exec`, so the whole state machine
// is testable without a network, a token, or a real repository.
import { spawnSync } from 'node:child_process';

export const MERGE_STATES = [
  'reviewing',
  'committed',
  'pushed',
  'awaiting_merge_approval',
  'merge_approved',
  'merging',
  'merged',
  'landed',
  'failed',
  // Recoverable failures, each named for the step that failed so a retry knows
  // where to resume.
  'push_failed',
  'pr_failed',
  'not_mergeable',
  'merge_failed',
];

const TRANSITIONS = {
  reviewing: { approved: 'committed', changes_requested: 'reviewing', blocked: 'failed' },
  committed: { pushed: 'pushed', local_ready: 'awaiting_merge_approval', push_failed: 'push_failed' },
  push_failed: { pushed: 'pushed', push_failed: 'push_failed' },
  pushed: { pr_opened: 'awaiting_merge_approval', pr_failed: 'pr_failed' },
  pr_failed: { pr_opened: 'awaiting_merge_approval', pr_failed: 'pr_failed' },
  // Approval does NOT merge: it only unlocks the live check.
  awaiting_merge_approval: { merge_approved: 'merge_approved', changes_requested: 'reviewing' },
  merge_approved: { mergeable: 'merging', not_mergeable: 'not_mergeable' },
  not_mergeable: { mergeable: 'merging', changes_requested: 'reviewing' },
  merging: { merged: 'merged', merge_failed: 'merge_failed' },
  merge_failed: { mergeable: 'merging', merged: 'merged' },
  merged: { advanced: 'landed' },
};

/** Pure transition; an unrecognised event leaves the state untouched. */
export function mergeTransition(state, event) {
  return TRANSITIONS[state]?.[event] ?? state;
}

const PR_URL_RES = [
  { provider: 'github', re: /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/ },
  { provider: 'gitlab', re: /^https:\/\/[^/]*gitlab[^/]*\/(.+?)\/([^/]+)\/-\/merge_requests\/(\d+)/ },
];

export function parsePrUrl(url) {
  for (const { provider, re } of PR_URL_RES) {
    const m = re.exec(String(url || '').trim());
    if (m) return { provider, owner: m[1], repo: m[2], number: Number(m[3]), url: m[0] };
  }
  return null;
}

export function detectForge(remoteUrl) {
  const url = String(remoteUrl || '');
  if (/github\.com/i.test(url)) return 'github';
  if (/gitlab/i.test(url)) return 'gitlab';
  return null;
}

/** The pull-request description: the work-done report when we have one. */
export function prBodyFrom({ report = null, feature = {}, verdict = null }) {
  if (report && report.trim()) {
    return `${report.trim()}\n\n---\nFeature ${feature.id ?? ''}${verdict ? ` · review verdict: ${verdict}` : ''}\n`;
  }
  const lines = [`## ${feature.id ?? ''}: ${feature.title ?? ''}`.trim(), ''];
  if (feature.description) lines.push(feature.description, '');
  if (feature.acceptance?.length) {
    lines.push('### Acceptance', '', ...feature.acceptance.map((a) => `- ${a}`), '');
  }
  if (verdict) lines.push(`Review verdict: **${verdict}**`, '');
  return lines.join('\n');
}

function defaultExec(bin, args, cwd) {
  const res = spawnSync(bin, args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function run(exec, bin, args, cwd) {
  return exec ? exec(bin, args, cwd) : defaultExec(bin, args, cwd);
}

/** Open a pull/merge request and record what the forge says it is. */
export function openPullRequest({ cwd, provider, base, head, title, bodyFile, exec = null }) {
  const bin = provider === 'gitlab' ? 'glab' : 'gh';
  const createArgs = provider === 'gitlab'
    ? ['mr', 'create', '--source-branch', head, '--target-branch', base, '--title', title, '--description-file', bodyFile, '--yes']
    : ['pr', 'create', '--base', base, '--head', head, '--title', title, '--body-file', bodyFile];

  const created = run(exec, bin, createArgs, cwd);
  if (created.status !== 0) {
    return { ok: false, error: (created.stderr || created.stdout || '').trim() || `${bin} exited ${created.status}` };
  }
  const printed = (created.stdout || '').trim().split('\n').map((l) => l.trim()).filter(Boolean).pop() || '';

  // Read it back: the url we print must be the one the forge owns, and we need
  // the head sha to detect later drift.
  const viewArgs = provider === 'gitlab'
    ? ['mr', 'view', printed, '--output', 'json']
    : ['pr', 'view', printed, '--json', 'url,number,headRefOid,state'];
  const viewed = run(exec, bin, viewArgs, cwd);
  if (viewed.status !== 0) {
    const parsed = parsePrUrl(printed);
    if (!parsed) return { ok: false, error: (viewed.stderr || '').trim() || 'could not read back the pull request' };
    return { ok: true, provider, url: parsed.url, number: parsed.number, head: null };
  }
  let json = {};
  try { json = JSON.parse(viewed.stdout); } catch { /* fall back to the printed url below */ }
  const url = json.url || json.web_url || printed;
  const parsed = parsePrUrl(url);
  return {
    ok: true,
    provider,
    url,
    number: json.number ?? json.iid ?? parsed?.number ?? null,
    head: json.headRefOid ?? json.sha ?? null,
  };
}

const CLEAN_STATES = ['CLEAN', 'HAS_HOOKS'];

/**
 * Is this pull request safe to merge RIGHT NOW?
 *
 * `expectedHead` is the sha the run actually produced and reviewed. If the
 * branch has moved, whatever a human approved is not what would merge.
 */
export function checkMergeable({ cwd, provider, url, expectedHead = null, requireMergeable = true, exec = null }) {
  const bin = provider === 'gitlab' ? 'glab' : 'gh';
  const args = provider === 'gitlab'
    ? ['mr', 'view', url, '--output', 'json']
    : ['pr', 'view', url, '--json', 'state,mergeable,mergeStateStatus,headRefOid'];
  const res = run(exec, bin, args, cwd);
  if (res.status !== 0) {
    return { ok: false, reason: (res.stderr || '').trim() || 'could not read the pull request state' };
  }
  let json;
  try { json = JSON.parse(res.stdout); } catch {
    return { ok: false, reason: 'the forge returned an unreadable pull request state' };
  }

  const state = String(json.state || '').toUpperCase();
  if (provider === 'gitlab' ? state !== 'OPENED' : state !== 'OPEN') {
    return { ok: false, reason: `the pull request is not open (state: ${json.state})` };
  }

  const head = json.headRefOid ?? json.sha ?? null;
  if (expectedHead && head && head !== expectedHead) {
    return { ok: false, reason: `the branch moved since it was reviewed (reviewed ${expectedHead.slice(0, 8)}, now ${String(head).slice(0, 8)}) — re-review before merging` };
  }

  const mergeable = String(json.mergeable || '').toUpperCase();
  if (mergeable === 'CONFLICTING' || String(json.mergeStateStatus || '').toUpperCase() === 'DIRTY') {
    return { ok: false, reason: 'the branch conflicts with its base' };
  }
  if (requireMergeable) {
    const mergeState = String(json.mergeStateStatus || '').toUpperCase();
    if (mergeState && !CLEAN_STATES.includes(mergeState)) {
      return { ok: false, reason: `the forge is not ready to merge (${mergeState}) — checks or reviews are outstanding` };
    }
  }
  return { ok: true, head };
}

/** Merge, then confirm it actually landed rather than trusting the exit code. */
export function mergePullRequest({ cwd, provider, url, method = 'squash', exec = null }) {
  const bin = provider === 'gitlab' ? 'glab' : 'gh';
  const args = provider === 'gitlab'
    ? ['mr', 'merge', url, '--yes']
    : ['pr', 'merge', url, `--${method}`, '--delete-branch=false'];
  const res = run(exec, bin, args, cwd);
  if (res.status !== 0) {
    return { ok: false, reason: (res.stderr || res.stdout || '').trim() || `${bin} exited ${res.status}` };
  }

  const viewArgs = provider === 'gitlab'
    ? ['mr', 'view', url, '--output', 'json']
    : ['pr', 'view', url, '--json', 'state,mergeCommit'];
  const viewed = run(exec, bin, viewArgs, cwd);
  let json = {};
  try { json = JSON.parse(viewed.stdout); } catch { /* checked below */ }
  const state = String(json.state || '').toUpperCase();
  if (state !== 'MERGED') {
    // A merge queue accepts the request without merging yet; so does a failed
    // automation. Either way this is not "landed", and saying it is would
    // advance the roadmap onto a base that does not contain the work.
    return { ok: false, reason: `the merge command succeeded but the pull request is still open (state: ${json.state || 'unknown'})` };
  }
  return { ok: true, mergeCommit: json.mergeCommit?.oid ?? json.merge_commit_sha ?? null };
}
