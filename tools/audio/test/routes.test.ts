// Outputs and inputs a card offers but has no node for (routes on an inactive profile, or not
// the active route of their device), against a real pw-dump captured on the machine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createTool } from "@motherapp/tool-sdk";
import { LineDecoder } from "@motherapp/protocol";
import { runCli } from "../src/cli.ts";
import { layout } from "../src/layout.ts";
import { PwModel, buildView, findTarget, routeNode, viewToState } from "../src/pipewire.ts";
import type { PwObject } from "../src/pipewire.ts";
import { AudioService, INITIAL_STATE } from "../src/service.ts";
import { FakeRunner, FakeTimers, realText, realToHfpBatches, tick, waitFor } from "./fakes.ts";

const real = () => JSON.parse(realText()) as PwObject[];

function modelOf(...batches: unknown[]) {
  const m = new PwModel();
  for (const b of batches) m.apply(b);
  return m;
}
const viewOf = (...batches: unknown[]) => buildView(modelOf(...batches).objects.values());
/** The real graph after the JBL switched to HFP, as one full dump. */
const hfpDump = () => [...modelOf(real(), ...realToHfpBatches()).objects.values()];

test("real graph: every available route is listed, GNOME's 8 outputs, titled like GNOME", () => {
  const v = viewOf(real());
  assert.deepEqual(
    v.sinks.map((d) => [d.id, d.title, d.subtitle]),
    [
      [33, "GA102 High Definition Audio Controller Digital Stereo (HDMI 2)", "Acer X34 P"],
      [42, "HyperX QuadCast Digital Stereo (IEC958)", ""],
      [98, "JBL Tune Flex 2", "A2DP: high fidelity"],
      [56, "Starship/Matisse HD Audio Controller Digital Stereo (IEC958)", "ALC1220 Digital"],
    ],
  );
  // routes with no node; Headphones and HDMI 3/4 are available "no", so they are left out
  assert.deepEqual(
    v.sinkRoutes.map((r) => [r.key, r.title, r.subtitle, r.profile, r.device]),
    [
      ["route-148-3", "Handsfree – JBL Tune Flex 2", "HFP: headset with mic", 261, 1],
      ["route-51-0", "HDMI / DisplayPort – GA102 High Definition Audio Controller", "", 1, 4],
      // profile 1 (Analog Stereo Duplex) keeps the card's analog mic, unlike profile 2
      ["route-50-3", "Line Out – Starship/Matisse HD Audio Controller", "", 1, 5],
      ["route-52-2", "Speakers – HyperX QuadCast", "", 1, 4],
    ],
  );
  assert.equal(v.sinks.length + v.sinkRoutes.length, 8);
  assert.deepEqual(
    v.sourceRoutes.map((r) => [r.key, r.title, r.profile, r.device]),
    [
      ["route-53-1", "Digital Input (S/PDIF) – C920 HD Pro Webcam", 2, 2],
      // keeps the S/PDIF output that is active: Digital Stereo Duplex
      ["route-52-1", "Digital Input (S/PDIF) – HyperX QuadCast", 5, 3],
      ["route-148-2", "Handsfree – JBL Tune Flex 2", 261, 0],
    ],
  );
  const s = viewToState(v);
  assert.deepEqual((s.sinks as any)["route-50-3"], { name: "", title: "Line Out – Starship/Matisse HD Audio Controller", subtitle: "" });
  assert.equal(s.defaultSink, "98");
});

test("real graph after the JBL switched to HFP: its node is the route's node, A2DP is the option now", () => {
  const before = viewOf(real());
  const after = viewOf(real(), ...realToHfpBatches());
  const hfpOut = before.sinkRoutes.find((r) => r.key === "route-148-3")!;
  assert.equal(routeNode(before, hfpOut), undefined); // node 98 is the A2DP sink: not the route's yet
  const node = routeNode(after, hfpOut)!;
  assert.deepEqual([node.id, node.title, node.subtitle], [129, "JBL Tune Flex 2", "HFP: headset with mic"]);
  // ids are reused: 98 is now the headset mic
  const mic = routeNode(after, before.sourceRoutes.find((r) => r.key === "route-148-2")!)!;
  assert.deepEqual([mic.id, mic.kind, mic.subtitle], [98, "source", "HFP: headset with mic"]);
  assert.deepEqual(
    after.sinkRoutes.filter((r) => r.card === 148).map((r) => [r.key, r.title, r.subtitle, r.profile]),
    [["route-148-1", "Headset – JBL Tune Flex 2", "A2DP: high fidelity", 5]],
  );
  assert.deepEqual(after.sourceRoutes.filter((r) => r.card === 148), []);
});

/** The real Starship card on profile 1 with Line Out active and Headphones plugged in. */
function starshipAnalog(): PwObject[] {
  const objs = real();
  const card = objs.find((o) => o.id === 50)! as any;
  const params = card.info.params;
  params.Profile = [params.EnumProfile.find((p: any) => p.index === 1)];
  for (const r of params.EnumRoute) if (r.name === "analog-output-headphones") r.available = "yes";
  const lineout = params.EnumRoute.find((r: any) => r.name === "analog-output-lineout");
  const mic = params.Route.find((r: any) => r.direction === "Input");
  params.Route = [mic, { ...lineout, device: 5, profile: 1 }];
  const node = objs.find((o) => o.id === 56)! as any;
  Object.assign(node.info.props, { "card.profile.device": 5, "node.name": "alsa_output.pci-0000_0c_00.4.analog-stereo", "node.description": "Starship/Matisse HD Audio Controller Analog Stereo", "node.nick": "ALC1220 Analog" });
  return objs;
}

test("a route on the active profile that isn't the active one only switches the port", () => {
  const v = viewOf(starshipAnalog());
  const hp = v.sinkRoutes.find((r) => r.routeName === "analog-output-headphones")!;
  assert.deepEqual([hp.key, hp.title, hp.profile, hp.device], ["route-50-4", "Headphones – Starship/Matisse HD Audio Controller", undefined, 5]);
  assert.equal(routeNode(v, hp)?.id, 56);
  // S/PDIF needs profile 3 (keeps the analog mic), not 4
  assert.equal(v.sinkRoutes.find((r) => r.key === "route-50-5")?.profile, 3);
});

test("findTarget: route keys and titles; ambiguity across outputs and inputs is an error", () => {
  const v = viewOf(real());
  assert.equal((findTarget(v, "route-50-3") as any).route.routeName, "analog-output-lineout");
  assert.equal((findTarget(v, "line out") as any).route.key, "route-50-3");
  assert.equal((findTarget(v, "56") as any).device.id, 56);
  assert.throws(() => findTarget(v, "Handsfree"), /matches several devices: route-148-3 .*route-148-2/);
  assert.equal((findTarget(v, "Handsfree", "source") as any).route.key, "route-148-2");
  // an exact title wins over the route whose title contains it
  assert.equal((findTarget(v, "JBL Tune Flex 2", "sink") as any).device.id, 98);
});

// ---- serve mode ----

function setup() {
  const input = new PassThrough();
  const output = new PassThrough();
  const tool = createTool({ id: "audio", title: "Audio", layout, initialState: INITIAL_STATE, persist: false, captureConsole: false, input, output });
  const runner = new FakeRunner();
  const timers = new FakeTimers();
  runner.behave = (p) => {
    if (p.cmd !== "pw-dump") p.exit(0);
  };
  const service = new AudioService({ tool, runner, timers, ops: { testSounds: [] } });
  const received: any[] = [];
  const dec = new LineDecoder();
  output.setEncoding("utf8");
  output.on("data", (c: string) => {
    for (const l of dec.push(c)) received.push(JSON.parse(l));
  });
  let id = 0;
  const action = async (name: string, args: unknown) => {
    const myId = ++id;
    input.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method: "action", params: { name, args } }) + "\n");
    await waitFor(() => received.some((m) => m.id === myId), `reply to ${name}`);
    return received.find((m) => m.id === myId);
  };
  const done = tool.serve();
  service.start();
  const feed = async (batch: unknown) => {
    runner.find("pw-dump").at(-1)!.stdout.write(JSON.stringify(batch) + "\n");
    await tick();
    await tick();
  };
  const end = async () => {
    service.stop();
    input.end();
    await done;
  };
  return { tool, runner, timers, service, action, feed, end };
}

test("serve: selecting the JBL's Handsfree switches the profile, waits for the node, then makes it the default", async () => {
  const h = setup();
  await tick();
  await h.feed(real());
  assert.deepEqual(h.tool.get("sinks.route-148-3"), { name: "", title: "Handsfree – JBL Tune Flex 2", subtitle: "HFP: headset with mic" });
  const reply = h.action("setDefault", { id: "route-148-3", value: "route-148-3" });
  await waitFor(() => h.runner.lines("wpctl").includes("wpctl set-profile 148 261"), "set-profile");
  await tick();
  assert.deepEqual(h.runner.lines("wpctl"), ["wpctl set-profile 148 261"]); // nothing else before the node shows up
  for (const b of realToHfpBatches()) await h.feed(b);
  const r = await reply;
  assert.equal(r.error, undefined);
  assert.deepEqual(h.runner.lines("wpctl"), ["wpctl set-profile 148 261", "wpctl set-default 129"]);
  assert.deepEqual(h.runner.lines("pw-cli"), []); // WirePlumber already made Handsfree the active route
  assert.equal(h.tool.get("defaultSink"), "129");
  assert.equal(h.tool.get("sinks.route-148-3"), undefined);
  assert.equal(h.tool.get("sinks.129.subtitle"), "HFP: headset with mic");
  assert.equal(h.tool.get("sinks.route-148-1.title"), "Headset – JBL Tune Flex 2");
  assert.equal(h.tool.get("sources.98.title"), "JBL Tune Flex 2");
  await h.end();
});

test("serve: a node that never shows up fails the action after the timeout", async () => {
  const h = setup();
  await tick();
  await h.feed(real());
  const reply = h.action("setDefault", { id: "route-50-3" });
  await waitFor(() => h.timers.pending().includes(10_000), "the wait for the node");
  assert.deepEqual(h.runner.lines("wpctl"), ["wpctl set-profile 50 1"]);
  h.timers.advance(10_000);
  const r = await reply;
  assert.match(r.error.message, /Line Out – Starship\/Matisse HD Audio Controller: no output appeared within 10 s/);
  assert.deepEqual(h.runner.lines("wpctl"), ["wpctl set-profile 50 1"]);
  await h.end();
});

test("serve: switching the port of the active profile goes through pw-cli, then sets the default", async () => {
  const h = setup();
  await tick();
  await h.feed(starshipAnalog());
  const r = await h.action("setDefault", { id: "route-50-4" });
  assert.equal(r.error, undefined);
  assert.deepEqual(h.runner.lines("pw-cli"), ["pw-cli set-param 50 Route { index: 4, device: 5, save: true }"]);
  assert.deepEqual(h.runner.lines("wpctl"), ["wpctl set-default 56"]);
  await h.end();
});

test("serve: Test L/R and record on a route with no node say to select it first; a stale key is an error", async () => {
  const h = setup();
  await tick();
  await h.feed(real());
  assert.match((await h.action("testOutput", { id: "route-50-3" })).error.message, /Line Out – .* isn't active: select it first/);
  assert.match((await h.action("recordTest", { id: "route-148-2" })).error.message, /Handsfree – JBL Tune Flex 2 isn't active/);
  assert.match((await h.action("setDefault", { id: "route-50-9" })).error.message, /can't be selected any more/);
  assert.deepEqual(h.runner.lines("wpctl"), []);
  await h.end();
});

// ---- CLI ----

async function cli(argv: string[], dumps: () => unknown) {
  const runner = new FakeRunner();
  runner.behave = (p) => {
    if (p.cmd === "pw-dump") p.stdout.write(JSON.stringify(dumps()));
    p.exit(0);
  };
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = "";
  let err = "";
  stdout.on("data", (c) => (out += c));
  stderr.on("data", (c) => (err += c));
  const code = await runCli(argv, { runner, stdout, stderr, ops: { testSounds: [] }, pollMs: 1, switchTimeoutMs: 2000 });
  return { code, out, err, runner };
}

test("cli: list shows the routes with no node after the nodes, with what selecting them does", async () => {
  const r = await cli(["list"], real);
  assert.equal(r.code, 0);
  assert.equal(
    r.out.split("Apps")[0],
    [
      "Outputs",
      "      33  GA102 High Definition Audio Controller Digital Stereo (HDMI 2)  (Acer X34 P)",
      "      42  HyperX QuadCast Digital Stereo (IEC958)",
      "  *   98  JBL Tune Flex 2  (A2DP: high fidelity)",
      "      56  Starship/Matisse HD Audio Controller Digital Stereo (IEC958)  (ALC1220 Digital)",
      "    route-148-3  Handsfree – JBL Tune Flex 2  (HFP: headset with mic)  [switches profile]",
      "    route-51-0  HDMI / DisplayPort – GA102 High Definition Audio Controller  [switches profile]",
      "    route-50-3  Line Out – Starship/Matisse HD Audio Controller  [switches profile]",
      "    route-52-2  Speakers – HyperX QuadCast  [switches profile]",
      "Inputs",
      "      41  C920 HD Pro Webcam Analog Stereo  (HD Pro Webcam C920)",
      "  *   40  HyperX QuadCast Analog Stereo",
      "      57  Starship/Matisse HD Audio Controller Analog Stereo  (ALC1220 Analog)",
      "    route-53-1  Digital Input (S/PDIF) – C920 HD Pro Webcam  [switches profile]",
      "    route-52-1  Digital Input (S/PDIF) – HyperX QuadCast  [switches profile]",
      "    route-148-2  Handsfree – JBL Tune Flex 2  (HFP: headset with mic)  [switches profile]",
      "",
    ].join("\n"),
  );
});

test("cli: set-default on a route switches the profile, polls pw-dump until the node is there, sets it", async () => {
  // ambiguous: Handsfree is an output and an input
  const r = await cli(["set-default", "handsfree"], real);
  assert.equal(r.code, 1);
  assert.match(r.err, /matches several devices/);
  assert.deepEqual(r.runner.lines("wpctl"), []);

  let switched = false;
  const runner = new FakeRunner();
  let polls = 0;
  runner.behave = (p) => {
    if (p.cmd === "wpctl" && p.args[0] === "set-profile") switched = true;
    if (p.cmd === "pw-dump") {
      polls++;
      p.stdout.write(JSON.stringify(switched && polls > 3 ? hfpDump() : real())); // the node takes a few polls
    }
    p.exit(0);
  };
  const out = new PassThrough();
  let text = "";
  out.on("data", (c) => (text += c));
  const code = await runCli(["set-default", "route-148-3"], { runner, stdout: out, stderr: new PassThrough(), pollMs: 1, switchTimeoutMs: 2000 });
  assert.equal(code, 0);
  assert.deepEqual(runner.lines("wpctl"), ["wpctl set-profile 148 261", "wpctl set-default 129"]);
  assert.ok(polls >= 4);
  assert.equal(text, "default output: Handsfree – JBL Tune Flex 2 (now 129, JBL Tune Flex 2)\n");
});

test("cli: a pw-dump taken mid-switch prints the dump and then updates; all of them are applied", async () => {
  const r = await cli(["list"], () => real());
  assert.match(r.out, / 98 {2}JBL/);
  const runner = new FakeRunner();
  runner.behave = (p) => {
    if (p.cmd === "pw-dump") p.stdout.write(JSON.stringify(real(), null, 2) + "\n" + JSON.stringify([{ id: 98, info: null }], null, 2) + "\n");
    p.exit(0);
  };
  const out = new PassThrough();
  let text = "";
  out.on("data", (c) => (text += c));
  assert.equal(await runCli(["list"], { runner, stdout: out, stderr: new PassThrough() }), 0);
  assert.doesNotMatch(text, / 98 {2}JBL/);
});
