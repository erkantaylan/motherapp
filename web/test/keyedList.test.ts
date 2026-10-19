import { test } from "node:test";
import assert from "node:assert/strict";
import { KeyedList, listEntries } from "../src/keyedList.ts";
import type { Row, RowHost } from "../src/keyedList.ts";

interface FakeNode {
  key: string;
  label: string;
}

/** Array-backed host that records every DOM-like operation. */
function fakeHost() {
  const children: FakeNode[] = [];
  const ops: string[] = [];
  const host: RowHost<FakeNode> = {
    insertBefore(node, ref) {
      const i = children.indexOf(node);
      if (i >= 0) children.splice(i, 1);
      const at = ref ? children.indexOf(ref) : children.length;
      children.splice(at, 0, node);
      ops.push(`${i >= 0 ? "move" : "insert"} ${node.key}`);
    },
    remove(node) {
      children.splice(children.indexOf(node), 1);
      ops.push(`remove ${node.key}`);
    },
    nextSibling(node) {
      return children[children.indexOf(node) + 1] ?? null;
    },
  };
  return { host, children, ops, order: () => children.map((c) => c.key).join(",") };
}

function setup() {
  const h = fakeHost();
  const created: string[] = [];
  const destroyed: string[] = [];
  const list = new KeyedList<{ name: string }, FakeNode>(h.host, (key, item): Row<{ name: string }, FakeNode> => {
    created.push(key);
    const node: FakeNode = { key, label: item.name };
    return { node, update: (it) => (node.label = it.name), destroy: () => destroyed.push(key) };
  });
  return { ...h, list, created, destroyed };
}

const e = (...keys: string[]) => keys.map((k) => [k, { name: k.toUpperCase() }] as const);

test("rows are created once and updated in place", () => {
  const s = setup();
  s.list.update(e("a", "b", "c"));
  assert.equal(s.order(), "a,b,c");
  const nodeB = s.children[1];
  s.ops.length = 0;
  s.list.update([["a", { name: "A" }], ["b", { name: "B2" }], ["c", { name: "C" }]]);
  assert.deepEqual(s.ops, [], "no DOM operations when only item content changes");
  assert.equal(s.children[1], nodeB, "same node object kept");
  assert.equal(nodeB!.label, "B2");
  assert.deepEqual(s.created, ["c", "b", "a"]);
});

test("additions and removals touch only the affected rows", () => {
  const s = setup();
  s.list.update(e("a", "b", "c"));
  const [na, , nc] = s.children;
  s.ops.length = 0;
  s.list.update(e("a", "x", "c", "d"));
  assert.equal(s.order(), "a,x,c,d");
  assert.deepEqual(s.ops.sort(), ["insert d", "insert x", "remove b"]);
  assert.deepEqual(s.destroyed, ["b"]);
  assert.equal(s.children[0], na);
  assert.equal(s.children[2], nc);
});

test("reorders move existing rows without recreating them", () => {
  const s = setup();
  s.list.update(e("a", "b", "c", "d"));
  const before = new Set(s.children);
  s.ops.length = 0;
  s.list.update(e("d", "a", "b", "c"));
  assert.equal(s.order(), "d,a,b,c");
  assert.ok(s.children.every((n) => before.has(n)));
  assert.equal(s.created.length, 4);
  assert.ok(s.ops.every((o) => o.startsWith("move")));
  s.list.update(e("c", "b", "a", "d"));
  assert.equal(s.order(), "c,b,a,d");
  assert.deepEqual(s.list.keys(), ["c", "b", "a", "d"]);
});

test("duplicates are ignored, clear() removes everything", () => {
  const s = setup();
  s.list.update([...e("a", "b"), ["a", { name: "dup" }]]);
  assert.equal(s.order(), "a,b");
  assert.equal(s.children[0]!.label, "A");
  s.list.clear();
  assert.equal(s.order(), "");
  assert.deepEqual(s.destroyed.sort(), ["a", "b"]);
  assert.equal(s.list.size, 0);
});

test("listEntries: object maps only, optional sort by field then key", () => {
  assert.deepEqual(listEntries(undefined), []);
  assert.deepEqual(listEntries([1, 2]), []);
  const m = { x: { o: 2 }, y: { o: 1 }, z: {}, w: { o: 1 } };
  assert.deepEqual(listEntries(m).map(([k]) => k), ["x", "y", "z", "w"]);
  assert.deepEqual(listEntries(m, "o").map(([k]) => k), ["w", "y", "x", "z"]);
});
