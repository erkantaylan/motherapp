// Serve mode against a fixture tree and fake timers: reads only while watched, deltas, stale
// on unwatch, cpu.json created and re-read when the page opens.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { createTool } from "@motherapp/tool-sdk";
import { LineDecoder } from "@motherapp/protocol";
import { layout } from "../src/layout.ts";
import { CpuService, INITIAL_STATE, POLL_MS } from "../src/service.ts";
import type { Timers } from "../src/service.ts";
import { readSnapshot } from "../src/sysfs.ts";
import { setFreq, setHwmon, tempTree } from "./fixtures.ts";

type Msg = { id?: number; method?: string; params?: any };

class FakeTimers implements Timers {
  t = 0;
  private list: { at: number; fn: () => void; id: number }[] = [];
  private id = 0;
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.id;
    this.list.push({ at: this.t + ms, fn, id });
    return id;
  }
  clearTimeout(h: unknown): void {
    this.list = this.list.filter((x) => x.id !== h);
  }
  pending(): number {
    return this.list.length;
  }
  advance(ms: number): void {
    this.t += ms;
    const due = this.list.filter((x) => x.at <= this.t);
    this.list = this.list.filter((x) => x.at > this.t);
    for (const d of due) d.fn();
  }
}

const tick = () => new Promise((r) => setImmediate(r));

function setup(t: { after: (fn: () => void | Promise<void>) => void }) {
  const tree = tempTree();
  const settingsFile = path.join(tree.root, "config", "motherapp", "cpu.json");
  const input = new PassThrough();
  const output = new PassThrough();
  const tool = createTool({ id: "cpu", title: "CPU", layout, initialState: INITIAL_STATE, persist: false, captureConsole: false, input, output });
  const timers = new FakeTimers();
  let reads = 0;
  const service = new CpuService({
    tool,
    read: () => {
      reads++;
      return readSnapshot(tree.root);
    },
    settingsFile,
    timers,
  });
  const received: Msg[] = [];
  const dec = new LineDecoder();
  output.setEncoding("utf8");
  output.on("data", (c: string) => {
    for (const l of dec.push(c)) received.push(JSON.parse(l));
  });
  let mark = 0;
  const changes = () => {
    const out = received.slice(mark).filter((m) => m.method === "state").flatMap((m) => m.params.changes);
    mark = received.length;
    return out;
  };
  const settle = async () => {
    for (let i = 0; i < 4; i++) await tick();
  };
  const watch = async (watching: boolean) => {
    input.write(JSON.stringify({ jsonrpc: "2.0", method: "watch", params: { watching } }) + "\n");
    await settle();
  };
  const done = tool.serve();
  t.after(async () => {
    service.stop();
    input.end();
    await done;
    tree.cleanup();
  });
  return { tool, tree, settingsFile, timers, service, changes, settle, watch, reads: () => reads, logs: () => received.filter((m) => m.method === "log").map((m) => m.params.msg as string) };
}

test("start: one read for the page's shape, then stale and silent until watched", async (t) => {
  const s = setup(t);
  s.service.start();
  await s.settle();
  assert.equal(s.reads(), 1);
  assert.equal(s.tool.get("cpu.model"), "AMD Ryzen 9 3900X 12-Core Processor");
  assert.deepEqual(Object.keys(s.tool.get("ccx") as object), ["0", "1", "2", "3"]);
  assert.equal(Object.keys(s.tool.get("cores") as object).length, 12);
  for (const k of ["cpu", "ccx", "cores", "sensors"]) assert.equal(s.tool.isStale(k), true, `${k} stale while nobody watches`);
  assert.equal(s.tool.isStale("profiles"), false, "profiles aren't polled");
  for (let i = 0; i < 60; i++) s.timers.advance(POLL_MS);
  assert.equal(s.reads(), 1, "no reads over 60 s unwatched");
  assert.equal(s.timers.pending(), 0);
});

test("watched: reads at once and every second, publishes only what changed, stale again on unwatch", async (t) => {
  const s = setup(t);
  s.service.start();
  await s.settle();
  s.changes();
  await s.watch(true);
  assert.equal(s.reads(), 2, "an immediate read when the page opens");
  const first = s.changes();
  assert.deepEqual(first.filter((c) => ["cpu", "ccx", "cores", "sensors"].includes(c.path)).map((c) => [c.path, c.stale]), [
    ["cpu", undefined],
    ["ccx", undefined],
    ["cores", undefined],
    ["sensors", undefined],
  ]);
  for (const k of ["cpu", "ccx", "cores", "sensors"]) assert.equal(s.tool.isStale(k), false);

  s.timers.advance(POLL_MS);
  await s.settle();
  assert.equal(s.reads(), 3);
  assert.deepEqual(s.changes(), [], "nothing changed, nothing sent");

  setFreq(s.tree.root, 7, 4_400_000);
  setHwmon(s.tree.root, 1, "temp4_input", "47000");
  s.timers.advance(POLL_MS);
  await s.settle();
  const paths = s.changes().map((c) => c.path).sort();
  assert.deepEqual(paths, [
    "ccx.2.detail",
    "ccx.2.fraction",
    "ccx.2.value",
    "ccx.3.detail",
    "cores.7.detail",
    "cores.7.fraction",
    "cores.7.value",
    "sensors.k10temp-temp4.value",
  ]);
  assert.equal(s.tool.get("cores.7.value"), "4400 MHz");
  assert.equal(s.tool.get("sensors.k10temp-temp4.value"), "47 °C");

  await s.watch(false);
  for (const k of ["cpu", "ccx", "cores", "sensors"]) assert.equal(s.tool.isStale(k), true);
  assert.equal(s.timers.pending(), 0);
  const n = s.reads();
  for (let i = 0; i < 30; i++) s.timers.advance(POLL_MS);
  assert.equal(s.reads(), n, "stops when the last viewer leaves");

  // a quick false/true never runs two loops
  await s.watch(true);
  await s.watch(false);
  await s.watch(true);
  assert.equal(s.timers.pending(), 1);
});

test("cpu.json: created with the defaults at start, re-read when the page opens, problems shown", async (t) => {
  const s = setup(t);
  s.service.start();
  await s.settle();
  assert.ok(fs.existsSync(s.settingsFile));
  assert.deepEqual(s.tool.get("profiles.underclock"), { order: 0, name: "Underclock", value: "not set", detail: "values not set yet" });
  assert.equal(s.tool.get("profiles.overclock.value"), "1.250 V");
  assert.equal(s.tool.get("profilesActive"), "Active profile: none (stock settings, nothing applied).");
  assert.match(s.tool.get("profilesNote") as string, /^Applying profiles isn't available yet\. The profiles are read from .*cpu\.json\.$/);
  assert.equal(s.tool.get("profilesStatus"), undefined);
  assert.ok(s.logs().some((m) => /^created .*cpu\.json with the default profiles$/.test(m)));

  const cfg = JSON.parse(fs.readFileSync(s.settingsFile, "utf8"));
  cfg.active = "overclock";
  cfg.profiles.underclock = { name: "Quiet", ccx: [3600, 3600, 3600, 3600], vcore: 1.05 };
  fs.writeFileSync(s.settingsFile, JSON.stringify(cfg));
  await s.watch(true);
  assert.equal(s.tool.get("profiles.overclock.name"), "Overclock (CTR) (active)");
  assert.equal(s.tool.get("profiles.underclock.detail"), "CCX1 3600 · CCX2 3600 · CCX3 3600 · CCX4 3600 MHz");
  assert.equal(s.tool.get("profilesActive"), "Active profile: Overclock (CTR), re-applied when the tool starts.");

  fs.writeFileSync(s.settingsFile, "{ broken");
  await s.watch(false);
  await s.watch(true);
  assert.match(s.tool.get("profilesStatus") as string, /isn't valid JSON/);
  assert.equal(fs.readFileSync(s.settingsFile, "utf8"), "{ broken", "never overwritten");
});

test("a reading problem shows in status and is logged once", async (t) => {
  const s = setup(t);
  fs.rmSync(path.join(s.tree.root, "sys/devices/system/cpu"), { recursive: true });
  s.service.start();
  await s.watch(true);
  s.timers.advance(POLL_MS);
  await s.settle();
  assert.match(s.tool.get("status") as string, /^Can't list the CPUs/);
  assert.equal(s.logs().filter((m) => m.startsWith("Can't list the CPUs")).length, 1);
});

test("layout: read-only page (no action anywhere), the not-available line and the profile section", () => {
  const actions = JSON.stringify(layout).match(/"action"/g);
  assert.equal(actions, null, "nothing on the page can act");
  assert.ok(layout.some((w) => w.type === "text" && w.text?.startsWith("Not available yet: Vcore, package power (PPT)")));
  const lists = layout.filter((w) => w.type === "list").map((w) => (w.type === "list" ? [w.bind, w.label] : []));
  assert.deepEqual(lists, [
    ["ccx", "Core complexes"],
    ["cores", "Cores"],
    ["sensors", "Temperatures and fans"],
    ["profiles", "Saved profiles (reference)"],
  ]);
});
