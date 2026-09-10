// Turning one feature's specification into independently runnable tickets.
//
// The Planner already emits "Tracer-Bullet Tickets" in a fixed skeleton (see
// .pipeline/prompts/planner_prompt.txt): a vertical slice per ticket, each
// naming the files it touches and the tickets it depends on. That is exactly
// the information a scheduler needs, so nothing new is asked of the Planner —
// this module just reads what it already writes.
//
// A ticket becomes one worker run against a slice of the spec. The slice keeps
// the shared context (objective, failure modes) and drops the other tickets, so
// a worker cannot wander outside its lane.

const TICKET_SECTION_RE = /^##\s+3\.\s*Tracer-Bullet Tickets\s*$/im;
const TICKET_HEADING_RE = /^###\s*Ticket\s+(\d+)\s*:\s*(.+?)\s*$/gim;

function fieldValue(body, label) {
  const lines = body.split('\n');
  const re = new RegExp(`^\\s*[-*]\\s*\\*\\*${label}:?\\*\\*[ \t]*(.*)$`, 'i');
  const index = lines.findIndex(line => re.test(line));
  if (index < 0) return '';
  const first = re.exec(lines[index])[1].trim();
  if (first) return first;
  const values = [];
  for (const line of lines.slice(index + 1)) {
    if (/^\s*[-*]\s*\*\*|^#{2,}|^---/.test(line)) break;
    if (line.trim()) values.push(line.trim().replace(/^[-*]\s+/, ''));
  }
  return values.join(', ');
}

function splitList(value) {
  return value
    .split(/[,;]/)
    .map((v) => v.trim().replace(/^`|`$/g, '').replace(/\\/g, '/').replace(/^\.\//, ''))
    .filter((v) => v && !/^\[.*\]$/.test(v));
}

/**
 * Parse the ticket section of a specification.
 * @returns {{id:string,title:string,files:string[],dependsOn:string[],body:string}[]}
 */
export function parseTickets(specs) {
  const text = String(specs || '');
  const sectionStart = TICKET_SECTION_RE.exec(text);
  if (!sectionStart) return [];
  const section = text.slice(sectionStart.index);

  const headings = [...section.matchAll(TICKET_HEADING_RE)];
  const result = headings.map((heading, i) => {
    const start = heading.index;
    const end = i + 1 < headings.length ? headings[i + 1].index : section.length;
    const block = section.slice(start, end);
    const body = block.slice(heading[0].length).trim();
    const deps = fieldValue(body, 'Dependencies');
    return {
      id: `T${heading[1]}`,
      title: heading[2].trim(),
      files: splitList(fieldValue(body, 'Files')),
      // "None", "none", "" and a placeholder all mean the same thing: nothing
      // to wait for. Anything else is read as a list of ticket numbers.
      dependsOn: /^\s*(none)?\s*$/i.test(deps)
        ? []
        : [...deps.matchAll(/(?:ticket\s*|\bT)(\d+)/gi)].map((m) => `T${m[1]}`),
      // Optional per-ticket override of the feature's runner. Inert until a
      // Planner or a human writes a "**Runner:**" line into specs.md — no
      // prompt change required for it to take effect.
      runner: fieldValue(body, 'Runner') || null,
      body,
      block: block.trim(),
    };
  });
  validateTickets(result);
  return result;
}

export function validateTickets(tickets) {
  const ids = new Set();
  for (const t of tickets) {
    if (ids.has(t.id)) throw new Error(`Duplicate ticket ${t.id}`);
    ids.add(t.id);
    for (const file of t.files) if (file.startsWith('/') || file.split('/').includes('..') || /[`\n]/.test(file)) throw new Error(`Invalid file scope for ${t.id}: ${file}`);
  }
  const visiting = new Set(), visited = new Set();
  function visit(id) {
    if (!ids.has(id)) throw new Error(`Unknown ticket dependency ${id}`);
    if (visiting.has(id)) throw new Error(`Ticket dependency cycle at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of tickets.find(t => t.id === id).dependsOn) visit(dep);
    visiting.delete(id); visited.add(id);
  }
  tickets.forEach(t => visit(t.id));
}

/**
 * The specification a single ticket's worker should receive: everything before
 * the ticket section (objective, failure modes — shared context every ticket
 * needs) plus that one ticket.
 *
 * The result must still satisfy the planner artifact contract, because the
 * worker is handed it as its own specs.md.
 */
export function sliceSpecForTicket(specs, ticketId) {
  const text = String(specs || '');
  const tickets = parseTickets(text);
  const ticket = tickets.find((t) => t.id === ticketId);
  if (!ticket) throw new Error(`Unknown ticket "${ticketId}" in this specification.`);
  const sectionStart = TICKET_SECTION_RE.exec(text);
  const shared = text.slice(0, sectionStart.index).trimEnd();
  return `${shared}\n\n## 3. Tracer-Bullet Tickets\n\n${ticket.block}\n`;
}

/**
 * Which tickets may start right now.
 *
 * Two constraints beyond dependencies:
 *  - `maxParallel` counts tickets already running, so a wave never oversubscribes.
 *  - `serializeOnFileOverlap` holds back a ticket whose declared files are being
 *    edited by a running one. The file lists are a planner's estimate, not
 *    ground truth — the merge at fan-in is the real check — but deferring a
 *    likely conflict is far cheaper than resolving one.
 */
export function scheduleTickets(tickets, {
  done = [], running = [], maxParallel = 3,
  runningFiles = {}, serializeOnFileOverlap = true,
} = {}) {
  const doneSet = new Set(done);
  const runningSet = new Set(running);
  const slots = Math.max(0, maxParallel - runningSet.size);
  if (!slots) return [];

  const busyFiles = new Set(Object.values(runningFiles).flat());
  const ready = [];
  for (const ticket of tickets) {
    if (ready.length >= slots) break;
    if (doneSet.has(ticket.id) || runningSet.has(ticket.id)) continue;
    if (!ticket.dependsOn.every((d) => doneSet.has(d))) continue;
    if (serializeOnFileOverlap && ((running.length || ready.length) && (!ticket.files.length || Object.values(runningFiles).some(f => !f.length)) || ticket.files.some(f => [...busyFiles].some(b => f === b || f.startsWith(b + '/') || b.startsWith(f + '/'))))) continue;
    ready.push(ticket);
    // Treat this ticket's files as busy for the rest of the wave, so two
    // tickets picked in the same tick cannot collide with each other either.
    if (serializeOnFileOverlap) for (const f of ticket.files) busyFiles.add(f);
  }
  return ready;
}
