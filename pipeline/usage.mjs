import fs from 'node:fs';

// events.jsonl only ever grows (until a run is archived and a new one starts),
// so the cost total is kept per file and only the bytes appended since the last
// read are parsed. A shrunk or replaced file starts over.
const tails = new Map();

function addLine(acc, line) {
  if (!line.trim()) return;
  try {
    const e = JSON.parse(line);
    if (typeof e.costUsd === 'number' && Number.isFinite(e.costUsd)) { acc.total += e.costUsd; acc.measured++; }
  } catch { acc.bad = true; }
}

export function readUsage(file) {
  let st;
  try { st = fs.statSync(file); } catch { tails.delete(file); return { costUsd: null, measured: 0, partial: true }; }
  let t = tails.get(file);
  if (!t || t.ino !== st.ino || st.size < t.offset) t = { ino: st.ino, offset: 0, total: 0, measured: 0, bad: false };
  let fragment = '';
  if (st.size > t.offset) {
    const buf = Buffer.alloc(st.size - t.offset);
    const fd = fs.openSync(file, 'r');
    let n = 0;
    try { n = fs.readSync(fd, buf, 0, buf.length, t.offset); } finally { fs.closeSync(fd); }
    const chunk = buf.subarray(0, n);
    const end = chunk.lastIndexOf(10) + 1; // only newline-terminated lines are final
    for (const line of chunk.subarray(0, end).toString('utf8').split('\n')) addLine(t, line);
    t.offset += end;
    fragment = chunk.subarray(end).toString('utf8');
  }
  tails.set(file, t);
  // A last line without its newline is counted for this answer but re-read next time.
  const acc = { ...t };
  addLine(acc, fragment);
  return { costUsd: acc.measured ? acc.total : null, measured: acc.measured, partial: acc.bad || acc.measured === 0 };
}
