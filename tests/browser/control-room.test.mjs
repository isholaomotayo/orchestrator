// Exercise the shipped dashboard in Chromium against a controlled local API.
// Host sessions are not simulated here: this suite verifies browser behavior.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { chromium } from 'playwright';

const dashboard = fs.readFileSync(new URL('../../pipeline/dashboard.html', import.meta.url));

test('Runs search keeps focus while typing and refreshing, and survives API failures', async t => {
  let degraded = false;
  const streams = new Set();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(': connected\n\n');
      streams.add(res); req.on('close', () => streams.delete(res));
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      res.setHeader('Content-Type', 'application/json');
      if (degraded && url.pathname !== '/api/projects') { res.writeHead(503); return res.end('{}'); }
      const data = {
        '/api/projects': { projects: [{ repoRoot: '/fixture/project', name: 'Browser fixture' }] },
        '/api/pool': { enabled: false },
        '/api/runs': { runs: [
          { id: 'alpha-ticket', overall: 'done', task: 'Alpha', host: 'codex' },
          { id: 'beta-ticket', overall: 'halted', task: 'Beta', host: 'claude' },
        ] },
      }[url.pathname] || {};
      return res.end(JSON.stringify(data));
    }
    res.setHeader('Content-Type', 'text/html'); res.end(dashboard);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const stream of streams) stream.end(); server.closeAllConnections(); server.close(); });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('#tabs button').filter({ hasText: /^Runs$/ }).click();
  const search = page.getByPlaceholder('Search run or ticket id…');
  await search.click();
  await page.keyboard.type('alpha', { delay: 30 });
  assert.equal(await search.inputValue(), 'alpha');
  assert.equal(await search.evaluate(node => node === document.activeElement), true);
  assert.equal(await page.locator('.tbl tbody tr').count(), 1);
  assert.match(await page.locator('.tbl tbody').innerText(), /alpha-ticket/);

  // A background event exercises refresh while the cursor is inside the query.
  const refreshed = page.waitForResponse(res => res.url().includes('/api/runs'));
  for (const stream of streams) stream.write('data: {"type":"change"}\n\n');
  await refreshed;
  await page.waitForTimeout(100);
  assert.equal(await search.evaluate(node => node === document.activeElement), true);
  await page.keyboard.type('-ticket', { delay: 20 });
  assert.equal(await search.inputValue(), 'alpha-ticket');

  degraded = true;
  for (const stream of streams) stream.write('data: {"type":"change"}\n\n');
  await page.locator('#degraded').waitFor({ state: 'visible' });
  assert.equal(await search.inputValue(), 'alpha-ticket');
  assert.equal(await page.locator('.tbl tbody tr').count(), 1);
  degraded = false;
  await page.locator('#degraded').click();
  await page.locator('#degraded').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Clear filters' }).click();
  assert.equal(await page.locator('.tbl tbody tr').count(), 2);
  assert.deepEqual(errors, []);
});

// A decision's needsDecision fixture, matching the shape decisionCard/
// snapshot.mjs actually produce.
function decisionFixture(id, question) {
  return { decisionId: id, kind: 'plan-approval', featureId: id, question, options: ['approve', 'revise'], artifacts: [] };
}

test('Attention keeps an in-progress answer across a background refresh, and drops a resolved decision', async t => {
  const streams = new Set();
  let decisions = [decisionFixture('d1', 'Approve the plan for F1?'), decisionFixture('d2', 'Approve the plan for F2?')];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(': connected\n\n');
      streams.add(res); req.on('close', () => streams.delete(res));
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      res.setHeader('Content-Type', 'application/json');
      const data = {
        '/api/projects': { projects: [{ repoRoot: '/fixture/project', name: 'Browser fixture' }] },
        '/api/pool': { enabled: true, snapshot: {
          roadmap: { title: 'Fixture roadmap', features: [] },
          counts: { landed: 0, executing: 0, awaitingAgent: 0, awaitingUser: decisions.length, blocked: 0, disconnected: 0, queued: 0, decisions: decisions.length },
          supervisor: { alive: true, paused: false },
          skills: [], needsDecision: decisions, recentlyLanded: [], inProgress: [], upNext: [], history: [],
        } },
        '/api/runs': { runs: [] },
      }[url.pathname] || {};
      return res.end(JSON.stringify(data));
    }
    res.setHeader('Content-Type', 'text/html'); res.end(dashboard);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const stream of streams) stream.end(); server.closeAllConnections(); server.close(); });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const attentionTab = page.locator('#tabs button').filter({ hasText: /^Attention/ });
  await page.waitForFunction(() => /Attention\s*2/.test(document.querySelector('#tabs')?.innerText || ''));
  assert.match(await attentionTab.innerText(), /2/, 'the tab itself shows the pending count, not just the sidebar');
  await attentionTab.click();
  await page.waitForSelector('text=Approve the plan for F1?');

  const cards = page.locator('.card');
  const draft = cards.filter({ hasText: 'F1' }).getByPlaceholder(/One of:/);
  await draft.click();
  await page.keyboard.type('looks fine, approve', { delay: 20 });
  assert.equal(await draft.inputValue(), 'looks fine, approve');

  // An unrelated background refresh (same two decisions, nothing changed)
  // must not touch the card the operator is mid-typing into.
  const refreshed = page.waitForResponse(res => res.url().includes('/api/pool'));
  for (const stream of streams) stream.write('data: {"type":"change"}\n\n');
  await refreshed;
  await page.waitForTimeout(100);
  assert.equal(await draft.inputValue(), 'looks fine, approve');
  assert.equal(await draft.evaluate(node => node === document.activeElement), true);
  assert.equal(await page.locator('.card').count(), 2);

  // Resolving d1 elsewhere (e.g. answered from the dashboard chat box) drops
  // it from needsDecision — the card must actually disappear, not linger.
  decisions = [decisionFixture('d2', 'Approve the plan for F2?')];
  const refreshedAgain = page.waitForResponse(res => res.url().includes('/api/pool'));
  for (const stream of streams) stream.write('data: {"type":"change"}\n\n');
  await refreshedAgain;
  await page.waitForFunction(() => document.querySelectorAll('.card').length === 1);
  assert.match(await page.locator('.card').innerText(), /F2/);
  assert.match(await attentionTab.innerText(), /1/, 'the tab badge drops to match the one remaining decision');
  assert.deepEqual(errors, []);
});

test('Overview\'s decision list uses the same draft-preserving behavior as Attention', async t => {
  const streams = new Set();
  const decisions = [decisionFixture('d1', 'Approve the plan for F1?')];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(': connected\n\n');
      streams.add(res); req.on('close', () => streams.delete(res));
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      res.setHeader('Content-Type', 'application/json');
      const data = {
        '/api/projects': { projects: [{ repoRoot: '/fixture/project', name: 'Browser fixture' }] },
        '/api/pool': { enabled: true, snapshot: {
          roadmap: { title: 'Fixture roadmap', features: [] },
          counts: { landed: 0, executing: 0, awaitingAgent: 0, awaitingUser: 1, blocked: 0, disconnected: 0, queued: 0 },
          supervisor: { alive: true, paused: false },
          skills: [], needsDecision: decisions, recentlyLanded: [], inProgress: [], upNext: [], history: [],
        } },
        '/api/runs': { runs: [] },
      }[url.pathname] || {};
      return res.end(JSON.stringify(data));
    }
    res.setHeader('Content-Type', 'text/html'); res.end(dashboard);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const stream of streams) stream.end(); server.closeAllConnections(); server.close(); });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`); // Overview is the default active tab.
  await page.waitForSelector('text=Approve the plan for F1?');

  const draft = page.getByPlaceholder(/One of:/);
  await draft.click();
  await page.keyboard.type('draft answer', { delay: 20 });
  const refreshed = page.waitForResponse(res => res.url().includes('/api/pool'));
  for (const stream of streams) stream.write('data: {"type":"change"}\n\n');
  await refreshed;
  await page.waitForTimeout(100);
  assert.equal(await draft.inputValue(), 'draft answer');
  assert.equal(await draft.evaluate(node => node === document.activeElement), true);
  assert.deepEqual(errors, []);
});

test('a stale hash naming a removed tab kind does not crash boot', async t => {
  const streams = new Set();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(': connected\n\n');
      streams.add(res); req.on('close', () => streams.delete(res));
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      res.setHeader('Content-Type', 'application/json');
      const data = {
        '/api/projects': { projects: [{ repoRoot: '/fixture/project', name: 'Browser fixture' }] },
        '/api/pool': { enabled: false },
        '/api/runs': { runs: [] },
      }[url.pathname] || {};
      return res.end(JSON.stringify(data));
    }
    res.setHeader('Content-Type', 'text/html'); res.end(dashboard);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const stream of streams) stream.end(); server.closeAllConnections(); server.close(); });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // 'diff' was a declared-but-never-implemented tab kind; a hash from an old
  // session (or a hand-edited URL) can still reference it.
  await page.goto(`http://127.0.0.1:${server.address().port}/#tabs=${encodeURIComponent('diff:x')}&active=0`);
  await page.waitForSelector('#tabs button');
  // Boot must still land on a real, working destination — not a blank page.
  await page.locator('#tabs button').filter({ hasText: /^Overview$/ }).waitFor({ state: 'visible' });
  assert.equal(await page.locator('#tabs button').count(), 5, 'only the five real destinations — the bad tab was dropped, not shown as an error tab');
  assert.deepEqual(errors, []);
});

test('Review keeps a "Request changes" draft across a background refresh', async t => {
  const streams = new Set();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(': connected\n\n');
      streams.add(res); req.on('close', () => streams.delete(res));
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      res.setHeader('Content-Type', 'application/json');
      const data = {
        '/api/projects': { projects: [{ repoRoot: '/fixture/project', name: 'Browser fixture' }] },
        '/api/pool': { enabled: false },
        '/api/runs': { runs: [] },
        '/api/state': { status: { overall: 'awaiting_merge_approval', verdict: 'APPROVED', featureId: 'F1', branch: 'pipeline/feature/F1' }, artifacts: [] },
      }[url.pathname] || {};
      return res.end(JSON.stringify(data));
    }
    res.setHeader('Content-Type', 'text/html'); res.end(dashboard);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const stream of streams) stream.end(); server.closeAllConnections(); server.close(); });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // Restore straight into a 'review' tab via the URL hash, the same mechanism
  // a bookmarked/reloaded dashboard tab uses.
  await page.goto(`http://127.0.0.1:${server.address().port}/#tabs=${encodeURIComponent('review:r1')}&active=0`);
  await page.waitForSelector('text=Decision');

  const draft = page.getByPlaceholder(/What should change/);
  await draft.click();
  await page.keyboard.type('rename the column', { delay: 20 });
  const refreshed = page.waitForResponse(res => res.url().includes('/api/state'));
  for (const stream of streams) stream.write('data: {"type":"change"}\n\n');
  await refreshed;
  await page.waitForTimeout(100);
  assert.equal(await draft.inputValue(), 'rename the column');
  assert.equal(await draft.evaluate(node => node === document.activeElement), true);
  assert.deepEqual(errors, []);
});

test("Overview's Roadmap groups features into status lanes and shows their dependencies", async t => {
  const streams = new Set();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(': connected\n\n');
      streams.add(res); req.on('close', () => streams.delete(res));
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      res.setHeader('Content-Type', 'application/json');
      const data = {
        '/api/projects': { projects: [{ repoRoot: '/fixture/project', name: 'Browser fixture' }] },
        '/api/pool': { enabled: true, snapshot: {
          roadmap: { title: 'Fixture roadmap', features: [
            { id: 'F1', title: 'Auth service', status: 'landed', dependsOn: [] },
            { id: 'F2', title: 'Billing', status: 'executing', dependsOn: ['F1'] },
            { id: 'F3', title: 'Notifications', status: 'failed', dependsOn: ['F1', 'F2'] },
          ] },
          counts: { landed: 1, executing: 1, awaitingAgent: 0, awaitingUser: 0, blocked: 0, disconnected: 0, queued: 0, decisions: 0 },
          supervisor: { alive: true, paused: false },
          skills: [], needsDecision: [], recentlyLanded: [], inProgress: [], upNext: [], history: [],
        } },
        '/api/runs': { runs: [] },
      }[url.pathname] || {};
      return res.end(JSON.stringify(data));
    }
    res.setHeader('Content-Type', 'text/html'); res.end(dashboard);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const stream of streams) stream.end(); server.closeAllConnections(); server.close(); });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForSelector('text=Auth service');

  // Lane headings are uppercased by CSS (text-transform), which innerText
  // reflects; the "Queued" stat tile above the Roadmap section is not — so
  // checking the uppercase form specifically distinguishes a lane heading
  // from that unrelated tile label.
  const body = await page.locator('.wrap').innerText();
  assert.match(body, /\bLANDED\b/);
  assert.match(body, /\bBUILDING\b/);
  assert.match(body, /FAILED OR HELD/);
  assert.doesNotMatch(body, /\bQUEUED\b/, 'a lane with no features is not shown at all');
  assert.doesNotMatch(body, /IN REVIEW/);
  assert.match(body, /depends on F1\b/);
  assert.match(body, /depends on F1, F2/);
  assert.deepEqual(errors, []);
});

test("A pending stage's rail row is disabled and names why, while the running stage shows elapsed time", async t => {
  const streams = new Set();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(': connected\n\n');
      streams.add(res); req.on('close', () => streams.delete(res));
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      res.setHeader('Content-Type', 'application/json');
      const data = {
        '/api/projects': { projects: [{ repoRoot: '/fixture/project', name: 'Browser fixture' }] },
        '/api/pool': { enabled: false },
        '/api/runs': { runs: [] },
        '/api/state': { status: { overall: 'running', stages: [
          { name: 'planner', status: 'passed' },
          { name: 'designer', status: 'skipped' },
          { name: 'coder', status: 'passed' },
          { name: 'tester', status: 'running', startedAt: new Date().toISOString() },
          { name: 'reviewer', status: 'pending' },
          { name: 'handoff', status: 'pending' },
          { name: 'reporter', status: 'pending' },
        ] }, artifacts: [] },
      }[url.pathname] || {};
      return res.end(JSON.stringify(data));
    }
    res.setHeader('Content-Type', 'text/html'); res.end(dashboard);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const stream of streams) stream.end(); server.closeAllConnections(); server.close(); });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/#tabs=${encodeURIComponent('run:r1')}&active=0`);
  await page.waitForSelector('.rail-row');

  const reviewerRow = page.locator('.rail-row').filter({ hasText: 'Reviewer' });
  assert.equal(await reviewerRow.isDisabled(), true, 'a stage past the furthest reached one cannot be selected');
  assert.match(await reviewerRow.getAttribute('title'), /hasn't started yet/);

  const testerRow = page.locator('.rail-row').filter({ hasText: 'Tester' });
  assert.equal(await testerRow.isDisabled(), false, 'the actively running stage stays selectable');
  assert.match(await testerRow.innerText(), /running/);
  assert.deepEqual(errors, []);
});

test('The "Compare with diff" toggle survives a background refresh', async t => {
  const streams = new Set();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(': connected\n\n');
      streams.add(res); req.on('close', () => streams.delete(res));
      return;
    }
    if (url.pathname === '/api/artifact') {
      res.setHeader('Content-Type', 'application/json');
      const name = url.searchParams.get('name');
      return res.end(JSON.stringify({ content: name === 'diff.patch' ? '--- a/x\n+++ b/x\n@@\n-old\n+new\n' : '# Test plan\n\nCovers the happy path.' }));
    }
    if (url.pathname.startsWith('/api/')) {
      res.setHeader('Content-Type', 'application/json');
      const data = {
        '/api/projects': { projects: [{ repoRoot: '/fixture/project', name: 'Browser fixture' }] },
        '/api/pool': { enabled: false },
        '/api/runs': { runs: [] },
        '/api/state': { status: { overall: 'running', stages: [
          { name: 'planner', status: 'passed' },
          { name: 'designer', status: 'skipped' },
          { name: 'coder', status: 'passed' },
          { name: 'tester', status: 'running' },
          { name: 'reviewer', status: 'pending' },
          { name: 'handoff', status: 'pending' },
          { name: 'reporter', status: 'pending' },
        ] }, artifacts: ['test_suite.md', 'diff.patch'] },
      }[url.pathname] || {};
      return res.end(JSON.stringify(data));
    }
    res.setHeader('Content-Type', 'text/html'); res.end(dashboard);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const stream of streams) stream.end(); server.closeAllConnections(); server.close(); });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/#tabs=${encodeURIComponent('run:r1')}&active=0`);
  await page.getByText('Compare with diff').waitFor({ state: 'visible' });
  await page.getByText('Compare with diff').click();
  await page.waitForSelector('.compare-grid');
  assert.equal(await page.locator('.compare-grid .artifact-card').count(), 2);

  const refreshed = page.waitForResponse(res => res.url().includes('/api/state'));
  for (const stream of streams) stream.write('data: {"type":"change"}\n\n');
  await refreshed;
  await page.waitForTimeout(100);
  assert.equal(await page.locator('input[type=checkbox]').isChecked(), true, 'the toggle itself stays on');
  assert.equal(await page.locator('.compare-grid .artifact-card').count(), 2, 'the two-column view is not reverted by the background refresh');
  assert.deepEqual(errors, []);
});

test('a run tab shows its actual driving mode, including when the requested runner was coerced', async t => {
  const streams = new Set();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(': connected\n\n');
      streams.add(res); req.on('close', () => streams.delete(res));
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      res.setHeader('Content-Type', 'application/json');
      const data = {
        '/api/projects': { projects: [{ repoRoot: '/fixture/project', name: 'Browser fixture' }] },
        '/api/pool': { enabled: false },
        '/api/runs': { runs: [] },
        '/api/state': {
          status: {
            overall: 'awaiting_chat', stages: [{ name: 'planner', status: 'running' }],
            executionSurface: 'host-handoff', invocationMode: 'chat', hostClient: 'antigravity',
            runner: 'host', runnerRequested: 'cursor',
          },
          artifacts: [],
        },
      }[url.pathname] || {};
      return res.end(JSON.stringify(data));
    }
    res.setHeader('Content-Type', 'text/html'); res.end(dashboard);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const stream of streams) stream.end(); server.closeAllConnections(); server.close(); });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/#tabs=${encodeURIComponent('run:r1')}&active=0`);
  await page.waitForSelector('[data-role="mode"]');
  const modeText = await page.locator('[data-role="mode"]').innerText();
  assert.match(modeText, /chat.*antigravity/);
  assert.match(modeText, /requested cursor/, 'the coerced request stays visible, not silently dropped');
  assert.deepEqual(errors, []);
});
