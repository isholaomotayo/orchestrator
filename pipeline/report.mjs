// The work-done report: what was built, for the people who asked for it.
//
// Deliberately hybrid. Everything measurable — spec coverage, changed files,
// test trend, decisions taken, the verdict, the PR — is computed here from
// artifacts the run already produced, with no model involved, exactly as
// handoff.mjs compiles a halt document. Only the narrative comes from an agent,
// and it is embedded as escaped text.
//
// That split matters: a report whose numbers were written by the same agent
// that did the work is a claim, not a record. These numbers are derived from
// the diff and the artifacts, so they can be checked.
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from './state.mjs';
import { hashFile } from './integrity.mjs';

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * A deliberately small markdown subset. There is no raw-HTML passthrough and no
 * link rendering, because every input here is text an agent wrote after reading
 * a repository that may contain anything at all.
 */
export function renderMarkdownLite(md) {
  const lines = String(md || '').split('\n');
  const out = [];
  let inCode = false;
  let listType = null;

  const closeList = () => { if (listType) { out.push(`</${listType}>`); listType = null; } };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (/^```/.test(line)) {
      closeList();
      out.push(inCode ? '</code></pre>' : '<pre><code>');
      inCode = !inCode;
      continue;
    }
    if (inCode) { out.push(escapeHtml(raw)); continue; }
    if (!line.trim()) { closeList(); continue; }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      const level = Math.min(heading[1].length + 1, 5);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      const want = bullet ? 'ul' : 'ol';
      if (listType !== want) { closeList(); out.push(`<${want}>`); listType = want; }
      out.push(`<li>${inline((bullet || numbered)[1])}</li>`);
      continue;
    }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  if (inCode) out.push('</code></pre>');
  return out.join('\n');
}

function inline(text) {
  // Escape first, decorate second: nothing an agent writes can become markup.
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
}

/** Per-file additions, deletions and status, parsed from a unified diff. */
export function diffStats(patch) {
  const files = [];
  let current = null;
  let repo = null;
  for (const line of String(patch || '').split('\n')) {
    const repoHeading = /^##\s+repo\s+`?([^`]+)`?\s*$/.exec(line);
    if (repoHeading) { repo = repoHeading[1].trim(); continue; }
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (header) {
      current = { file: header[2], repo, added: 0, removed: 0, status: 'M', binary: false };
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (/^new file mode/.test(line)) current.status = 'A';
    else if (/^deleted file mode/.test(line)) current.status = 'D';
    else if (/^rename from /.test(line)) current.status = 'R';
    else if (/^Binary files /.test(line)) current.binary = true;
    else if (/^\+(?!\+\+)/.test(line)) current.added++;
    else if (/^-(?!--)/.test(line)) current.removed++;
  }
  return files;
}

/** Failure-mode ids the specification defined. */
export function parseSpecItems(specs) {
  const text = String(specs || '');
  const ids = [...text.matchAll(/^\|\s*(E\d+)\s*\|\s*([^|]*)\|/gim)].map((m) => ({ id: m[1], name: m[2].trim() }));
  const tickets = [...text.matchAll(/^###\s*Ticket\s+(\d+)\s*:\s*(.+)$/gim)].map((m) => ({ id: `T${m[1]}`, title: m[2].trim() }));
  return { failureModes: dedupe(ids), tickets };
}

function dedupe(rows) {
  const seen = new Set();
  return rows.filter((r) => (seen.has(r.id) ? false : seen.add(r.id)));
}

/** Rows of the reviewer's spec-coverage table. */
export function parseReviewCoverage(review) {
  const section = /##[^\n]*spec coverage[^\n]*\n([\s\S]*?)(?=\n##\s|(?![\s\S]))/i.exec(String(review || ''));
  if (!section) return [];
  const rows = [];
  for (const line of section[1].split('\n')) {
    const cells = line.split('|').map((c) => c.trim()).filter((c, i, all) => !(i === 0 && !c) && !(i === all.length - 1 && !c));
    if (cells.length < 2) continue;
    if (/^-+$/.test(cells[0])) continue;
    if (/^(id|ticket|item)$/i.test(cells[0])) continue;
    rows.push({ id: cells[0], status: cells[1], evidence: cells[2] ?? '' });
  }
  return rows;
}

/** Join what the spec asked for with what the review says was covered. */
export function coverageTable(specs, review) {
  const { failureModes } = parseSpecItems(specs);
  const rows = parseReviewCoverage(review);
  const byId = new Map(rows.map((r) => [r.id.toUpperCase(), r]));
  const joined = failureModes.map((item) => {
    const row = byId.get(item.id.toUpperCase());
    const status = row
      ? (/cover|pass|yes|done/i.test(row.status) ? 'covered' : /partial/i.test(row.status) ? 'partial' : 'missing')
      : 'unmentioned';
    return { id: item.id, name: item.name, status, evidence: row?.evidence ?? '' };
  });
  for (const row of rows) {
    if (!failureModes.some((f) => f.id.toUpperCase() === row.id.toUpperCase())) {
      joined.push({ id: row.id, name: '', status: /cover|pass|yes|done/i.test(row.status) ? 'covered' : 'partial', evidence: row.evidence });
    }
  }
  return joined;
}

/** Pass counts per cycle, so a reader can see whether the run was converging. */
export function testTrend(history) {
  const cycles = [...(history?.coder || []), ...(history?.postTester || [])];
  return cycles.map((c) => ({ passed: c.passedCount, failed: c.failedCount, ok: !!c.isPassed, at: c.at }));
}

const STATUS_LABEL = { A: 'added', M: 'changed', D: 'removed', R: 'renamed' };

function styleBlock() {
  // The report is a standalone file: no fonts, no scripts from anywhere else,
  // nothing that needs a network to render correctly in five years.
  return `:root{--bg:#f4f4f2;--panel:#fff;--border:#e7e5e2;--text:#1c1917;--muted:#78716c;
--code-bg:#f5f5f3;--green:#16a34a;--green-bg:#dcfce7;--green-text:#166534;
--amber-bg:#fef3c7;--amber-text:#92400e;--red-bg:#fee2e2;--red-text:#991b1b;--accent:#2563eb}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#1c1917;--panel:#292524;
--border:#44403c;--text:#fafaf9;--muted:#a8a29e;--code-bg:#1c1917;--green:#22c55e;--green-bg:#14532d;
--green-text:#86efac;--amber-bg:#451a03;--amber-text:#fcd34d;--red-bg:#450a0a;--red-text:#fca5a5;--accent:#60a5fa}}
:root[data-theme="dark"]{--bg:#1c1917;--panel:#292524;--border:#44403c;--text:#fafaf9;--muted:#a8a29e;
--code-bg:#1c1917;--green:#22c55e;--green-bg:#14532d;--green-text:#86efac;--amber-bg:#451a03;
--amber-text:#fcd34d;--red-bg:#450a0a;--red-text:#fca5a5;--accent:#60a5fa}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);
font:15px/1.65 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:900px;margin:0 auto;padding:40px 24px 80px}
h1{font-size:28px;margin:0 0 4px} h2{font-size:19px;margin:36px 0 12px;padding-bottom:6px;border-bottom:1px solid var(--border)}
h3{font-size:16px;margin:22px 0 8px} p{margin:10px 0} ul,ol{margin:10px 0;padding-left:22px} li{margin:4px 0}
code{background:var(--code-bg);padding:1px 5px;border-radius:4px;font-size:13px;
font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
pre{background:var(--code-bg);padding:12px 14px;border-radius:8px;overflow-x:auto;border:1px solid var(--border)}
pre code{background:none;padding:0}
.meta{color:var(--muted);font-size:13px;margin-bottom:20px}
.badge{display:inline-block;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600}
.badge.approved{background:var(--green-bg);color:var(--green-text)}
.badge.other{background:var(--amber-bg);color:var(--amber-text)}
table{border-collapse:collapse;width:100%;margin:12px 0;font-size:14px;display:block;overflow-x:auto}
th,td{border:1px solid var(--border);padding:7px 10px;text-align:left;vertical-align:top}
th{background:var(--code-bg);font-weight:600}
.covered{color:var(--green-text)} .missing,.unmentioned{color:var(--red-text);font-weight:600}
.partial{color:var(--amber-text)}
figure{margin:20px 0;border:1px solid var(--border);border-radius:10px;overflow:hidden;background:var(--panel)}
figure iframe{display:block;width:100%;height:640px;border:0;background:#fff}
figcaption{padding:8px 12px;font-size:12px;color:var(--muted);border-top:1px solid var(--border)}
.note{background:var(--amber-bg);color:var(--amber-text);padding:10px 12px;border-radius:8px;font-size:14px}
footer{margin-top:48px;padding-top:16px;border-top:1px solid var(--border);color:var(--muted);font-size:12px}
footer code{font-size:11px}`;
}

function section(title, body) {
  return body ? `<h2>${escapeHtml(title)}</h2>\n${body}` : '';
}

function narrativeSection(narrative, heading) {
  const re = new RegExp(`^##\\s+${heading}\\s*$([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, 'im');
  const body = re.exec(String(narrative || ''))?.[1]?.trim();
  return body && !/^none\.?$/i.test(body) ? renderMarkdownLite(body) : '';
}

/**
 * Compile the report. Returns HTML for people and markdown for a pull request
 * body, from the same computed data.
 */
export function compileWorkDoneReport({
  title, status = {}, runId = null, feature = null, narrative = '',
  specs = '', review = '', testSuite = '', diff = '', history = null,
  decisions = [], pr = null, diagrams = [], generatedAt = new Date(),
}) {
  const verdict = status.verdict || 'UNKNOWN';
  const files = diffStats(diff);
  const coverage = coverageTable(specs, review);
  const trend = testTrend(history);
  const totals = files.reduce((a, f) => ({ added: a.added + f.added, removed: a.removed + f.removed }), { added: 0, removed: 0 });

  const metaBits = [
    feature?.id ? `Feature ${escapeHtml(feature.id)}` : null,
    runId ? `Run <code>${escapeHtml(runId)}</code>` : null,
    status.branch ? `Branch <code>${escapeHtml(status.branch)}</code>` : null,
    status.endedAt ? `Completed ${escapeHtml(String(status.endedAt).replace('T', ' ').slice(0, 16))}` : null,
  ].filter(Boolean).join(' &middot; ');

  const html = [
    `<!doctype html><html lang="en"><head><meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width,initial-scale=1">`,
    `<title>${escapeHtml(title)}</title><style>${styleBlock()}</style></head><body><main>`,
    `<h1>${escapeHtml(title)}</h1>`,
    `<p class="meta">${metaBits}${metaBits ? ' &middot; ' : ''}<span class="badge ${verdict === 'APPROVED' ? 'approved' : 'other'}">${escapeHtml(verdict)}</span>`,
    pr?.url ? ` &middot; <a href="${escapeHtml(pr.url)}">pull request</a>` : '',
    `</p>`,

    section('Summary', narrativeSection(narrative, 'Summary') || '<p class="note">No narrative was recorded for this run.</p>'),
    section('What changed', narrativeSection(narrative, 'What Changed')),

    files.length ? section('Files', [
      '<table><thead><tr><th>File</th><th>Change</th><th>+</th><th>&minus;</th></tr></thead><tbody>',
      ...files.map((f) => `<tr><td><code>${escapeHtml(f.file)}</code></td><td>${STATUS_LABEL[f.status] || 'changed'}${f.binary ? ' (binary)' : ''}</td><td>${f.added}</td><td>${f.removed}</td></tr>`),
      `</tbody></table><p class="meta">${files.length} file(s), +${totals.added} &minus;${totals.removed}</p>`,
    ].join('\n')) : '',

    coverage.length ? section('Specification coverage', [
      '<table><thead><tr><th>ID</th><th>Case</th><th>Status</th><th>Evidence</th></tr></thead><tbody>',
      ...coverage.map((c) => `<tr><td><code>${escapeHtml(c.id)}</code></td><td>${escapeHtml(c.name)}</td><td class="${c.status}">${escapeHtml(c.status)}</td><td>${escapeHtml(c.evidence)}</td></tr>`),
      '</tbody></table>',
    ].join('\n')) : '',

    trend.length ? section('Verification', [
      `<p>${trend.map((t) => `${t.passed} passed / ${t.failed} failed`).join(' &rarr; ')}</p>`,
      status.stages?.find((s) => s.name === 'tester')?.checks
        ? `<p class="meta">Final: ${status.stages.find((s) => s.name === 'tester').checks.passedCount} passing.</p>` : '',
    ].join('\n')) : '',

    decisions.length ? section('Decisions taken', [
      '<table><thead><tr><th>Question</th><th>Answer</th><th>By</th></tr></thead><tbody>',
      ...decisions.map((d) => `<tr><td>${escapeHtml(d.question || '')}</td><td>${escapeHtml(d.decision || '')}</td><td>${escapeHtml(d.by || '')}</td></tr>`),
      '</tbody></table>',
    ].join('\n')) : '',

    diagrams.length ? section('Diagrams', diagrams.map((d) => (d.ok
      // Sandboxed with no same-origin access: an interactive diagram may run its
      // own scripts, but it can never read or act on the page embedding it.
      ? `<figure><iframe src="diagrams/${escapeHtml(d.htmlRel)}" sandbox="allow-scripts" loading="lazy" title="${escapeHtml(d.id)}"></iframe><figcaption>${escapeHtml(d.type)} &middot; <code>${escapeHtml(d.id)}</code>${d.sha256 ? ` &middot; sha256 ${escapeHtml(d.sha256.slice(0, 12))}` : ''}</figcaption></figure>`
      : `<p class="note">Diagram <code>${escapeHtml(d.id)}</code> was omitted: ${escapeHtml(d.error || 'it could not be produced')}.</p>`)).join('\n')) : '',

    section('Rough edges and follow-ups', narrativeSection(narrative, 'Rough Edges & Follow-ups')),
    section('Key decisions and deviations', narrativeSection(narrative, 'Key Decisions & Deviations')),

    `<footer>Compiled by the orchestrator on ${escapeHtml(generatedAt.toISOString().replace('T', ' ').slice(0, 16))}. `,
    `Figures are derived from the run's own diff and artifacts, not from the narrative.</footer>`,
    `</main></body></html>`,
  ].filter(Boolean).join('\n');

  const md = [
    `# ${title}`, '',
    `${feature?.id ? `Feature ${feature.id} · ` : ''}Review verdict: **${verdict}**`, '',
    plain(narrativeSection(narrative, 'Summary')) || '_No narrative was recorded._', '',
    files.length ? `## Files\n\n${files.map((f) => `- \`${f.file}\` — ${STATUS_LABEL[f.status] || 'changed'} (+${f.added}/-${f.removed})`).join('\n')}\n` : '',
    coverage.length ? `## Specification coverage\n\n${coverage.map((c) => `- \`${c.id}\` — ${c.status}${c.evidence ? ` (${c.evidence})` : ''}`).join('\n')}\n` : '',
    plain(narrativeSection(narrative, 'Rough Edges & Follow-ups')) ? `## Rough edges and follow-ups\n\n${plain(narrativeSection(narrative, 'Rough Edges & Follow-ups'))}\n` : '',
  ].filter(Boolean).join('\n');

  return { html, md, computed: { files, coverage, trend, totals } };
}

function plain(html) {
  return String(html || '').replace(/<[^>]+>/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

/** Write the report next to the run that produced it. Best-effort by design. */
export function writeWorkDoneReport(paths, payload) {
  try {
    const { html, md, computed } = compileWorkDoneReport(payload);
    fs.mkdirSync(path.join(paths.reports, 'diagrams'), { recursive: true });
    atomicWrite(path.join(paths.reports, 'work-done.html'), html);
    atomicWrite(path.join(paths.reports, 'work-done.md'), md);
    atomicWrite(path.join(paths.reports, 'report.json'), JSON.stringify({
      runId: payload.runId ?? null,
      featureId: payload.feature?.id ?? null,
      verdict: payload.status?.verdict ?? null,
      generatedAt: new Date().toISOString(),
      files: computed.files.length,
      coverage: computed.coverage,
      diagrams: (payload.diagrams || []).map((d) => ({ id: d.id, type: d.type, ok: !!d.ok, sha256: d.sha256 ?? null, error: d.error ?? null })),
      htmlSha256: hashFile(path.join(paths.reports, 'work-done.html')),
    }, null, 2));
    return { ok: true, htmlRel: path.relative(paths.root, path.join(paths.reports, 'work-done.html')) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
