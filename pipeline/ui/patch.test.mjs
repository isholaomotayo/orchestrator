// node:test has no DOM, so patch.mjs's reconciliation algorithm is exercised
// against a minimal hand-rolled fake node — just enough of the Node/Element
// surface patch.mjs actually touches (children, firstChild, nextSibling,
// insertBefore, replaceWith, remove, dataset) to prove the algorithm itself is
// correct. Real focus/value preservation in an actual browser is covered
// separately by tests/browser/control-room.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { patchRegion, patchList } from './patch.mjs';

class FakeNode {
  constructor(tag) {
    this.tag = tag;
    this.dataset = {};
    this.parentNode = null;
    this._children = [];
  }
  get children() { return this._children.slice(); }
  get firstChild() { return this._children[0] || null; }
  get nextSibling() {
    if (!this.parentNode) return null;
    const i = this.parentNode._children.indexOf(this);
    return i === -1 ? null : (this.parentNode._children[i + 1] || null);
  }
  insertBefore(node, ref) {
    if (node.parentNode) node.parentNode._detach(node);
    if (ref == null) this._children.push(node);
    else {
      const i = this._children.indexOf(ref);
      if (i === -1) this._children.push(node);
      else this._children.splice(i, 0, node);
    }
    node.parentNode = this;
    return node;
  }
  _detach(node) {
    const i = this._children.indexOf(node);
    if (i !== -1) this._children.splice(i, 1);
    node.parentNode = null;
  }
  remove() { if (this.parentNode) this.parentNode._detach(this); }
  replaceWith(node) {
    if (!this.parentNode) return;
    const parent = this.parentNode;
    if (node.parentNode) node.parentNode._detach(node);
    const i = parent._children.indexOf(this);
    parent._children[i] = node;
    node.parentNode = parent;
    this.parentNode = null;
  }
  replaceChildren() {
    for (const c of this._children) c.parentNode = null;
    this._children = [];
  }
}

function node(tag = 'div') { return new FakeNode(tag); }
function order(host) { return host.children.map((c) => c.tag); }

// ---- patchRegion ------------------------------------------------------------

test('patchRegion renders on first call and skips a repeat with the same signature', () => {
  const host = node();
  let calls = 0;
  const render = (h) => { calls++; h.insertBefore(node('x'), null); };
  assert.equal(patchRegion(host, 'a', render), true);
  assert.equal(calls, 1);
  assert.deepEqual(order(host), ['x']);
  assert.equal(patchRegion(host, 'a', render), false, 'same signature is a no-op');
  assert.equal(calls, 1);
});

test('patchRegion re-renders when the signature changes, replacing prior content', () => {
  const host = node();
  patchRegion(host, 'a', (h) => h.insertBefore(node('old'), null));
  patchRegion(host, 'b', (h) => h.insertBefore(node('new'), null));
  assert.deepEqual(order(host), ['new']);
});

test('patchRegion tolerates a missing host rather than throwing', () => {
  assert.equal(patchRegion(null, 'a', () => { throw new Error('must not be called'); }), false);
});

// ---- patchList ---------------------------------------------------------------

function renderItem(item) {
  const n = node(item.id);
  n.value = item.label;
  return n;
}

test('patchList renders new items in order and tags them with key+sig', () => {
  const host = node();
  patchList(host, [{ id: 'a', label: '1' }, { id: 'b', label: '1' }], {
    key: (i) => i.id, sig: (i) => i.label, render: renderItem,
  });
  assert.deepEqual(order(host), ['a', 'b']);
  assert.equal(host.children[0].dataset.key, 'a');
  assert.equal(host.children[0].dataset.sig, '1');
});

test('patchList leaves an unchanged item\'s exact node untouched — the actual fix', () => {
  const host = node();
  const items = [{ id: 'a', label: '1' }, { id: 'b', label: '1' }];
  patchList(host, items, { key: (i) => i.id, sig: (i) => i.label, render: renderItem });
  const nodeA = host.children[0];
  nodeA.liveState = 'user was typing this';

  patchList(host, items, { key: (i) => i.id, sig: (i) => i.label, render: renderItem });
  assert.equal(host.children[0], nodeA, 'same node instance, not a new one');
  assert.equal(host.children[0].liveState, 'user was typing this', 'live state on the node survives');
});

test('patchList replaces only the item whose signature changed', () => {
  const host = node();
  patchList(host, [{ id: 'a', label: '1' }, { id: 'b', label: '1' }], {
    key: (i) => i.id, sig: (i) => i.label, render: renderItem,
  });
  const nodeA = host.children[0];
  const nodeB = host.children[1];

  patchList(host, [{ id: 'a', label: '1' }, { id: 'b', label: '2' }], {
    key: (i) => i.id, sig: (i) => i.label, render: renderItem,
  });
  assert.equal(host.children[0], nodeA, 'a is unchanged, same node');
  assert.notEqual(host.children[1], nodeB, 'b changed signature, got a new node');
  assert.equal(host.children[1].dataset.sig, '2');
});

test('patchList removes a node whose key is no longer present', () => {
  const host = node();
  patchList(host, [{ id: 'a', label: '1' }, { id: 'b', label: '1' }], {
    key: (i) => i.id, sig: (i) => i.label, render: renderItem,
  });
  patchList(host, [{ id: 'a', label: '1' }], { key: (i) => i.id, sig: (i) => i.label, render: renderItem });
  assert.deepEqual(order(host), ['a']);
});

test('patchList reorders existing nodes in place without recreating them', () => {
  const host = node();
  patchList(host, [{ id: 'a', label: '1' }, { id: 'b', label: '1' }, { id: 'c', label: '1' }], {
    key: (i) => i.id, sig: (i) => i.label, render: renderItem,
  });
  const [nodeA, nodeB, nodeC] = host.children;

  patchList(host, [{ id: 'c', label: '1' }, { id: 'a', label: '1' }, { id: 'b', label: '1' }], {
    key: (i) => i.id, sig: (i) => i.label, render: renderItem,
  });
  assert.deepEqual(order(host), ['c', 'a', 'b']);
  assert.equal(host.children[0], nodeC);
  assert.equal(host.children[1], nodeA);
  assert.equal(host.children[2], nodeB);
});

test('patchList handles a full swap: some removed, some added, some reordered, some unchanged, in one pass', () => {
  const host = node();
  patchList(host, [{ id: 'a', label: '1' }, { id: 'b', label: '1' }, { id: 'c', label: '1' }], {
    key: (i) => i.id, sig: (i) => i.label, render: renderItem,
  });
  const nodeB = host.children[1];

  patchList(host, [{ id: 'd', label: '1' }, { id: 'b', label: '1' }], {
    key: (i) => i.id, sig: (i) => i.label, render: renderItem,
  });
  assert.deepEqual(order(host), ['d', 'b']);
  assert.equal(host.children[1], nodeB, 'b survives the reorder+partial-removal untouched');
});

test('patchList on an empty item list removes everything', () => {
  const host = node();
  patchList(host, [{ id: 'a', label: '1' }], { key: (i) => i.id, sig: (i) => i.label, render: renderItem });
  patchList(host, [], { key: (i) => i.id, sig: (i) => i.label, render: renderItem });
  assert.deepEqual(order(host), []);
});

test('patchList starting from an empty host with no items renders nothing and does not throw', () => {
  const host = node();
  assert.doesNotThrow(() => patchList(host, [], { key: (i) => i.id, sig: (i) => i.label, render: renderItem }));
  assert.deepEqual(order(host), []);
});
