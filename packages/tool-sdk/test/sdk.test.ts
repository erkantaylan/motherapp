import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { createTool, readPersistedState } from "@motherapp/tool-sdk";
import type { ToolOptions } from "@motherapp/tool-sdk";
import { LineDecoder } from "@motherapp/protocol";

function harness(opts: Omit<ToolOptions, "input" | "output">) {
  const input = new PassThrough();
  const output = new PassThrough();
  const tool = createTool({ captureConsole: false, ...opts, input, output });
  const received: Record<string, unknown>[] = [];
  const dec = new LineDecoder();
  output.setEncoding("utf8");
  output.on("data", (c: string) => {
    for (const l of dec.push(c)) received.push(JSON.parse(l));
  });
  let id = 0;
  const call = async (method: string, params?: unknown) => {
    const myId = ++id;
    input.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
    for (let i = 0; i < 200; i++) {
      const r = received.find((m) => m.id === myId);
      if (r) return r as { result?: unknown; error?: { code: number; message: string } };
      await new Promise((res) => setTimeout(res, 5));
    }
    throw new Error(`no reply to ${method}`);
  };
  const notes = (method: string) => received.filter((m) => m.method === method).map((m) => m.params);
  const done = tool.serve();
  return { tool, call, notes, input, done };
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ma-sdk-"));

test("describe, state.get, actions, errors and batched state deltas", async () => {
  const h = harness({
    id: "t",
    title: "T",
    icon: "x",
    layout: [{ type: "text", bind: "n" }],
    initialState: { n: 0 },
    persist: false,
  });
  h.tool.action("bump", (args) => {
    h.tool.set("n", (h.tool.get("n") as number) + Number(args.by ?? 1));
    h.tool.set("other.deep", "v");
    return h.tool.get("n") as number;
  });
  h.tool.action("bad", () => {
    throw new Error("broken thing");
  });
  assert.deepEqual((await h.call("describe")).result, { title: "T", icon: "x", page: "declarative", layout: [{ type: "text", bind: "n" }] });
  assert.deepEqual((await h.call("state.get")).result, { state: { n: 0 }, stale: [] });
  assert.equal((await h.call("action", { name: "bump", args: { by: 2 } })).result, 2);
  const err = await h.call("action", { name: "bad" });
  assert.deepEqual(err.error, { code: -32000, message: "broken thing" });
  assert.equal((await h.call("action", { name: "missing" })).error?.code, -32601);
  assert.equal((await h.call("nosuchmethod")).error?.code, -32601);
  // both sets in one handler arrive as one notification
  assert.deepEqual(h.notes("state"), [{ changes: [{ path: "n", value: 2 }, { path: "other.deep", value: "v" }] }]);
  h.input.end();
  await h.done;
});

test("progress, logs and streams with a parameter", async () => {
  const h = harness({ id: "t", title: "T", persist: false });
  let stopped = "";
  h.tool.action("slow", async (_a, ctx) => {
    ctx.progress("half", 0.5);
    h.tool.log.warn("careful", { x: 1 });
    return "ok";
  });
  h.tool.stream("level", ({ emit, param, name }) => {
    emit(param === "42" ? 0.5 : -1);
    return () => (stopped = name);
  });
  const r = await h.call("action", { name: "slow" });
  assert.equal(r.result, "ok");
  const prog = h.notes("progress") as { id: number; text: string; fraction: number }[];
  assert.equal(prog.length, 1);
  assert.equal(prog[0]!.text, "half");
  assert.equal(prog[0]!.fraction, 0.5);
  assert.deepEqual(h.notes("log"), [{ level: "warn", msg: "careful", fields: { x: 1 } }]);
  assert.equal((await h.call("stream.open", { name: "level/42" })).result, null);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(h.notes("stream"), [{ name: "level/42", value: 0.5 }]);
  await h.call("stream.close", { name: "level/42" });
  assert.equal(stopped, "level/42");
  assert.equal((await h.call("stream.open", { name: "nope" })).error?.code, -32601);
  h.input.end();
  await h.done;
});

test("persistence: saved on shutdown, loaded as stale, refreshed values become fresh", async () => {
  const dir = tmp();
  const a = harness({ id: "p", title: "P", stateDir: dir, initialState: { level: 1, mode: "x" } });
  a.tool.action("set", (args) => a.tool.set("level", args.value as number));
  await a.call("action", { name: "set", args: { value: 70 } });
  a.input.end();
  await a.done;
  assert.deepEqual(readPersistedState("p", dir), { level: 70, mode: "x" });

  const b = harness({ id: "p", title: "P", stateDir: dir, initialState: { level: 1, mode: "x", added: true } });
  assert.equal(b.tool.get("level"), 70);
  assert.ok(b.tool.isStale("level"));
  assert.ok(!b.tool.isStale("added"));
  const snap = (await b.call("state.get")).result as { state: Record<string, unknown>; stale: string[] };
  assert.equal(snap.state.level, 70);
  assert.deepEqual(snap.stale.sort(), ["level", "mode"]);
  b.tool.set("level", 71);
  b.tool.markFresh("mode");
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(b.notes("state"), [{ changes: [{ path: "level", value: 71 }, { path: "mode", value: "x" }] }]);
  assert.ok(!b.tool.isStale("level") && !b.tool.isStale("mode"));
  b.tool.markStale("level");
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(b.notes("state").at(-1), { changes: [{ path: "level", value: 71, stale: true }] });
  b.input.end();
  await b.done;
  fs.rmSync(dir, { recursive: true, force: true });
});

test("persistence: a corrupt file is ignored with a warning", async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "c.json"), "{oops");
  const h = harness({ id: "c", title: "C", stateDir: dir, initialState: { a: 1 } });
  assert.equal(h.tool.get("a"), 1);
  await new Promise((r) => setTimeout(r, 10));
  const logs = h.notes("log") as { level: string; msg: string }[];
  assert.equal(logs[0]?.level, "warn");
  assert.match(logs[0]!.msg, /unreadable state file/);
  h.input.end();
  await h.done;
  fs.rmSync(dir, { recursive: true, force: true });
});

test("watch: tool.watching and onWatch follow the core's edges; repeats, bad params and unknown notifications are ignored", async () => {
  const h = harness({ id: "w", title: "W", persist: false });
  const seen: boolean[] = [];
  const off = h.tool.onWatch((w) => seen.push(w));
  h.tool.onWatch(() => {
    throw new Error("a broken listener doesn't stop the others");
  });
  const note = (method: string, params?: unknown) => h.input.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  // Lines are handled in order, so the notifications before this request were handled by its reply.
  const flush = () => h.call("state.get");
  assert.equal(h.tool.watching, false, "a tool starts unwatched");
  note("watch", { watching: true });
  await flush();
  assert.equal(h.tool.watching, true);
  assert.deepEqual(seen, [true]);
  note("watch", { watching: true }); // not an edge
  note("watch", { watching: "yes" });
  note("watch");
  note("something.new", { x: 1 });
  await flush();
  assert.deepEqual(seen, [true]);
  note("watch", { watching: false });
  await flush();
  assert.equal(h.tool.watching, false);
  assert.deepEqual(seen, [true, false]);
  assert.ok(h.notes("log").some((l) => /watch listener failed: a broken listener/.test(String((l as { msg: string }).msg))));
  off();
  note("watch", { watching: true });
  await flush();
  assert.equal(h.tool.watching, true);
  assert.deepEqual(seen, [true, false], "unsubscribed");
  h.input.end();
  await h.done;
});
