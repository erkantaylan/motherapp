// What a LAN client is shown when some tools are off the network (toolVisibility.ts). The
// server's use of it, over real connections, is in network.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { LogEntry, NotificationSettings } from "@motherapp/protocol";
import { logEntryVisible, newest, visibleNotificationSettings } from "../src/toolVisibility.ts";

const entry = (tool: string, msg: string, fields?: LogEntry["fields"]): LogEntry => ({ seq: 1, ts: "2026-11-23T10:00:00.000Z", level: "info", tool, src: tool === "core" ? "core" : "tool", msg, ...(fields ? { fields } : {}) });

test("logEntryVisible: not a hidden tool's entries, and not the core's that name one", () => {
  const hidden = new Set(["tmux", "my-tool"]);
  // nothing hidden: everything
  assert.equal(logEntryVisible(entry("tmux", "x"), new Set()), true);
  // the tool's own entries, whoever wrote them
  assert.equal(logEntryVisible(entry("tmux", "polled"), hidden), false);
  assert.equal(logEntryVisible({ ...entry("my-tool", "boom"), src: "stderr" }, hidden), false);
  assert.equal(logEntryVisible(entry("audio", "tmux is mentioned by another tool"), hidden), true, "another tool's entry is that tool's business");
  // the core's entries
  assert.equal(logEntryVisible(entry("core", "listening on http://127.0.0.1:7323/", { port: 7323 }), hidden), true);
  assert.equal(logEntryVisible(entry("core", "discovered 3 tool(s)", { dir: "/x/tools", tools: ["audio", "cpu", "tmux"] }), hidden), false);
  assert.equal(logEntryVisible(entry("core", "tool order changed", { order: ["audio", "my-tool"] }), hidden), false);
  assert.equal(logEntryVisible(entry("core", "tool order changed", { order: ["audio", "cpu"] }), hidden), true);
  assert.equal(logEntryVisible(entry("core", "x", { by: { tmux: 1 } }), hidden), false, "as a key");
  assert.equal(logEntryVisible(entry("core", "x", { deep: [{ a: [null, 1, "my-tool"] }] }), hidden), false, "nested");
  assert.equal(logEntryVisible(entry("core", 'skipping tool: external tool id "tmux" is taken by the built-in tool in /x'), hidden), false, "a whole word in the message");
  assert.equal(logEntryVisible(entry("core", "tmuxinator and my-tools are other words"), hidden), true);
});

test("visibleNotificationSettings: only the rows of tools the client sees", () => {
  const tool = (id: string) => ({ id, title: id, enabled: true, kinds: [] });
  const s: NotificationSettings = { muted: true, tools: [tool("a"), tool("b"), tool("c")], sounds: ["bell"], delivery: false };
  assert.equal(visibleNotificationSettings(s, () => true), s);
  assert.deepEqual(visibleNotificationSettings(s, (id) => id !== "b"), { muted: true, tools: [tool("a"), tool("c")], sounds: ["bell"], delivery: false });
  assert.equal(s.tools.length, 3, "the service's own object is left alone");
});

test("newest: the last `limit`, as the ring buffer counts", () => {
  assert.deepEqual(newest([1, 2, 3], undefined), [1, 2, 3]);
  assert.deepEqual(newest([1, 2, 3], 2), [2, 3]);
  assert.deepEqual(newest([1, 2, 3], 9), [1, 2, 3]);
  assert.deepEqual(newest([1, 2, 3], 0), []);
  assert.deepEqual(newest([1, 2, 3], -1), []);
  assert.deepEqual(newest([1, 2, 3], NaN), []);
});
