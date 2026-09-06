import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeTransition, MERGE_STATES,
  parsePrUrl, detectForge, prBodyFrom,
  openPullRequest, checkMergeable, mergePullRequest,
} from './merging.mjs';

// ---- state machine ---------------------------------------------------------

test('the happy path runs review to landed', () => {
  let s = 'reviewing';
  for (const [event, expected] of [
    ['approved', 'committed'],
    ['pushed', 'pushed'],
    ['pr_opened', 'awaiting_merge_approval'],
    ['merge_approved', 'merge_approved'],
    ['mergeable', 'merging'],
    ['merged', 'merged'],
    ['advanced', 'landed'],
  ]) {
    s = mergeTransition(s, event);
    assert.equal(s, expected, `${event} should reach ${expected}`);
  }
});

test('local-only skips push and PR but still waits for approval', () => {
  let s = mergeTransition('reviewing', 'approved');
  assert.equal(s, 'committed');
  s = mergeTransition(s, 'local_ready');
  assert.equal(s, 'awaiting_merge_approval');
});

test('a non-approved review never reaches a merge state', () => {
  assert.equal(mergeTransition('reviewing', 'changes_requested'), 'reviewing');
  assert.equal(mergeTransition('reviewing', 'blocked'), 'failed');
});

test('every failure edge lands in a distinct, retryable state', () => {
  assert.equal(mergeTransition('committed', 'push_failed'), 'push_failed');
  assert.equal(mergeTransition('pushed', 'pr_failed'), 'pr_failed');
  assert.equal(mergeTransition('merge_approved', 'not_mergeable'), 'not_mergeable');
  assert.equal(mergeTransition('merging', 'merge_failed'), 'merge_failed');
  // Each is recoverable by retrying the step that failed.
  assert.equal(mergeTransition('push_failed', 'pushed'), 'pushed');
  assert.equal(mergeTransition('not_mergeable', 'mergeable'), 'merging');
});

test('an unknown event leaves the state untouched rather than corrupting it', () => {
  assert.equal(mergeTransition('pushed', 'nonsense'), 'pushed');
  assert.ok(MERGE_STATES.includes('awaiting_merge_approval'));
});

test('approval alone never merges: the live check is a separate step', () => {
  // This is the guardrail that stops "the operator said yes an hour ago" from
  // merging a branch that has since gone stale or conflicting.
  assert.notEqual(mergeTransition('merge_approved', 'merged'), 'merged');
});

// ---- forge helpers ---------------------------------------------------------

test('parsePrUrl reads owner, repo and number for both forges', () => {
  assert.deepEqual(parsePrUrl('https://github.com/acme/app/pull/42'), { provider: 'github', owner: 'acme', repo: 'app', number: 42, url: 'https://github.com/acme/app/pull/42' });
  const gl = parsePrUrl('https://gitlab.com/acme/app/-/merge_requests/7');
  assert.equal(gl.provider, 'gitlab');
  assert.equal(gl.number, 7);
});

test('parsePrUrl rejects anything that is not a pull request url', () => {
  for (const bad of ['', 'not a url', 'https://github.com/acme/app', 'https://evil.test/acme/app/pull/1']) {
    assert.equal(parsePrUrl(bad), null, `should reject ${bad}`);
  }
});

test('detectForge reads the remote url', () => {
  assert.equal(detectForge('git@github.com:acme/app.git'), 'github');
  assert.equal(detectForge('https://gitlab.com/acme/app.git'), 'gitlab');
  assert.equal(detectForge('https://example.test/acme/app.git'), null);
});

test('the PR body is built from the work-done report when there is one', () => {
  const body = prBodyFrom({ report: '# Work Done\n\nAdded invoices.', feature: { id: 'F1', title: 'Invoices' }, verdict: 'APPROVED' });
  assert.match(body, /Added invoices/);
  assert.match(body, /F1/);
});

test('the PR body falls back to the feature and verdict with no report', () => {
  const body = prBodyFrom({ report: null, feature: { id: 'F1', title: 'Invoices', acceptance: ['tests pass'] }, verdict: 'APPROVED' });
  assert.match(body, /Invoices/);
  assert.match(body, /tests pass/);
  assert.match(body, /APPROVED/);
});

// ---- adapters with an injected exec ----------------------------------------

function fakeExec(responses) {
  const calls = [];
  return {
    calls,
    exec: (bin, args) => {
      calls.push([bin, ...args].join(' '));
      const key = Object.keys(responses).find((k) => [bin, ...args].join(' ').includes(k));
      const res = key ? responses[key] : { status: 0, stdout: '', stderr: '' };
      return typeof res === 'function' ? res(args) : res;
    },
  };
}

test('opening a PR records the canonical url from the forge, not the one we guessed', () => {
  const { exec, calls } = fakeExec({
    'pr create': { status: 0, stdout: 'https://github.com/acme/app/pull/42\n', stderr: '' },
    'pr view': { status: 0, stdout: JSON.stringify({ url: 'https://github.com/acme/app/pull/42', number: 42, headRefOid: 'sha1', state: 'OPEN' }), stderr: '' },
  });
  const pr = openPullRequest({ cwd: '/repo', provider: 'github', base: 'main', head: 'pipeline/F1', title: 't', bodyFile: '/tmp/b.md', exec });
  assert.equal(pr.ok, true);
  assert.equal(pr.url, 'https://github.com/acme/app/pull/42');
  assert.equal(pr.number, 42);
  assert.equal(pr.head, 'sha1');
  assert.ok(calls.some((c) => c.includes('--body-file /tmp/b.md')));
});

test('a failed PR creation reports the error instead of inventing a url', () => {
  const { exec } = fakeExec({ 'pr create': { status: 1, stdout: '', stderr: 'no auth' } });
  const pr = openPullRequest({ cwd: '/repo', provider: 'github', base: 'main', head: 'h', title: 't', bodyFile: '/tmp/b', exec });
  assert.equal(pr.ok, false);
  assert.match(pr.error, /no auth/);
  assert.equal(pr.url, undefined);
});

test('mergeability is read live and refuses a conflicting branch', () => {
  const { exec } = fakeExec({
    'pr view': { status: 0, stdout: JSON.stringify({ state: 'OPEN', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', headRefOid: 'sha1' }) },
  });
  const res = checkMergeable({ cwd: '/repo', provider: 'github', url: 'https://github.com/a/b/pull/1', expectedHead: 'sha1', exec });
  assert.equal(res.ok, false);
  assert.match(res.reason, /conflict/i);
});

test('mergeability refuses a closed pull request', () => {
  const { exec } = fakeExec({ 'pr view': { status: 0, stdout: JSON.stringify({ state: 'CLOSED', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', headRefOid: 'sha1' }) } });
  const res = checkMergeable({ cwd: '/repo', provider: 'github', url: 'https://github.com/a/b/pull/1', expectedHead: 'sha1', exec });
  assert.equal(res.ok, false);
  assert.match(res.reason, /not open|closed/i);
});

test('mergeability refuses when the branch moved since approval', () => {
  const { exec } = fakeExec({ 'pr view': { status: 0, stdout: JSON.stringify({ state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', headRefOid: 'sha2' }) } });
  const res = checkMergeable({ cwd: '/repo', provider: 'github', url: 'https://github.com/a/b/pull/1', expectedHead: 'sha1', exec });
  assert.equal(res.ok, false);
  assert.match(res.reason, /moved|changed|stale/i);
});

test('pending checks block a merge unless the operator relaxed the requirement', () => {
  const pending = { status: 0, stdout: JSON.stringify({ state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', headRefOid: 'sha1' }) };
  const strict = checkMergeable({ cwd: '/r', provider: 'github', url: 'https://github.com/a/b/pull/1', expectedHead: 'sha1', requireMergeable: true, exec: fakeExec({ 'pr view': pending }).exec });
  assert.equal(strict.ok, false);
  const relaxed = checkMergeable({ cwd: '/r', provider: 'github', url: 'https://github.com/a/b/pull/1', expectedHead: 'sha1', requireMergeable: false, exec: fakeExec({ 'pr view': { status: 0, stdout: JSON.stringify({ state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'UNSTABLE', headRefOid: 'sha1' }) } }).exec });
  assert.equal(relaxed.ok, true);
});

test('a clean, current pull request is mergeable', () => {
  const { exec } = fakeExec({ 'pr view': { status: 0, stdout: JSON.stringify({ state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', headRefOid: 'sha1' }) } });
  const res = checkMergeable({ cwd: '/r', provider: 'github', url: 'https://github.com/a/b/pull/1', expectedHead: 'sha1', exec });
  assert.equal(res.ok, true);
});

test('merging confirms the pull request actually landed', () => {
  const { exec, calls } = fakeExec({
    'pr merge': { status: 0, stdout: '' },
    'pr view': { status: 0, stdout: JSON.stringify({ state: 'MERGED', mergeCommit: { oid: 'deadbeef' } }) },
  });
  const res = mergePullRequest({ cwd: '/r', provider: 'github', url: 'https://github.com/a/b/pull/1', method: 'squash', exec });
  assert.equal(res.ok, true);
  assert.ok(calls.some((c) => c.includes('--squash')));
});

test('a merge command that succeeds but leaves the PR open is reported as a failure', () => {
  const { exec } = fakeExec({
    'pr merge': { status: 0, stdout: '' },
    'pr view': { status: 0, stdout: JSON.stringify({ state: 'OPEN' }) },
  });
  const res = mergePullRequest({ cwd: '/r', provider: 'github', url: 'https://github.com/a/b/pull/1', method: 'squash', exec });
  assert.equal(res.ok, false);
  assert.match(res.reason, /not merged|still open/i);
});

test('gitlab uses glab with its own merge-request verbs', () => {
  const { exec, calls } = fakeExec({
    'mr create': { status: 0, stdout: 'https://gitlab.com/acme/app/-/merge_requests/7\n' },
    'mr view': { status: 0, stdout: JSON.stringify({ web_url: 'https://gitlab.com/acme/app/-/merge_requests/7', iid: 7, sha: 'sha1', state: 'opened' }) },
  });
  const pr = openPullRequest({ cwd: '/r', provider: 'gitlab', base: 'main', head: 'h', title: 't', bodyFile: '/tmp/b', exec });
  assert.equal(pr.ok, true);
  assert.equal(pr.number, 7);
  assert.ok(calls.some((c) => c.startsWith('glab')));
});
