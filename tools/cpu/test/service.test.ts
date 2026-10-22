// Serve mode against a fixture tree and fake timers: reads only while watched, deltas, stale
// on unwatch, cpu.json created and re-read while watched, the events list, Intel without cpu.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { createTool } from "@motherapp/tool-sdk";
import { LineDecoder } from "@motherapp/protocol";
import { CpuService, INITIAL_STATE, POLL_MS } from "../src/service.ts";
import type { Timers } from "../src/service.ts";
import { readSnapshot } from "../src/sysfs.ts";
import { intelHybrid, ryzen3900x, setFreq, setHwmon, tempTree } from "./fixtures.ts";
import type { MachineSpec } from "./fixtures.ts";

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

function setup(t: { after: (fn: () => void | Promise<void>) => void }, machine: MachineSpec = ryzen3900x()) {
  const tree = tempTree(machine);
  const settingsFile = path.join(tree.root, "config", "motherapp", "cpu.json");
  const input = new PassThrough();
  const output = new PassThrough();
  const tool = createTool({ id: "cpu", title: "CPU", page: "custom", initialState: INITIAL_STATE, persist: false, captureConsole: false, input, output });
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
    now: () => 1_000_000 + timers.t,
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
  const events = () => (tool.get("events") as { ts: number; text: string; kind: string }[]).map((e) => e.text);
  return { tool, tree, settingsFile, timers, service, changes, settle, watch, events, reads: () => reads, logs: () => received.filter((m) => m.method === "log").map((m) => m.params.msg as string) };
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
    "ccx.2.avgMHz",
    "ccx.2.fastCore",
    "ccx.2.maxMHz",
    "ccx.2.temp.value",
    "ccx.3.temp.value",
    "cores.7.mhz",
    "cores.7.threads",
    "sensors.k10temp-temp4.value",
  ]);
  assert.equal(s.tool.get("cores.7.mhz"), 4400);
  assert.equal(s.tool.get("ccx.2.fastCore"), 7);
  assert.equal(s.tool.get("sensors.k10temp-temp4.value"), 47);

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

test("cpu.json: created with the defaults at start, re-read every second while watched, problems shown", async (t) => {
  const s = setup(t);
  s.service.start();
  await s.settle();
  assert.ok(fs.existsSync(s.settingsFile));
  assert.deepEqual(s.tool.get("profiles.list.underclock"), { order: 0, name: "Underclock", detail: "values not set yet" });
  assert.equal(s.tool.get("profiles.list.overclock.vcore"), 1.25);
  assert.equal(s.tool.get("profiles.active"), undefined, "stock");
  assert.equal(s.tool.get("profiles.applyOnStart"), true);
  assert.equal(s.tool.get("profiles.file"), s.settingsFile);
  assert.equal(s.tool.get("profiles.problems"), undefined);
  assert.ok(s.logs().some((m) => /^created .*cpu\.json with the default profiles$/.test(m)));
  assert.deepEqual(s.events(), ["CPU tool started: no profile active (stock), apply at login on.", "Created cpu.json with the default profiles."]);

  await s.watch(true);
  const cfg = JSON.parse(fs.readFileSync(s.settingsFile, "utf8"));
  cfg.active = "overclock";
  cfg.applyOnStart = false;
  cfg.profiles.underclock = { name: "Quiet", ccx: [3600, 3600, 3600, 3600], vcore: 1.05 };
  fs.writeFileSync(s.settingsFile, JSON.stringify(cfg));
  s.timers.advance(POLL_MS);
  await s.settle();
  assert.equal(s.tool.get("profiles.active"), "overclock");
  assert.deepEqual(s.tool.get("profiles.list.underclock.ccx"), [3600, 3600, 3600, 3600]);
  assert.deepEqual(s.events().slice(2), [
    "cpu.json: active profile now Overclock (CTR) (was Stock).",
    "cpu.json: apply at login turned off.",
    "cpu.json: Quiet changed (name, CCX clocks, Vcore).",
  ]);
  const ts = (s.tool.get("events") as { ts: number }[]).at(-1)!.ts;
  assert.equal(ts, 1_000_000 + POLL_MS, "stamped with the service clock");

  // unchanged file: nothing republished, no events
  s.changes();
  s.timers.advance(POLL_MS);
  await s.settle();
  assert.ok(!s.changes().some((c) => c.path.startsWith("profiles") || c.path === "events"));

  cfg.active = null;
  fs.writeFileSync(s.settingsFile, JSON.stringify(cfg));
  s.timers.advance(POLL_MS);
  await s.settle();
  assert.equal(s.tool.get("profiles.active"), undefined, "null = stock = key deleted");
  assert.equal(s.events().at(-1), "cpu.json: active profile now Stock (was Overclock (CTR)).");

  fs.writeFileSync(s.settingsFile, "{ broken");
  s.timers.advance(POLL_MS);
  await s.settle();
  assert.match(s.tool.get("profiles.problems") as string, /isn't valid JSON/);
  assert.match(s.events().at(-1)!, /^cpu\.json can't be fully used: .*isn't valid JSON/);
  assert.equal(fs.readFileSync(s.settingsFile, "utf8"), "{ broken", "never overwritten");
  fs.writeFileSync(s.settingsFile, JSON.stringify(cfg));
  s.timers.advance(POLL_MS);
  await s.settle();
  assert.deepEqual(s.events().slice(-1), ["cpu.json is fine again."], "a broken read isn't logged as the user's change");
});

test("events: boost, governor and EPP changes seen by the poll", async (t) => {
  const s = setup(t);
  s.service.start();
  await s.watch(true);
  const cpu = path.join(s.tree.root, "sys/devices/system/cpu");
  fs.writeFileSync(path.join(cpu, "cpufreq/boost"), "0\n");
  s.timers.advance(POLL_MS);
  await s.settle();
  assert.equal(s.events().at(-1), "Boost now off (was on).");
  for (let c = 0; c < 24; c++) fs.writeFileSync(path.join(cpu, `cpu${c}/cpufreq/energy_performance_preference`), "balance_power\n");
  fs.writeFileSync(path.join(cpu, "cpufreq/boost"), "1\n");
  s.timers.advance(POLL_MS);
  await s.settle();
  assert.deepEqual(s.events().slice(-2), ["Boost now on (was off).", "EPP now balance_power (was performance)."]);
  assert.deepEqual(
    (s.tool.get("events") as { kind: string }[]).map((e) => e.kind),
    ["start", "config", "boost", "boost", "cpufreq"],
  );
});

test("events are capped at 50, newest kept", async (t) => {
  const s = setup(t);
  s.service.start();
  await s.watch(true);
  const boost = path.join(s.tree.root, "sys/devices/system/cpu/cpufreq/boost");
  for (let i = 0; i < 60; i++) {
    fs.writeFileSync(boost, i % 2 ? "1\n" : "0\n");
    s.timers.advance(POLL_MS);
    await s.settle();
  }
  const ev = s.events();
  assert.equal(ev.length, 50);
  assert.equal(ev.at(-1), "Boost now on (was off).");
});

test("Intel: no cpu.json read or created, no profiles, the generic state", async (t) => {
  const s = setup(t, intelHybrid());
  s.service.start();
  await s.watch(true);
  assert.equal(fs.existsSync(s.settingsFile), false);
  assert.deepEqual(s.tool.get("profiles"), {});
  assert.equal(s.tool.get("cpu.tuning"), false);
  assert.equal(s.tool.get("cpu.vendor"), "Intel");
  assert.equal(s.tool.get("cores.16.kind"), "E");
  assert.deepEqual(s.tool.get("cpu.pkgTemp"), { label: "Package id 0", value: 41 });
  assert.deepEqual(s.events(), ["CPU tool started."]);
  s.timers.advance(POLL_MS);
  await s.settle();
  assert.equal(fs.existsSync(s.settingsFile), false, "not on later reads either");
  assert.equal(s.tool.get("status"), undefined, "nothing reported as a problem");
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
