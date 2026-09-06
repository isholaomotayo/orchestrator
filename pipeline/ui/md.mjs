// Markdown, code and diff rendering for the dashboard.
//
// Lifted from the single-file dashboard so it can be unit-tested without a
// browser. The escaping discipline is the point: every input here is text an
// agent wrote after reading a repository that may contain anything, so content
// is escaped first and decorated afterwards — never the other way round.

export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function hl(code) {
  return esc(code)
    .replace(/(\/\/[^\n]*)/g, '<span class="cmt">$1</span>')
    .replace(/('[^']*'|"[^"]*"|`[^`]*`)/g, '<span class="str">$1</span>')
    .replace(/\b(export|import|from|function|const|let|var|return|async|await|if|else|throw|new|class|interface|type|extends)\b/g, '<span class="kw">$1</span>')
    .replace(/\b(string|number|boolean|void|Promise|Record|Array)\b/g, '<span class="typ">$1</span>');
}

export function renderMd(md) {
  const blocks = md.split(/```/);
  let html = '';
  blocks.forEach((block, i) => {
    if (i % 2 === 1) {
      const nl = block.indexOf('\n');
      html += '<pre><code>' + hl(nl >= 0 ? block.slice(nl + 1) : block) + '</code></pre>';
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
