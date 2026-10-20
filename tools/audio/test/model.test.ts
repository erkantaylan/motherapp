// Parsing pw-dump output and deriving devices, defaults and app rows from it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JsonStreamParser } from "../src/jsonStream.ts";
import { diffState } from "../src/diff.ts";
import {
  PwModel,
  buildView,
  deviceTitles,
  escapeKey,
  findApp,
  findDevice,
  linearToPercent,
  percentToLinear,
  percentToWpctl,
  viewToState,
} from "../src/pipewire.ts";
import type { PwObject } from "../src/pipewire.ts";
import { arctisText, dumpText, monitorBatches, monitorText } from "./fakes.ts";

const ANALOG_OUT = "alsa_output.pci-0000_00_1f.3.analog-stereo";

function viewOf(batch: unknown) {
  const m = new PwModel();
  m.apply(batch);
  return buildView(m.objects.values());
}

test("stream parser splits pw-dump --monitor output at any chunk boundary", () => {
  const text = monitorText();
  const expected = monitorBatches();
  assert.equal(expected.length, 7);
  for (const size of [1, 7, 64, 4096, text.length]) {
    const p = new JsonStreamParser();
    const got: unknown[] = [];
    for (let i = 0; i < text.length; i += size) for (const v of p.push(text.slice(i, i + size))) got.push(JSON.parse(v));
    assert.deepEqual(got, expected, `chunk size ${size}`);
    assert.equal(p.pending, false);
  }
});

test("stream parser ignores brackets and quotes inside strings", () => {
  const p = new JsonStreamParser();
  const tricky = '[{"media.name": "a ] tricky \\" [ name {"}]\n[\n{"id": 1, "info": null}\n]\n';
  const vals = [...p.push(tricky.slice(0, 13)), ...p.push(tricky.slice(13))];
  assert.equal(vals.length, 2);
  assert.deepEqual(JSON.parse(vals[0]!), [{ "media.name": 'a ] tricky " [ name {' }]);
  assert.deepEqual(JSON.parse(vals[1]!), [{ id: 1, info: null }]);
});

test("devices: exact Audio/Sink and Audio/Source only, titled by description like wpctl, sorted", () => {
  const view = viewOf(JSON.parse(dumpText()));
  assert.deepEqual(
    view.sinks.map((d) => [d.id, d.title, d.subtitle]),
    [
      [48, "Built-in Audio Analog Stereo", "ALC1220 Analog"],
      [52, "GA102 High Definition Audio Controller Digital Stereo (HDMI 2)", "X34 P"],
    ],
  );
  assert.deepEqual(view.sources.map((d) => [d.title, d.subtitle]), [["Built-in Audio Analog Stereo", "ALC1220 Analog"]]);
  // not the webcam (Video/Source), the echo-cancel Audio/Source/Virtual or the MIDI bridge
  assert.deepEqual(view.sources.map((d) => d.id), [50]);
  assert.equal(view.sinks[0]!.name, ANALOG_OUT);
});

test("issue #5: a USB headset with Chat and Game PCMs gets distinct titles, as wpctl shows them", () => {
  const view = viewOf(JSON.parse(arctisText()));
  // sink 41's nick is the generic "USB Audio #1", sink 40's is just the card name
  assert.deepEqual(
    view.sinks.map((d) => [d.id, d.title, d.subtitle]),
    [
      [40, "Arctis Pro Wireless Chat", ""],
      [41, "Arctis Pro Wireless Game", ""],
    ],
  );
  assert.deepEqual(view.sources.map((d) => [d.id, d.title, d.subtitle]), [[43, "Arctis Pro Wireless Chat", ""]]);
  assert.equal(viewToState(view).defaultSink, "41");
  assert.equal(findDevice(view, "game").id, 41);
  assert.equal(findDevice(view, "chat", "sink").id, 40);
  assert.throws(() => findDevice(view, "Arctis Pro Wireless Chat"), /matches several devices: 40 .*, 43/);
});

test("deviceTitles: description first; the nick only as a second line, and only if it adds something", () => {
  const t = (props: Record<string, string>) => deviceTitles(props, "node.name.x");
  assert.deepEqual(t({ "node.description": "Arctis Pro Wireless Game", "node.nick": "USB Audio #1" }), { title: "Arctis Pro Wireless Game", subtitle: "" });
  assert.deepEqual(t({ "node.description": "Monitor Digital Stereo (HDMI)", "node.nick": "DELL U2720Q" }), { title: "Monitor Digital Stereo (HDMI)", subtitle: "DELL U2720Q" });
  // generic ALSA PCM names never show
  for (const nick of ["USB Audio", "USB Audio #2", "HDMI 0", "HDMI #3", "DisplayPort 1", "Digital", "Analog #1", "subdevice #0"]) {
    assert.deepEqual(t({ "node.description": "Some Card Analog Stereo", "node.nick": nick }), { title: "Some Card Analog Stereo", subtitle: "" }, nick);
  }
  // no description: a useful nick, else the node name
  assert.deepEqual(t({ "node.nick": "Scarlett 2i2" }), { title: "Scarlett 2i2", subtitle: "" });
  assert.deepEqual(t({ "node.nick": "USB Audio #1" }), { title: "node.name.x", subtitle: "" });
  assert.deepEqual(t({}), { title: "node.name.x", subtitle: "" });
});

test("defaults come from the default metadata (node names) and map to ids", () => {
  const view = viewOf(JSON.parse(dumpText()));
  assert.equal(view.defaultSinkName, ANALOG_OUT);
  const s = viewToState(view);
  assert.equal(s.defaultSink, "48");
  assert.equal(s.defaultSource, "50");
  // a default naming a node that doesn't exist (yet) shows no default
  const m = new PwModel();
  m.apply(JSON.parse(dumpText()));
  m.apply([{ id: 34, type: "PipeWire:Interface:Metadata", props: { "metadata.name": "default" }, metadata: [{ subject: 0, key: "default.audio.sink", type: "Spa:String:JSON", value: { name: "gone" } }] }]);
  assert.equal(viewToState(buildView(m.objects.values())).defaultSink, "");
  // the value may also arrive as a JSON string
  m.apply([{ id: 34, type: "PipeWire:Interface:Metadata", props: { "metadata.name": "default" }, metadata: [{ subject: 0, key: "default.audio.sink", type: "Spa:String:JSON", value: `{"name":"${ANALOG_OUT}"}` }] }]);
  assert.equal(viewToState(buildView(m.objects.values())).defaultSink, "48");
});

test("apps: one row per app, input streams excluded, volume on the wpctl scale", () => {
  const view = viewOf(JSON.parse(dumpText()));
  assert.deepEqual(
    view.apps.map((a) => [a.key, a.name, a.streams.map((s) => s.id)]),
    [
      ["Firefox", "Firefox", [101, 102]],
      ["mpv", "mpv", [115]],
      ["Spotify", "Spotify", [110]],
    ],
  );
  const s = viewToState(view);
  assert.deepEqual(s.apps, {
    Firefox: { name: "Firefox", volume: 70, muted: false, streams: 2, detail: "2 streams" },
    mpv: { name: "mpv", volume: 90, muted: false, streams: 1, detail: "Daft Punk - Veridis Quo.flac" },
    Spotify: { name: "Spotify", volume: 100, muted: false, streams: 1, detail: "" },
  });
});

const stream = (id: number, props: Record<string, unknown>, vols = [1, 1], mute = false): PwObject =>
  ({
    id,
    type: "PipeWire:Interface:Node",
    info: { props: { "media.class": "Stream/Output/Audio", ...props }, params: { Props: [{ volume: 1, mute, channelVolumes: vols }] } },
  }) as unknown as PwObject;

test("app grouping falls back to the binary, then the node name; loudest stream, muted only if all are", () => {
  const view = buildView([
    stream(1, { "application.process.binary": "aplay", "node.name": "x" }, [0.125, 0.125]),
    stream(2, { "application.process.binary": "aplay" }, [0.729, 0.343], true),
    stream(3, { "node.name": "alsa_playback.speaker-test" }),
    stream(4, {}),
  ]);
  assert.deepEqual(view.apps.map((a) => a.name), ["alsa_playback.speaker-test", "aplay", "Stream 4"]);
  const s = viewToState(view).apps as Record<string, { volume: number; muted: boolean }>;
  // stream 2: average of 0.729 and 0.343 = 0.536 -> cbrt = 0.8122 -> 81
  assert.equal(s.aplay!.volume, 81);
  assert.equal(s.aplay!.muted, false);
  // keys never contain "." (state paths)
  assert.equal(escapeKey("alsa_playback.speaker-test"), "alsa_5fplayback_2espeaker-test");
  assert.ok(Object.keys(s).every((k) => !k.includes(".")));
});

test("event and notification streams and the tool's own test sounds are skipped", () => {
  const view = buildView(
    [
      stream(1, { "application.name": "GNOME Shell", "media.role": "event" }),
      stream(2, { "application.name": "Telegram", "media.role": "Notification" }),
      stream(3, { "application.name": "pw-play", "application.process.id": 4242 }),
      stream(4, { "application.name": "Rhythmbox", "media.role": "Music" }),
    ],
    { isOwnPid: (pid) => pid === 4242 },
  );
  assert.deepEqual(view.apps.map((a) => a.name), ["Rhythmbox"]);
});

test("volume conversion matches wpctl: linear channelVolumes are the cube of what wpctl shows", () => {
  assert.equal(linearToPercent(0.343), 70);
  assert.equal(linearToPercent(1), 100);
  assert.equal(linearToPercent(0.125), 50);
  assert.equal(linearToPercent(3.375), 150);
  assert.equal(linearToPercent(0), 0);
  assert.equal(percentToWpctl(70), "0.70");
  assert.equal(percentToWpctl(150), "1.50");
  for (let p = 0; p <= 150; p++) {
    // what pw-dump prints after `wpctl set-volume X <p/100>` (6 decimals) reads back as p
    const printed = Number(percentToLinear(p).toFixed(6));
    assert.equal(linearToPercent(printed), p, `percent ${p}`);
  }
});

test("monitor sequence: additions, partial metadata updates and info:null removals", () => {
  const [initial, ...rest] = monitorBatches();
  const m = new PwModel();
  m.apply(initial);
  const states = [viewToState(buildView(m.objects.values()))];
  for (const b of rest) {
    m.apply(b);
    states.push(viewToState(buildView(m.objects.values())));
  }
  const apps = (i: number) => states[i]!.apps as Record<string, Record<string, unknown>>;
  assert.equal(apps(1).Spotify!.volume, 50);
  assert.deepEqual(Object.keys(states[2]!.sinks as object), ["48", "52", "71"]);
  assert.deepEqual(Object.keys(states[2]!.sources as object), ["50", "72"]);
  assert.equal(states[2]!.defaultSink, "71");
  assert.deepEqual(states[3], states[2]); // event sounds change nothing
  assert.equal(apps(4).Firefox!.streams, 1);
  assert.equal(apps(5).Spotify, undefined);
  assert.equal(apps(5).Firefox!.muted, true);
  assert.deepEqual(Object.keys(states[6]!.sinks as object), ["48", "52"]);
  assert.equal(states[6]!.defaultSink, "48");
  // the metadata update merged into the old entries instead of replacing them
  assert.equal(states[6]!.defaultSource, "50");
  // the removal objects themselves left nothing behind
  assert.equal(m.objects.has(71), false);
  assert.equal(m.objects.has(102), false);
});

test("metadata: value null deletes an entry", () => {
  const m = new PwModel();
  m.apply(JSON.parse(dumpText()));
  m.apply([{ id: 34, type: "PipeWire:Interface:Metadata", props: { "metadata.name": "default" }, metadata: [{ subject: 0, key: "default.audio.source", type: null, value: null }] }]);
  const v = buildView(m.objects.values());
  assert.equal(v.defaultSourceName, undefined);
  assert.equal(v.defaultSinkName, ANALOG_OUT);
});

test("diffState: minimal changes, null for removed keys", () => {
  assert.deepEqual(diffState("apps", { a: { v: 1, m: false } }, { a: { v: 2, m: false } }), [{ path: "apps.a.v", value: 2 }]);
  assert.deepEqual(diffState("apps", { a: { v: 1 }, b: { v: 1 } }, { a: { v: 1 } }), [{ path: "apps.b", value: null }]);
  assert.deepEqual(diffState("apps", {}, { c: { v: 3 } }), [{ path: "apps.c", value: { v: 3 } }]);
  assert.deepEqual(diffState("defaultSink", "48", "71"), [{ path: "defaultSink", value: "71" }]);
  assert.deepEqual(diffState("x", { l: [1, 2] }, { l: [1, 2] }), []);
});

test("findDevice and findApp: by id, node name, title, unique substring; ambiguity is an error", () => {
  const view = viewOf(JSON.parse(dumpText()));
  assert.equal(findDevice(view, "52").id, 52);
  assert.equal(findDevice(view, ANALOG_OUT).id, 48);
  assert.equal(findDevice(view, "hdmi").id, 52);
  assert.equal(findDevice(view, "x34 p", "sink").id, 52);
  assert.throws(() => findDevice(view, "Built-in"), /matches several devices: 48 \(Built-in Audio Analog Stereo\), 50/);
  assert.equal(findDevice(view, "Built-in", "source").id, 50);
  assert.throws(() => findDevice(view, "50", "sink"), /No output with id 50/);
  assert.throws(() => findDevice(view, "nothing"), /No device matches "nothing"/);
  assert.equal(findApp(view, "firefox").key, "Firefox");
  assert.equal(findApp(view, "spot").key, "Spotify");
  assert.throws(() => findApp(view, "vlc"), /No app playing sound matches "vlc"/);
});
