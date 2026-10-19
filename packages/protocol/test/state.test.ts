import { test } from "node:test";
import assert from "node:assert/strict";
import { StaleSet, applyChanges, getPath, pathsOverlap } from "@motherapp/protocol";
import type { JsonObject } from "@motherapp/protocol";

test("applyChanges: set, nested create, delete, arrays, root replace", () => {
  const s: JsonObject = { a: 1, sinks: { "42": { volume: 0.5, name: "x" } } };
  applyChanges(s, [
    { path: "a", value: 2 },
    { path: "sinks.42.volume", value: 0.7 },
    { path: "sinks.43", value: { volume: 1, name: "y" } },
    { path: "deep.new.key", value: true },
    { path: "list", value: [1, 2, 3] },
    { path: "list.1", value: 20 },
  ]);
  assert.deepEqual(s, {
    a: 2,
    sinks: { "42": { volume: 0.7, name: "x" }, "43": { volume: 1, name: "y" } },
    deep: { new: { key: true } },
    list: [1, 20, 3],
  });
  applyChanges(s, [
    { path: "sinks.42", value: null },
    { path: "missing.child", value: null },
    { path: "list.0", value: null },
  ]);
  assert.deepEqual(s.sinks, { "43": { volume: 1, name: "y" } });
  assert.equal("missing" in s, false);
  assert.deepEqual(s.list, [20, 3]);
  applyChanges(s, [{ path: "", value: { fresh: 1 } }]);
  assert.deepEqual(s, { fresh: 1 });
});

test("getPath", () => {
  const s: JsonObject = { a: { b: [10, { c: "x" }] } };
  assert.equal(getPath(s, "a.b.1.c"), "x");
  assert.equal(getPath(s, "a.b.0"), 10);
  assert.equal(getPath(s, "a.zz"), undefined);
  assert.equal(getPath(s, "a.b.0.c"), undefined);
  assert.equal(getPath(s, "toString"), undefined);
  assert.deepEqual(getPath(s, ""), s);
});

test("pathsOverlap is segment-wise", () => {
  assert.ok(pathsOverlap("sinks", "sinks.42.volume"));
  assert.ok(pathsOverlap("sinks.42.volume", "sinks"));
  assert.ok(pathsOverlap("", "x"));
  assert.ok(!pathsOverlap("sinks", "sinks2"));
  assert.ok(!pathsOverlap("a.b", "a.c"));
});

test("StaleSet: covers descendants, clearing is downward only", () => {
  const st = new StaleSet();
  st.mark("level");
  st.mark("monitors");
  assert.ok(st.isStale("level"));
  assert.ok(st.isStale("monitors.DP-1.brightness"));
  assert.ok(!st.isStale("other"));
  st.clear("monitors.DP-1"); // ancestor stays stale
  assert.ok(st.isStale("monitors.DP-1"));
  st.clear("monitors");
  assert.ok(!st.isStale("monitors.DP-1"));
  st.apply({ path: "level", value: 3 });
  assert.equal(st.size, 0);
  st.apply({ path: "x", value: 1, stale: true });
  assert.deepEqual(st.list(), ["x"]);
  st.reset(["a", "b"]);
  assert.deepEqual(st.list().sort(), ["a", "b"]);
});
