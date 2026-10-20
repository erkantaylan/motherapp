// Serve-mode logic against a fake backend: cached → fresh, coalescing, per-monitor
// serialization, the linked slider, timeouts, missing monitors and the fallback warning.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { createTool } from "@motherapp/tool-sdk";
import type { JsonObject } from "@motherapp/tool-sdk";
import { LineDecoder } from "@motherapp/protocol";
import { layout } from "../src/layout.ts";
import { BrightnessService, INITIAL_STATE } from "../src/service.ts";
import type { ServiceOptions } from "../src/service.ts";
import { ACER, ACER_KEY, FakeBackend, MSI, MSI_KEY, sleep, waitFor } from "./fakes.ts";

type Msg = { id?: number; method?: string; params?: any; result?: any; error?: { code: number; message: string } };

function setup(backend: FakeBackend, opts: Partial<ServiceOptions> & { stateDir?: string; warning?: string } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const tool = createTool({
    id: "brightness",
    title: "Brightness",
    layout,
    initialState: INITIAL_STATE,
    captureConsole: false,
    input,
    output,
    ...(opts.stateDir ? { stateDir: opts.stateDir, persistDelayMs: 10 } : { persist: false }),
  });
  const service = new BrightnessService({
    tool,
    backend: async () => (opts.warning ? { backend, warning: opts.warning } : { backend }),
    confirmDelayMs: 30,
    pollMs: 0,
    callTimeoutMs: 300,
    ...opts,
  });
  const received: Msg[] = [];
  const dec = new LineDecoder();
  output.setEncoding("utf8");
  output.on("data", (c: string) => {
    for (const l of dec.push(c)) received.push(JSON.parse(l) as Msg);
  });
  let nextId = 1;
  const call = async (method: string, params?: unknown): Promise<Msg> => {
    const id = nextId++;
    input.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    await waitFor(() => received.some((m) => m.id === id), `reply to ${method}`, 5000);
    return received.find((m) => m.id === id)!;
  };
  const action = (name: string, args: JsonObject = {}) => call("action", { name, args });
  /** The core's `watch` notification (a visible tab opened or left the page). */
  const watch = (watching: boolean) => input.write(JSON.stringify({ jsonrpc: "2.0", method: "watch", params: { watching } }) + "\n");
  const serving = tool.serve();
  const done = async () => {
    await service.stop();
    input.end();
    await serving;
  };
  return { tool, service, received, call, action, watch, done };
}

const two = () => new FakeBackend({ info: MSI, value: 48 }, { info: ACER, value: 52 });

test("detects at start, keys rows by EDID identity, titles by model, connector as subtitle", async () => {
  const b = two();
  const s = setup(b);
  await s.service.start();
  await waitFor(() => s.tool.get(`monitors.${ACER_KEY}.brightness`) === 52 && !s.tool.isStale(`monitors.${ACER_KEY}.brightness`), "first reads");
  assert.deepEqual(Object.keys(s.tool.get("monitors") as object).sort(), [ACER_KEY, MSI_KEY]);
  assert.equal(s.tool.get(`monitors.${MSI_KEY}.title`), "MSI G274QPF");
  assert.equal(s.tool.get(`monitors.${MSI_KEY}.subtitle`), "DP-1");
  assert.equal(s.tool.get(`monitors.${ACER_KEY}.subtitle`), "DP-2");
  assert.equal(s.tool.get(`monitors.${MSI_KEY}.brightness`), 48);
  assert.equal(s.tool.get("status"), undefined);
  assert.equal(s.tool.get("backend"), "Talking to the monitors through fake backend.");
  assert.equal(b.calls.filter((c) => c.startsWith("detect")).length, 1, "detect runs once");
  await s.done();
});

test("cached values show immediately (stale) after a restart, then turn fresh when re-read", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ma-bright-"));
  try {
    const b1 = two();
    const s1 = setup(b1, { stateDir: dir });
    await s1.service.start();
    await waitFor(() => s1.tool.get(`monitors.${MSI_KEY}.brightness`) === 48 && !s1.tool.isStale(`monitors.${MSI_KEY}.brightness`), "first run read");
    assert.equal((await s1.action("setBrightness", { id: MSI_KEY, value: 70 })).error, undefined);
    await sleep(60); // confirm read
    s1.tool.save();
    await s1.done();

    const b2 = two();
    b2.mon(1).value = 70;
    b2.detectDelayMs = 150; // the restart's detection is slow; cached values must not wait for it
    const s2 = setup(b2, { stateDir: dir });
    void s2.service.start();
    const snap = await s2.call("state.get");
    assert.equal(snap.result.state.monitors[MSI_KEY].brightness, 70);
    assert.equal(snap.result.state.monitors[ACER_KEY].brightness, 52);
    assert.ok(snap.result.stale.includes(`monitors.${MSI_KEY}.brightness`));
    assert.ok(!snap.result.stale.includes("monitors"), "only the values are stale, not the whole map");
    assert.equal(snap.result.state.all.brightness, 61, "linked slider shows the average of the cached values");
    await waitFor(() => !s2.tool.isStale(`monitors.${MSI_KEY}.brightness`), "fresh after re-read");
    const fresh = s2.received.flatMap((m) => (m.method === "state" ? m.params.changes : [])).find((c: any) => c.path === `monitors.${MSI_KEY}.brightness` && !c.stale);
    assert.deepEqual(fresh, { path: `monitors.${MSI_KEY}.brightness`, value: 70 });
    await s2.done();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("slider drags are coalesced: only the newest pending value is written, one call at a time", async () => {
  const b = two();
  b.delayMs = 40;
  const s = setup(b);
  await s.service.start();
  await waitFor(() => b.calls.filter((c) => c.startsWith("read")).length === 2 && !s.tool.isStale(`monitors.${MSI_KEY}.brightness`), "first reads");
  b.calls.length = 0;
  const replies = await Promise.all([10, 20, 30, 40, 50].map((v) => s.action("setBrightness", { id: MSI_KEY, value: v })));
  for (const r of replies) assert.equal(r.error, undefined);
  assert.deepEqual(b.calls.filter((c) => c.startsWith("write")), ["write 1 10", "write 1 50"]);
  assert.equal(b.maxConcurrentPerBus, 1);
  assert.equal(s.tool.get(`monitors.${MSI_KEY}.brightness`), 50);
  await waitFor(() => b.calls.includes("read 1"), "confirming read after the writes settle");
  await s.done();
});

test("writes and reads on one monitor never overlap; different monitors run side by side", async () => {
  const b = two();
  b.delayMs = 20;
  const s = setup(b);
  await s.service.start();
  await Promise.all([
    s.action("setBrightness", { id: MSI_KEY, value: 5 }),
    s.action("read", { target: "DP-1" }),
    s.action("setBrightness", { id: ACER_KEY, value: 6 }),
    s.action("setBrightness", { id: MSI_KEY, value: 7 }),
    s.action("read", {}),
  ]);
  assert.equal(b.maxConcurrentPerBus, 1);
  assert.equal(b.mon(1).value, 7);
  assert.equal(b.mon(3).value, 6);
  await s.done();
});

test("linked slider sets every monitor; shows the common value, or the average with a note", async () => {
  const b = two();
  const s = setup(b);
  await s.service.start();
  await waitFor(() => !s.tool.isStale("all.brightness") && s.tool.get("all.brightness") === 50, "average of 48 and 52");
  assert.match(String(s.tool.get("allNote")), /MSI G274QPF 48%, Acer X34 P 52%.*average/);
  const r = await s.action("setAll", { value: 65 });
  assert.equal(r.error, undefined);
  assert.equal(b.mon(1).value, 65);
  assert.equal(b.mon(3).value, 65);
  assert.equal(s.tool.get("all.brightness"), 65);
  assert.equal(s.tool.get("allNote"), undefined);
  // per-monitor sliders followed while the linked one moved
  const changes = s.received.flatMap((m) => (m.method === "state" ? m.params.changes : []));
  assert.ok(changes.some((c: any) => c.path === `monitors.${ACER_KEY}.brightness` && c.value === 65 && !c.stale));
  await s.done();
});

test("a write in flight is not stale: neither the value the user set nor the linked slider (issue #12)", async () => {
  const b = two();
  const s = setup(b);
  await s.service.start();
  await waitFor(() => !s.tool.isStale("all.brightness") && s.tool.get("all.brightness") === 50, "first reads");
  b.delayMs = 200;
  const from = s.received.length;
  const one = s.action("setBrightness", { id: MSI_KEY, value: 30 });
  await waitFor(() => s.tool.get(`monitors.${MSI_KEY}.brightness`) === 30, "pending value shown");
  assert.equal(b.mon(1).value, 48, "the write is still on its way");
  assert.equal(s.tool.isStale(`monitors.${MSI_KEY}.brightness`), false);
  assert.equal(s.tool.isStale("all.brightness"), false);
  assert.equal((await one).error, undefined);
  const all = s.action("setAll", { value: 70 });
  await waitFor(() => s.tool.get(`monitors.${ACER_KEY}.brightness`) === 70 && s.tool.get(`monitors.${MSI_KEY}.brightness`) === 70, "pending values shown");
  assert.notEqual(b.mon(3).value, 70, "the writes are still on their way");
  for (const p of [`monitors.${MSI_KEY}.brightness`, `monitors.${ACER_KEY}.brightness`, "all.brightness"]) assert.equal(s.tool.isStale(p), false, p);
  assert.equal((await all).error, undefined);
  const changes = s.received.slice(from).flatMap((m) => (m.method === "state" ? m.params.changes : []));
  assert.deepEqual(changes.filter((c: any) => c.stale), [], "nothing was published stale while setting");
  await s.done();
});

test("the max from the monitor scales percent to raw values", async () => {
  const b = new FakeBackend({ info: MSI, value: 50, max: 200 });
  const s = setup(b);
  await s.service.start();
  await waitFor(() => s.tool.get(`monitors.${MSI_KEY}.brightness`) === 25, "50/200 = 25%");
  await s.action("setBrightness", { id: MSI_KEY, value: 40 });
  assert.equal(b.mon(1).value, 80);
  await s.done();
});

test("set (the CLI's action): absolute, relative per monitor, all, and validation", async () => {
  const b = two();
  const s = setup(b);
  await s.service.start();
  await waitFor(() => !s.tool.isStale(`monitors.${ACER_KEY}.brightness`) && !s.tool.isStale(`monitors.${MSI_KEY}.brightness`), "reads");
  let r = await s.action("set", { target: "all", value: "+10" });
  assert.equal(r.error, undefined);
  assert.equal(b.mon(1).value, 58);
  assert.equal(b.mon(3).value, 62);
  assert.deepEqual(
    r.result.map((x: any) => [x.title, x.brightness]).sort(),
    [["Acer X34 P", 62], ["MSI G274QPF", 58]],
  );
  r = await s.action("set", { target: "acer", value: "-70" });
  assert.equal(b.mon(3).value, 0, "clamped at 0");
  r = await s.action("set", { target: "1", value: "100" });
  assert.equal(b.mon(1).value, 100);
  r = await s.action("set", { target: "DP-2", value: "150" });
  assert.equal(r.error?.code, -32602);
  r = await s.action("set", { target: "dell", value: "10" });
  assert.match(r.error!.message, /no monitor matches "dell"/);
  await s.done();
});

test("repeated relative steps while a write is pending add up", async () => {
  const b = two();
  b.delayMs = 40;
  const s = setup(b);
  await s.service.start();
  await waitFor(() => !s.tool.isStale(`monitors.${MSI_KEY}.brightness`), "read");
  await Promise.all([1, 2, 3].map(() => s.action("set", { target: "DP-1", value: "+10" })));
  assert.equal(b.mon(1).value, 78);
  await s.done();
});

test("a monitor that doesn't answer fails with a message within the timeout, and the loop keeps answering", async () => {
  const b = two();
  const s = setup(b);
  await s.service.start();
  await waitFor(() => !s.tool.isStale(`monitors.${MSI_KEY}.brightness`), "read");
  b.mon(1).hang = true;
  const t0 = Date.now();
  const pending = s.action("setBrightness", { id: MSI_KEY, value: 10 });
  const d = await s.call("describe"); // answered while the monitor call hangs
  assert.equal(d.result.title, "Brightness");
  const r = await pending;
  assert.equal(r.error?.message, "MSI G274QPF: no answer within 0.3 s");
  assert.ok(Date.now() - t0 < 1500);
  assert.equal(s.tool.get(`monitors.${MSI_KEY}.brightness`), 48, "reverted to the last confirmed value");
  assert.ok(s.tool.isStale(`monitors.${MSI_KEY}.brightness`));
  assert.match(String(s.tool.get(`monitors.${MSI_KEY}.subtitle`)), /^DP-1 · last change failed: no answer/);
  // the other monitor is unaffected
  assert.equal((await s.action("setBrightness", { id: ACER_KEY, value: 30 })).error, undefined);
  await s.done();
});

test("a switched-off monitor: failed write with a clear message, no row removed", async () => {
  const b = two();
  const s = setup(b);
  await s.service.start();
  await waitFor(() => !s.tool.isStale(`monitors.${ACER_KEY}.brightness`), "read");
  b.mon(3).off = true;
  const r = await s.action("setAll", { value: 20 });
  assert.equal(r.error?.message, "Acer X34 P: no answer over DDC/CI, is it switched on?");
  assert.equal(b.mon(1).value, 20, "the other monitor was still set");
  assert.ok(s.tool.get(`monitors.${ACER_KEY}`));
  await s.done();
});

test("an unplugged monitor: failure triggers a re-detect, the row stays marked missing until Re-detect", async () => {
  const b = two();
  const s = setup(b, { missingRetryMs: 100_000 });
  await s.service.start();
  await waitFor(() => !s.tool.isStale(`monitors.${ACER_KEY}.brightness`), "read");
  b.visible = new Set([1]);
  const r = await s.action("setBrightness", { id: ACER_KEY, value: 40 });
  assert.match(r.error!.message, /^Acer X34 P: not reachable any more/);
  await waitFor(() => s.tool.get(`monitors.${ACER_KEY}.present`) === false, "marked missing by the automatic re-detect");
  assert.equal(b.calls.filter((c) => c === "detect redetect").length, 1);
  assert.match(String(s.tool.get(`monitors.${ACER_KEY}.subtitle`)), /DP-2 · not found, switched off or unplugged\?/);
  assert.equal(s.tool.get("all.brightness"), 48, "the linked slider ignores the missing monitor");
  // linked slider only touches present monitors
  assert.equal((await s.action("setAll", { value: 33 })).error, undefined);
  assert.equal(b.mon(1).value, 33);
  // writing to it again looks again first, and fails clearly
  const again = await s.action("setBrightness", { id: ACER_KEY, value: 40 });
  assert.match(again.error!.message, /Acer X34 P: not found, switched off or unplugged\? Turn it on and press Re-detect/);
  // it comes back: writing works again
  b.visible = undefined;
  assert.equal((await s.action("setBrightness", { id: ACER_KEY, value: 41 })).error, undefined);
  assert.equal(s.tool.get(`monitors.${ACER_KEY}.present`), true);
  // an explicit re-detect drops monitors that are really gone
  b.visible = new Set([1]);
  const rd = await s.action("redetect");
  assert.equal(rd.error, undefined);
  assert.equal(s.tool.get(`monitors.${ACER_KEY}`), undefined);
  await s.done();
});

test("while a monitor is missing, detection retries in the background", async () => {
  const b = two();
  b.visible = new Set([1]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ma-bright-"));
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "brightness.json"),
      JSON.stringify({ version: 1, state: { monitors: { [ACER_KEY]: { title: "Acer X34 P", subtitle: "DP-2", bus: 3, connector: "DP-2", mfg: "ACR", model: "Acer X34 P", serial: "#ASM1Buw5LKnd", present: true, brightness: 52 } }, all: {} } }),
    );
    const s = setup(b, { stateDir: dir, missingRetryMs: 40 });
    await s.service.start();
    assert.equal(s.tool.get(`monitors.${ACER_KEY}.present`), false);
    b.visible = undefined; // switched back on
    await waitFor(() => s.tool.get(`monitors.${ACER_KEY}.present`) === true, "found again by the retry");
    await waitFor(() => !s.tool.isStale(`monitors.${ACER_KEY}.brightness`), "and re-read");
    await s.done();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the fallback warning is shown on the page; no backend at all says why", async () => {
  const s = setup(two(), { warning: "libddcutil could not be loaded (nope), so the slower ddcutil command is used instead." });
  await s.service.start();
  assert.match(String(s.tool.get("warning")), /^⚠️ libddcutil could not be loaded/);
  await s.done();

  const tool = createTool({ id: "brightness", title: "Brightness", initialState: INITIAL_STATE, persist: false, captureConsole: false });
  const svc = new BrightnessService({ tool, backend: async () => Promise.reject(new Error("ddcutil not found")), pollMs: 0, log: { debug() {}, info() {}, warn() {}, error() {} } });
  await svc.start();
  assert.equal(tool.get("warning"), "⚠️ No way to talk to the monitors: ddcutil not found");
  assert.match(String(tool.get("status")), /Can't look for monitors: No way to talk to the monitors: ddcutil not found/);
  await assert.rejects(svc.call("setAll", { value: 3 }), /no monitors found/);
});

test("no monitors: status says what to check", async () => {
  const s = setup(new FakeBackend());
  await s.service.start();
  assert.match(String(s.tool.get("status")), /No monitors with DDC\/CI found/);
  await s.done();
});

test("detection failure is shown while there are no rows", async () => {
  const b = two();
  b.detectError = "ddcutil not found (install the ddcutil package)";
  const s = setup(b);
  await s.service.start();
  assert.equal(s.tool.get("status"), "Can't detect monitors: ddcutil not found (install the ddcutil package)");
  await s.done();
});

test("invalid action arguments are rejected as invalid params", async () => {
  const s = setup(two());
  await s.service.start();
  assert.equal((await s.action("setBrightness", { id: MSI_KEY, value: "x" })).error?.code, -32602);
  assert.equal((await s.action("setBrightness", { value: 3 })).error?.code, -32602);
  assert.match((await s.action("setBrightness", { id: "nope", value: 3 })).error!.message, /gone/);
  await s.done();
});

test("background re-reads only while the page is watched; once at once when it opens; writes still confirm", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const b = two();
  const s = setup(b, { pollMs: 2000 });
  await s.service.start();
  await waitFor(() => s.tool.get(`monitors.${MSI_KEY}.brightness`) === 48 && s.tool.get(`monitors.${ACER_KEY}.brightness`) === 52, "first reads");
  const reads = () => b.calls.filter((c) => c.startsWith("read")).length;
  const atStart = reads();
  for (let i = 0; i < 30; i++) t.mock.timers.tick(2000); // 60 s
  await sleep(30);
  assert.equal(reads(), atStart, "no getvcp while nobody looks");

  // The monitor's own buttons changed it; opening the page reads both now.
  b.mon(1).value = 30;
  s.watch(true);
  await waitFor(() => reads() === atStart + 2, "a read of each monitor when the page opens");
  await waitFor(() => s.tool.get(`monitors.${MSI_KEY}.brightness`) === 30, "fresh value");
  await sleep(20); // the reads' queues settle
  t.mock.timers.tick(2000);
  await waitFor(() => reads() === atStart + 4, "the normal cadence while watched");
  await sleep(20);
  t.mock.timers.tick(2000);
  await waitFor(() => reads() === atStart + 6, "and again");

  s.watch(false);
  await sleep(20);
  const off = reads();
  for (let i = 0; i < 30; i++) t.mock.timers.tick(2000);
  await sleep(30);
  assert.equal(reads(), off, "stops when the last viewer leaves");

  // Unwatched, a write still gets its confirming read, and `read` (brightctl get) reads now.
  assert.equal((await s.action("setBrightness", { id: MSI_KEY, value: 60 })).error, undefined);
  await waitFor(() => reads() === off + 1, "confirming read after the write");
  b.mon(3).value = 11;
  const r = await s.action("read", { target: "DP-2" });
  assert.equal(r.result[0].brightness, 11);
  const l = await s.action("list");
  assert.deepEqual(l.result.map((x: { brightness: number }) => x.brightness).sort(), [11, 60]);
  await s.done();
});
