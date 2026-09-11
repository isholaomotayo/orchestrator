// Two small, framework-free rendering primitives that replace an unconditional
// `wrap.replaceChildren()` with "only touch what actually changed."
//
// This generalizes two patterns that already existed ad hoc in this codebase —
// viewRun's per-field dataset.sig checks (fillGoal/fillControls/fillBanners/
// fillArtifact) and viewRuns' hand-rolled signature+patch closure — into
// something every view can reach for, instead of re-deriving the same fix
// per view. The bug both patterns exist to prevent: a background refresh (an
// SSE event, the 15s poll) rebuilding a region from scratch destroys any live
// state inside it — a focused input, a typed-but-unsent textarea, scroll
// position — with no way to recover it. Untouched DOM nodes keep all of that
// for free; recreated ones lose it, silently.

/**
 * Re-render a region only if what it should show has actually changed.
 *
 * @param {HTMLElement} host   a stable container the caller creates once (on
 *                             first mount) and never recreates — only this
 *                             function empties/refills it.
 * @param {string} sig         a cheap string describing "what would be
 *                             rendered this time" — build it the same way
 *                             fillControls already does, e.g.
 *                             `[a, b, c].join('|')` or `JSON.stringify([...])`.
 * @param {(host: HTMLElement) => void} render  called with `host` already
 *                             emptied; appends whatever this region should show.
 * @returns {boolean} true if it actually re-rendered, false if it was a no-op.
 */
export function patchRegion(host, sig, render) {
  if (!host || host.dataset.sig === sig) return false;
  host.dataset.sig = sig;
  host.replaceChildren();
  render(host);
  return true;
}

/**
 * Reconcile a list of items against persistent DOM nodes by a stable key,
 * instead of tearing the whole list down on every refresh.
 *
 * - An item whose key already has a node AND whose signature is unchanged is
 *   left completely untouched — any live input inside it (a decision card's
 *   <textarea>, its focus, its cursor position) survives.
 * - An item whose signature changed gets its node replaced via `replaceWith`,
 *   which does not disturb sibling nodes.
 * - A new key gets rendered and inserted in list order.
 * - A key no longer present gets removed.
 * - Existing, unchanged nodes are reordered in place (`insertBefore`) to
 *   match new item order, never recreated — moving a node this way does not
 *   reset its focus or an input's value.
 *
 * @param {HTMLElement} host   the persistent list container.
 * @param {any[]} items
 * @param {{ key: (item: any) => string|number, sig: (item: any) => string, render: (item: any) => HTMLElement }} opts
 * @returns {void}
 */
export function patchList(host, items, { key, sig, render }) {
  const existing = new Map();
  for (const child of Array.from(host.children)) {
    if (child.dataset.key != null) existing.set(child.dataset.key, child);
  }
  const seen = new Set();
  let cursor = host.firstChild;
  for (const item of items) {
    const k = String(key(item));
    seen.add(k);
    const wantSig = String(sig(item));
    let node = existing.get(k);
    if (!node) {
      node = render(item);
      node.dataset.key = k;
      node.dataset.sig = wantSig;
    } else if (node.dataset.sig !== wantSig) {
      const fresh = render(item);
      fresh.dataset.key = k;
      fresh.dataset.sig = wantSig;
      node.replaceWith(fresh);
      node = fresh;
    }
    if (cursor !== node) host.insertBefore(node, cursor);
    cursor = node.nextSibling;
  }
  for (const [k, node] of existing) if (!seen.has(k)) node.remove();
}
