// Offline renderer for the sequence-diagram subset emitted in stage artifacts.
// It uses escaped SVG text, so diagrams remain readable after a run and do not
// need a CDN, a browser extension, or an authenticated diagram service.
const xml = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const wrap = (value, limit = 52) => {
  const words = String(value).split(/\s+/);
  const lines = [''];
  for (const word of words) {
    const last = lines.length - 1;
    if (lines[last] && lines[last].length + word.length + 1 > limit) lines.push(word);
    else lines[last] += `${lines[last] ? ' ' : ''}${word}`;
  }
  return lines;
};

export function renderSequenceDiagramSvg(source) {
  const lines = String(source || '').trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.shift() !== 'sequenceDiagram') return null;
  const actors = new Map();
  const messages = [];
  let autonumber = false;
  for (const line of lines) {
    if (line === 'autonumber') { autonumber = true; continue; }
    if (line.startsWith('%%')) continue;
    const actor = /^(?:actor|participant)\s+([\w.-]+)(?:\s+as\s+(.+))?$/.exec(line);
    if (actor) {
      if (!actors.has(actor[1])) actors.set(actor[1], actor[2] || actor[1]);
      continue;
    }
    const message = /^([\w.-]+)(-->>|->>|-->|->|--x|-x)([\w.-]+):\s*(.+)$/.exec(line);
    if (!message) return null; // Unsupported Mermaid must remain visible as source.
    for (const id of [message[1], message[3]]) if (!actors.has(id)) actors.set(id, id);
    messages.push({ from: message[1], to: message[3], arrow: message[2], text: message[4] });
  }
  if (!actors.size || !messages.length || actors.size > 12 || messages.length > 120) return null;

  const ids = [...actors.keys()];
  const spacing = 270;
  const width = Math.max(800, 240 + (ids.length - 1) * spacing + 240);
  const xOf = (id) => 140 + ids.indexOf(id) * spacing;
  const rows = [];
  let y = 112;
  for (const [index, message] of messages.entries()) {
    const label = `${autonumber ? `${index + 1}. ` : ''}${message.text}`;
    const textLines = wrap(label);
    rows.push({ ...message, y, textLines });
    y += Math.max(68, textLines.length * 19 + 38);
  }
  const height = y + 35;
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Sequence diagram">`,
    '<defs><marker id="seq-arrow" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto"><path d="M0 0 L9 4.5 L0 9" fill="none" stroke="#475569" stroke-width="1.5"/></marker></defs>',
    `<rect width="${width}" height="${height}" fill="#fff"/>`];
  for (const id of ids) {
    const x = xOf(id);
    parts.push(`<rect x="${x - 98}" y="18" width="196" height="46" rx="8" fill="#f1f5f9" stroke="#cbd5e1"/>`);
    parts.push(`<text x="${x}" y="47" text-anchor="middle" font-family="system-ui,sans-serif" font-size="14" fill="#0f172a">${xml(actors.get(id))}</text>`);
    parts.push(`<line x1="${x}" y1="64" x2="${x}" y2="${height - 20}" stroke="#cbd5e1" stroke-dasharray="5 5"/>`);
  }
  for (const row of rows) {
    const from = xOf(row.from);
    const to = xOf(row.to);
    const self = from === to;
    const x1 = self ? from : from + (to > from ? 8 : -8);
    const x2 = self ? from : to + (to > from ? -8 : 8);
    const labelX = self ? Math.min(width - 100, from + 100) : (from + to) / 2;
    const textY = row.y - 16 - (row.textLines.length - 1) * 19;
    const strokeDash = row.arrow.startsWith('--') ? ' stroke-dasharray="5 4"' : '';
    parts.push(`<text x="${labelX}" y="${textY}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="13" fill="#334155">${row.textLines.map((line, i) => `<tspan x="${labelX}" dy="${i ? 19 : 0}">${xml(line)}</tspan>`).join('')}</text>`);
    if (self) parts.push(`<path d="M${from} ${row.y} h62 v25 h-62" fill="none" stroke="#475569" stroke-width="1.5" marker-end="url(#seq-arrow)"${strokeDash}/>`);
    else parts.push(`<line x1="${x1}" y1="${row.y}" x2="${x2}" y2="${row.y}" stroke="#475569" stroke-width="1.5" marker-end="url(#seq-arrow)"${strokeDash}/>`);
  }
  parts.push('</svg>');
  return parts.join('');
}
