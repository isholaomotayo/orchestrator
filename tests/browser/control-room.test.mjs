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
