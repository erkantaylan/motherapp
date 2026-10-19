import { test } from "node:test";
import assert from "node:assert/strict";
import type { ControlStatus, JsonObject, LogEntry } from "@motherapp/protocol";
import { ActionRunner } from "../src/actionRunner.ts";
import { matches } from "../src/logFilter.ts";
import { ToolStore } from "../src/store.ts";
import { interpolate, interpolateWidget } from "../src/template.ts";

test("ToolStore: subscribers fire for overlapping paths only; stale and down", () => {
  const s = new ToolStore();
  const hits: string[] = [];
  s.subscribe("sinks", () => hits.push("sinks"));
  s.subscribe("sinks.42.volume", () => hits.push("vol42"));
  s.subscribe("other", () => hits.push("other"));
  s.reset({ sinks: { "42": { volume: 0.5 } }, other: 1 }, ["other"]);
  assert.deepEqual(hits.splice(0).sort(), ["other", "sinks", "vol42"]);
  assert.ok(s.isStale("sinks"), "down until told otherwise");
  s.setDown(false);
  hits.length = 0;
  assert.ok(!s.isStale("sinks.42.volume"));
  assert.ok(s.isStale("other"));
  s.apply([{ path: "sinks.42.volume", value: 0.6 }]);
  assert.deepEqual(hits.splice(0).sort(), ["sinks", "vol42"]);
  s.apply([{ path: "sinks.43", value: { volume: 1 } }]);
  assert.deepEqual(hits.splice(0), ["sinks"]);
  s.apply([{ path: "other", value: 2 }]);
  assert.ok(!s.isStale("other"));
  assert.equal(s.get("sinks.42.volume"), 0.6);
});

function deferred() {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("ActionRunner: setting -> set, failed with message, coalesces while in flight", async () => {
  const calls: { args: JsonObject; d: ReturnType<typeof deferred> }[] = [];
  const statuses: [ControlStatus, string | undefined][] = [];
  const r = new ActionRunner(
    (args) => {
      const d = deferred();
      calls.push({ args, d });
      return d.promise;
    },
    (s, e) => statuses.push([s, e]),
  );
  r.send({ value: 1 });
  r.send({ value: 2 });
  r.send({ value: 3 }); // replaces 2
  assert.equal(calls.length, 1);
  assert.ok(r.busy);
  calls[0]!.d.resolve();
  await new Promise((res) => setImmediate(res));
  assert.deepEqual(calls.map((c) => c.args.value), [1, 3]);
  calls[1]!.d.reject(new Error("device busy"));
  await new Promise((res) => setImmediate(res));
  assert.deepEqual(statuses, [["setting", undefined], ["failed", "device busy"]]);
  assert.ok(!r.busy);
  r.send({ value: 4 });
  calls[2]!.d.resolve();
  await new Promise((res) => setImmediate(res));
  assert.deepEqual(statuses.slice(2), [["setting", undefined], ["set", undefined]]);
});

test("templates: key, path, item fields; nested list templates untouched", () => {
  const ctx = { key: "42", path: "sinks.42", item: { name: "Speakers", n: 3, o: { a: 1 } } };
  assert.equal(interpolate("{name} ({key}) at {path} n={n} {missing}", ctx), "Speakers (42) at sinks.42 n=3 ");
  assert.equal(interpolate("{o}", ctx), '{"a":1}');
  assert.deepEqual(interpolateWidget({ type: "slider", bind: "sinks.{key}.volume", action: "setVolume", args: { id: "{key}" }, min: 0, max: 1 }, ctx), {
    type: "slider",
    bind: "sinks.42.volume",
    action: "setVolume",
    args: { id: "42" },
    min: 0,
    max: 1,
  });
  const nested = interpolateWidget({ type: "list", bind: "sinks.{key}.ports", item: { label: "{name}" } }, ctx);
  assert.deepEqual(nested, { type: "list", bind: "sinks.42.ports", item: { label: "{name}" } });
});

test("log filter: tool, minimum level, text in msg or fields", () => {
  const e: LogEntry = { seq: 1, ts: "", level: "warn", tool: "audio", src: "tool", msg: "Sink vanished", fields: { node: "alsa_output" } };
  assert.ok(matches(e, { tool: "", level: "debug", text: "" }));
  assert.ok(matches(e, { tool: "audio", level: "warn", text: "sink" }));
  assert.ok(matches(e, { tool: "", level: "info", text: "ALSA" }));
  assert.ok(!matches(e, { tool: "core", level: "debug", text: "" }));
  assert.ok(!matches(e, { tool: "", level: "error", text: "" }));
  assert.ok(!matches(e, { tool: "", level: "debug", text: "nothing" }));
});
