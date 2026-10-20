// Serve mode against a fake `pw-dump --monitor`: deltas, actions, coalescing, streams, restarts.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { createTool } from "@motherapp/tool-sdk";
import { LineDecoder } from "@motherapp/protocol";
import { Coalescer } from "../src/coalescer.ts";
import { chunkLevel, CHUNK_BYTES } from "../src/level.ts";
import { layout } from "../src/layout.ts";
import { AudioService, INITIAL_STATE } from "../src/service.ts";
import { FakeRunner, FakeTimers, monitorBatches, tick, tone, waitFor } from "./fakes.ts";
import type { FakeProc } from "./fakes.ts";

const ANALOG_IN = "alsa_input.pci-0000_00_1f.3.analog-stereo";
const HDMI_OUT = "alsa_output.pci-0000_01_00.1.hdmi-stereo-extra1";

type Msg = { id?: number; method?: string; params?: any; result?: any; error?: { code: number; message: string } };

function setup(opts: { sounds?: string[] } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const tool = createTool({ id: "audio", title: "Audio", layout, initialState: INITIAL_STATE, persist: false, captureConsole: false, input, output });
  const runner = new FakeRunner();
  const timers = new FakeTimers();
  // pw-dump --monitor keeps running until the test ends it; everything else exits 0.
  runner.behave = (p) => {
    if (p.cmd !== "pw-dump" && p.cmd !== "pw-record") p.exit(0);
  };
  const service = new AudioService({
    tool,
    runner,
    timers,
    ops: { testSounds: opts.sounds ?? [], recordSeconds: 1, killGraceMs: 20 },
  });
  const received: Msg[] = [];
  const dec = new LineDecoder();
  output.setEncoding("utf8");
  output.on("data", (c: string) => {
    for (const l of dec.push(c)) received.push(JSON.parse(l));
  });
  let id = 0;
  const call = async (method: string, params?: unknown): Promise<Msg> => {
    const myId = ++id;
    input.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
    await waitFor(() => received.some((m) => m.id === myId), `reply to ${method}`);
    return received.find((m) => m.id === myId)!;
  };
  const action = (name: string, args: unknown) => call("action", { name, args });
  let mark = 0;
  /** state changes notified since the last call. */
  const changes = () => {
    const out = received.slice(mark).filter((m) => m.method === "state").flatMap((m) => m.params.changes);
    mark = received.length;
    return out;
  };
  const notes = (method: string) => received.filter((m) => m.method === method).map((m) => m.params);
  const done = tool.serve();
  service.start();
  const monitor = () => runner.find("pw-dump").at(-1)!;
  /** Writes one batch as pw-dump would and waits for the resulting notification flush. */
  const feed = async (batch: unknown, p = monitor()) => {
    p.stdout.write(JSON.stringify(batch, null, 2) + "\n");
    await tick();
    await tick();
  };
  const end = async () => {
    service.stop();
    input.end();
    await done;
  };
  return { tool, runner, timers, service, call, action, changes, notes, received, feed, monitor, end };
}

test("starts pw-dump --monitor without colours; the first dump replaces the stale startup state", async () => {
  const h = setup();
  await tick();
  assert.deepEqual(h.runner.lines(), ["pw-dump --monitor"]);
  assert.equal(h.monitor().env?.NO_COLOR, "1");
  const before = (await h.call("state.get")).result;
  assert.deepEqual(before.stale.sort(), ["apps", "defaultSink", "defaultSource", "sinks", "sources"]);
  h.changes();
  await h.feed(monitorBatches()[0]);
  const c = h.changes();
  // one change per key, whole values, all fresh
  assert.deepEqual(c.map((x: any) => x.path), ["sinks", "sources", "defaultSink", "defaultSource", "apps"]);
  assert.ok(c.every((x: any) => !x.stale));
  const snap = (await h.call("state.get")).result;
  assert.deepEqual(snap.stale, []);
  assert.deepEqual(Object.keys(snap.state.sinks), ["48", "52"]);
  assert.equal(snap.state.defaultSink, "48");
  assert.deepEqual(Object.keys(snap.state.apps), ["Firefox", "mpv", "Spotify"]);
  await h.end();
});

test("each monitor update publishes only the minimal delta", async () => {
  const h = setup();
  await tick();
  const [initial, ...rest] = monitorBatches();
  await h.feed(initial);
  h.changes();
  const expected = [
    // 1: Spotify's volume (and a sink state change, which isn't in the tool state)
    [{ path: "apps.Spotify.volume", value: 50 }],
    // 2: headset plugged in and made default
    [
      { path: "sinks.71", value: { name: "alsa_output.usb-Logitech_G435_Wireless_Gaming_Headset_V001008005.1-01.analog-stereo", title: "G435 Wireless Gaming Headset Analog Stereo", subtitle: "" } },
      { path: "sources.72", value: { name: "alsa_input.usb-Logitech_G435_Wireless_Gaming_Headset_V001008005.1-01.mono-fallback", title: "G435 Wireless Gaming Headset Mono", subtitle: "" } },
      { path: "defaultSink", value: "71" },
    ],
    // 3: event sounds: nothing
    [],
    // 4: one of Firefox's streams ends
    [
      { path: "apps.Firefox.streams", value: 1 },
      { path: "apps.Firefox.detail", value: "AudioStream" },
    ],
    // 5: Spotify quits, Firefox is muted
    [
      { path: "apps.Spotify", value: null },
      { path: "apps.Firefox.muted", value: true },
    ],
    // 6: headset unplugged
    [
      { path: "sinks.71", value: null },
      { path: "sources.72", value: null },
      { path: "defaultSink", value: "48" },
    ],
  ];
  for (const [i, b] of rest.entries()) {
    await h.feed(b);
    assert.deepEqual(h.changes(), expected[i], `batch ${i + 1}`);
  }
  await h.end();
});

test("setDefault, setAppVolume and setAppMute run the right wpctl commands", async () => {
  const h = setup();
  await tick();
  await h.feed(monitorBatches()[0]);
  h.changes();

  assert.equal((await h.action("setDefault", { id: "52", value: "52" })).result, null);
  assert.deepEqual(h.runner.lines("wpctl"), ["wpctl set-default 52"]);
  assert.deepEqual(h.changes(), [{ path: "defaultSink", value: "52" }]);

  await h.action("setAppVolume", { app: "Firefox", value: 55 });
  assert.deepEqual(h.runner.lines("wpctl").slice(1), ["wpctl set-volume 101 0.55", "wpctl set-volume 102 0.55"]);
  assert.deepEqual(h.changes(), [{ path: "apps.Firefox.volume", value: 55 }]);
  // values are clamped to 0..150 and rounded
  await h.action("setAppVolume", { app: "mpv", value: 400.4 });
  assert.equal(h.runner.lines("wpctl").at(-1), "wpctl set-volume 115 1.50");

  await h.action("setAppMute", { app: "Spotify", value: true });
  assert.equal(h.runner.lines("wpctl").at(-1), "wpctl set-mute 110 1");
  await h.action("setAppMute", { app: "Firefox", value: "toggle" });
  assert.deepEqual(h.runner.lines("wpctl").slice(-2), ["wpctl set-mute 101 1", "wpctl set-mute 102 1"]);

  // bad arguments and gone apps/devices are errors with readable messages
  assert.equal((await h.action("setAppVolume", { app: "Firefox", value: "loud" })).error?.code, -32602);
  assert.equal((await h.action("setDefault", { id: "x" })).error?.code, -32602);
  assert.match((await h.action("setAppVolume", { app: "VLC", value: 10 })).error!.message, /not playing sound anymore/);
  assert.match((await h.action("setDefault", { id: 999 })).error!.message, /is gone \(id 999\)/);
  await h.end();
});

test("a failing wpctl becomes a failed action with its message; the state isn't touched", async () => {
  const h = setup();
  await tick();
  await h.feed(monitorBatches()[0]);
  h.changes();
  h.runner.behave = (p) => {
    if (p.cmd === "wpctl") p.fail(1, "Object '110' not found\n");
  };
  const r = await h.action("setAppVolume", { app: "Spotify", value: 20 });
  assert.equal(r.error?.code, -32000);
  assert.equal(r.error?.message, "wpctl set-volume failed: Object '110' not found");
  h.runner.behave = (p) => p.emit("error", Object.assign(new Error("spawn wpctl ENOENT"), { code: "ENOENT" }));
  const r2 = await h.action("setDefault", { id: 48 });
  assert.equal(r2.error?.message, "wpctl not found (is WirePlumber installed?)");
  assert.deepEqual(h.changes(), []);
  await h.end();
});

test("slider drags are serialized per app; only the newest pending value is written", async () => {
  const h = setup();
  await tick();
  await h.feed(monitorBatches()[0]);
  const held: FakeProc[] = [];
  h.runner.behave = (p) => {
    if (p.cmd === "wpctl") held.push(p);
  };
  const replies = [10, 20, 30, 40].map((v) => h.action("setAppVolume", { app: "Spotify", value: v }));
  await waitFor(() => held.length === 1, "first wpctl");
  await tick();
  assert.equal(held.length, 1, "nothing else starts while a write is running");
  held[0]!.exit(0);
  await waitFor(() => held.length === 2, "second wpctl");
  held[1]!.exit(0);
  const results = await Promise.all(replies);
  assert.ok(results.every((r) => r.error === undefined));
  assert.deepEqual(h.runner.lines("wpctl"), ["wpctl set-volume 110 0.10", "wpctl set-volume 110 0.40"]);
  assert.equal(h.tool.get("apps.Spotify.volume"), 40);
  await h.end();
});

test("Coalescer: superseded callers share the newest write's outcome", async () => {
  const c = new Coalescer();
  const ran: number[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const p1 = c.run("k", async () => {
    ran.push(1);
    await gate;
  });
  const p2 = c.run("k", async () => void ran.push(2));
  const p3 = c.run("k", async () => {
    ran.push(3);
    throw new Error("boom");
  });
  const other = c.run("other", async () => void ran.push(9));
  assert.equal(c.busy("k"), true);
  release();
  await p1;
  await assert.rejects(p2, /boom/);
  await assert.rejects(p3, /boom/);
  await other;
  assert.deepEqual(ran, [1, 9, 3]);
  assert.equal(c.busy("k"), false);
});

test("testOutput plays left then right on that sink; its own stream never becomes an app row", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ma-audio-"));
  const sounds = ["left.oga", "right.oga"].map((f) => path.join(dir, f));
  for (const f of sounds) fs.writeFileSync(f, "");
  const h = setup({ sounds });
  await tick();
  await h.feed(monitorBatches()[0]);
  h.changes();
  let playPid = 0;
  h.runner.behave = (p) => {
    if (p.cmd !== "pw-play") return p.exit(0);
    playPid = p.pid;
    // while pw-play runs, PipeWire shows its stream
    void h.feed([{ id: 140, type: "PipeWire:Interface:Node", info: { props: { "media.class": "Stream/Output/Audio", "application.name": "pw-play", "application.process.id": p.pid, "node.name": "pw-play" }, params: {} } }]).then(() => p.exit(0));
  };
  assert.equal((await h.action("testOutput", { id: 52 })).result, null);
  assert.deepEqual(h.runner.lines("pw-play"), [`pw-play --target ${HDMI_OUT} ${sounds[0]}`, `pw-play --target ${HDMI_OUT} ${sounds[1]}`]);
  assert.ok(playPid > 0);
  assert.deepEqual(h.changes(), []);
  // an input can't be tested as an output; a missing sound file is a clear error
  assert.match((await h.action("testOutput", { id: 50 })).error!.message, /That output is gone/);
  fs.rmSync(dir, { recursive: true });
  assert.match((await h.action("testOutput", { id: 48 })).error!.message, /Test sound not found: .*left\.oga \(install sound-theme-freedesktop\)/);
  await h.end();
});

test("recordTest records from the source, then plays the recording on the default output", async () => {
  const h = setup();
  await tick();
  await h.feed(monitorBatches()[0]);
  const second = tone(48000, 1000); // 1 s of mono s16
  h.runner.behave = (p) => {
    if (p.cmd === "pw-record") {
      p.stdout.write(second.subarray(0, 50000));
      p.stdout.write(Buffer.concat([second.subarray(50000), tone(4800, 1)])); // more than asked for: cut off
    } else if (p.cmd !== "pw-dump") p.exit(0);
  };
  const r = await h.action("recordTest", { id: "50" });
  assert.equal(r.error, undefined);
  assert.deepEqual(h.runner.lines("pw-record"), [`pw-record --target ${ANALOG_IN} --format s16 --rate 48000 --channels 1 -`]);
  assert.deepEqual(h.runner.find("pw-record")[0]!.signals, ["SIGTERM"]);
  const play = h.runner.find("pw-play")[0]!;
  assert.deepEqual(play.args, ["--format", "s16", "--rate", "48000", "--channels", "1", "-"]);
  assert.ok(play.stdinData.equals(second));
  const progress = h.notes("progress").map((p: any) => p.text);
  assert.deepEqual(progress, ["Recording 1 s from Built-in Audio Analog Stereo, speak now", "Playing back", "Done"]);

  // pw-record dying early is a failed action
  h.runner.behave = (p) => {
    if (p.cmd === "pw-record") p.fail(1, "error: target not found\n");
  };
  assert.match((await h.action("recordTest", { id: 50 })).error!.message, /pw-record stopped before 1 s were recorded: error: target not found/);
  await h.end();
});

test("level stream: pw-record runs only while the stream is open and is killed on close", async () => {
  const h = setup();
  await tick();
  await h.feed(monitorBatches()[0]);
  assert.equal((await h.call("stream.open", { name: "level/50" })).result, null);
  await waitFor(() => h.runner.find("pw-record").length === 1, "pw-record");
  const rec = h.runner.find("pw-record")[0]!;
  assert.deepEqual(rec.args, ["--target", ANALOG_IN, "--format", "s16", "--rate", "48000", "--channels", "1", "-"]);
  // 2.5 chunks in one write -> one value (the newest full chunk); the rest waits
  rec.stdout.write(Buffer.concat([tone(2400, 3277), tone(2400, 3277), tone(1200, 0)]));
  await waitFor(() => h.notes("stream").length === 1, "level value");
  const v = h.notes("stream")[0];
  assert.equal(v.name, "level/50");
  assert.ok(Math.abs(v.value - chunkLevel(tone(CHUNK_BYTES / 2, 3277))) < 1e-9);
  assert.ok(v.value > 0.6 && v.value < 0.7); // -20 dBFS -> 0.667
  assert.equal(rec.signals.length, 0);
  await h.call("stream.close", { name: "level/50" });
  assert.deepEqual(rec.signals, ["SIGTERM"]);
  const n = h.notes("stream").length;
  rec.stdout.write(tone(4800, 3277));
  await tick();
  assert.equal(h.notes("stream").length, n, "nothing after close");

  // a recorder that ignores SIGTERM gets SIGKILL
  await h.call("stream.open", { name: "level/50" });
  await waitFor(() => h.runner.find("pw-record").length === 2, "second pw-record");
  const stubborn = h.runner.find("pw-record")[1]!;
  stubborn.exitOnKill = false;
  await h.call("stream.close", { name: "level/50" });
  await waitFor(() => stubborn.signals.length === 2, "SIGKILL");
  assert.deepEqual(stubborn.signals, ["SIGTERM", "SIGKILL"]);
  stubborn.exit(null, "SIGKILL");

  // an unknown source doesn't start anything
  await h.call("stream.open", { name: "level/999" });
  await tick();
  assert.equal(h.runner.find("pw-record").length, 2);
  await h.end();
});

test("shutdown kills an open level meter's recorder", async () => {
  const h = setup();
  await tick();
  await h.feed(monitorBatches()[0]);
  await h.call("stream.open", { name: "level/50" });
  await waitFor(() => h.runner.find("pw-record").length === 1, "pw-record");
  await h.end();
  assert.deepEqual(h.runner.find("pw-record")[0]!.signals, ["SIGTERM"]);
  assert.deepEqual(h.monitor().signals, ["SIGTERM"]);
});

test("pw-dump exiting: logged, state marked stale, restarted with backoff, full dump replaces the model", async () => {
  const h = setup();
  await tick();
  const [initial, , plugged] = monitorBatches();
  await h.feed(initial);
  await h.feed(plugged);
  h.changes();
  h.monitor().fail(1, "pw-dump: can't connect: Host is down\n");
  await waitFor(() => h.timers.pending().length === 1, "restart timer");
  assert.deepEqual(h.timers.pending(), [1000]);
  const c = h.changes();
  assert.ok(c.filter((x: any) => x.stale).length === 5);
  assert.match(h.tool.get("status") as string, /pw-dump: exit code 1: pw-dump: can't connect: Host is down\). Retrying in 1 s/);
  assert.ok(h.notes("log").some((l: any) => l.level === "warn" && /pw-dump --monitor stopped: exit code 1.*restarting in 1 s/.test(l.msg)));

  // fails again straight away: the delay doubles
  h.timers.advance(1000);
  await tick();
  assert.equal(h.runner.find("pw-dump").length, 2);
  h.monitor().fail(1, "");
  await waitFor(() => h.timers.pending().length === 1, "second restart timer");
  assert.deepEqual(h.timers.pending(), [2000]);
  h.timers.advance(2000);
  await tick();
  assert.equal(h.runner.find("pw-dump").length, 3);
  h.changes();

  // the new run's first dump no longer has the headset: it's gone, everything is fresh
  await h.feed(initial);
  const snap = (await h.call("state.get")).result;
  assert.deepEqual(snap.stale, []);
  assert.deepEqual(Object.keys(snap.state.sinks), ["48", "52"]);
  assert.equal(snap.state.defaultSink, "48");
  assert.equal(snap.state.status, undefined);
  assert.ok(h.notes("log").some((l: any) => l.msg === "pw-dump --monitor is running again"));

  // a long healthy run resets the backoff
  h.timers.advance(60_000);
  h.monitor().exit(0);
  await waitFor(() => h.timers.pending().length === 1, "third restart timer");
  assert.deepEqual(h.timers.pending(), [1000]);
  await h.end();
});

test("layout: Outputs, Inputs and Apps lists keyed by map key, using only the existing widgets", () => {
  const lists = layout.filter((w) => w.type === "list");
  assert.deepEqual(lists.map((l) => [l.label, l.bind]), [["Outputs", "sinks"], ["Inputs", "sources"], ["Apps", "apps"]]);
  const types = new Set<string>();
  const walk = (ws: typeof layout) => ws.forEach((w) => (types.add(w.type), w.type === "list" && walk(w.item.widgets ?? [])));
  walk(layout);
  assert.ok([...types].every((t) => ["text", "button", "toggle", "slider", "radio", "meter", "list"].includes(t)));
});
