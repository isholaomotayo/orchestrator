import fs from 'node:fs';
export function readUsage(file) {
  let total = 0, measured = 0, partial = false;
  let raw; try { raw = fs.readFileSync(file,'utf8'); } catch { return {costUsd:null, measured:0, partial:true}; }
  for (const line of raw.split('\n').filter(Boolean)) {
    try { const e = JSON.parse(line); if (typeof e.costUsd === 'number' && Number.isFinite(e.costUsd)) {total += e.costUsd; measured++;} }
    catch { partial = true; }
  }
  return {costUsd:measured ? total : null,measured,partial:partial || measured === 0};
}
