// Markdown, code and diff rendering for the dashboard.
//
// Lifted from the single-file dashboard so it can be unit-tested without a
// browser. The escaping discipline is the point: every input here is text an
// agent wrote after reading a repository that may contain anything, so content
// is escaped first and decorated afterwards — never the other way round.
import { renderSequenceDiagramSvg } from '../sequence-diagram.mjs';

export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function hl(code) {
  // Match source tokens before writing markup. Re-running regexes over emitted
  // spans used to corrupt Mermaid labels containing words such as "class".
  const tokens = /\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:export|import|from|function|const|let|var|return|async|await|if|else|throw|new|class|interface|type|extends|string|number|boolean|void|Promise|Record|Array)\b/g;
  let html = '';
  let offset = 0;
  for (const match of String(code).matchAll(tokens)) {
    html += esc(code.slice(offset, match.index));
    const token = match[0];
    const kind = token.startsWith('//') ? 'cmt' : /^['"`]/.test(token) ? 'str'
      : /^(string|number|boolean|void|Promise|Record|Array)$/.test(token) ? 'typ' : 'kw';
    html += `<span class="${kind}">${esc(token)}</span>`;
    offset = match.index + token.length;
  }
  return html + esc(code.slice(offset));
}

export function renderMd(md) {
  const blocks = md.split(/```/);
  let html = '';
  blocks.forEach((block, i) => {
    if (i % 2 === 1) {
      const nl = block.indexOf('\n');
      const source = nl >= 0 ? block.slice(nl + 1) : block;
      const language = nl >= 0 ? block.slice(0, nl).trim().toLowerCase() : '';
      const isSequence = language === 'mermaid' || /^sequenceDiagram\b/.test(source.trim());
      const diagram = isSequence ? renderSequenceDiagramSvg(source) : null;
      html += diagram
        ? `<figure class="sequence-diagram">${diagram}<details><summary>Sequence source</summary><pre><code>${esc(source)}</code></pre></details></figure>`
        : `${isSequence ? '<p class="diagram-error">Sequence diagram could not be rendered; source follows.</p>' : ''}<pre><code>${hl(source)}</code></pre>`;
      return;
    }
    const lines = block.split('\n');
    let inList = false, para = [];
    const flush = () => { if (para.length) { html += '<p>' + para.join(' ') + '</p>'; para = []; } };
    const inline = (s) => esc(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*(?!\s)([^*]+)\*/g, '<em>$1</em>');
    const isTableRow = (l) => /\|/.test(l) && /^\s*\|?.*\|.*$/.test(l);
    const isTableSep = (l) => /^\s*\|?(\s*:?-{2,}:?\s*\|)+\s*:?-{2,}:?\s*\|?\s*$/.test(l) || /^\s*\|(\s*:?-{2,}:?\s*\|)+\s*$/.test(l);
    const splitRow = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      if (isTableRow(line) && li + 1 < lines.length && isTableSep(lines[li + 1])) {
        flush(); if (inList) { html += '</ul>'; inList = false; }
        const headers = splitRow(line);
        let body = '';
        li += 2;
        while (li < lines.length && isTableRow(lines[li]) && !isTableSep(lines[li])) {
          const cells = splitRow(lines[li]);
          body += '<tr>' + headers.map((_, ci) => `<td>${inline(cells[ci] ?? '')}</td>`).join('') + '</tr>';
          li++;
        }
        li--;
        html += '<table><thead><tr>' + headers.map((hd) => `<th>${inline(hd)}</th>`).join('') + '</tr></thead><tbody>' + body + '</tbody></table>';
        continue;
      }
      const h = line.match(/^(#{1,4})\s+(.*)/);
      if (h) { flush(); if (inList) { html += '</ul>'; inList = false; } html += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`; continue; }
      if (/^\s*[-*]\s+/.test(line)) { flush(); if (!inList) { html += '<ul>'; inList = true; } html += '<li>' + inline(line.replace(/^\s*[-*]\s+/, '')) + '</li>'; continue; }
      if (inList && line.trim() === '') { html += '</ul>'; inList = false; continue; }
      if (/^\s*---+\s*$/.test(line)) { flush(); html += '<hr>'; continue; }
      if (line.trim() === '') { flush(); continue; }
      para.push(inline(line));
    }
    flush(); if (inList) html += '</ul>';
  });
  return html;
}
