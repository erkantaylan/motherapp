// Tool order (issue #20): the merge rules, saving into config.json, and the broadcast.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WebSocket } from "ws";
import { loadConfig, updateConfigFile } from "../src/config.ts";
import { LogService } from "../src/logService.ts";
import { Manager } from "../src/manager.ts";
import { validateManifest } from "../src/manifest.ts";
import { startServer } from "../src/server.ts";
import { defaultOrder, mergeOrder, orderToSave } from "../src/toolOrder.ts";
import { waitFor } from "./helpers.ts";

const tools = [{ id: "tmux" }, { id: "audio" }, { id: "brightness" }, { id: "inbox" }];

test("mergeOrder: no saved order (missing or empty) is alphabetical", () => {
  assert.deepEqual(mergeOrder(tools, undefined), ["audio", "brightness", "inbox", "tmux"]);
  assert.deepEqual(mergeOrder(tools, []), ["audio", "brightness", "inbox", "tmux"]);
});

test("mergeOrder: the saved order comes first; new tools go at the end, alphabetically", () => {
  assert.deepEqual(mergeOrder(tools, ["tmux", "brightness", "audio", "inbox"]), ["tmux", "brightness", "audio", "inbox"]);
  // inbox and audio weren't there when the order was saved: appended, a before i, rest untouched
  assert.deepEqual(mergeOrder(tools, ["tmux", "brightness"]), ["tmux", "brightness", "audio", "inbox"]);
  // a new tool that sorts first alphabetically still goes last
  assert.deepEqual(mergeOrder([...tools, { id: "aaa" }], ["tmux", "brightness", "audio", "inbox"]), ["tmux", "brightness", "audio", "inbox", "aaa"]);
});

test("mergeOrder: unknown ids (a deleted tool folder) and duplicates are skipped", () => {
  assert.deepEqual(mergeOrder(tools, ["gone", "inbox", "inbox", "audio", "old"]), ["inbox", "audio", "brightness", "tmux"]);
  // only unknown ids: everything is "new", so alphabetical
  assert.deepEqual(mergeOrder(tools, ["gone"]), ["audio", "brightness", "inbox", "tmux"]);
});

test("manifest order hints set the default only, until the user saves an order", () => {
  const hinted = [{ id: "zed", order: 1 }, { id: "audio" }, { id: "mid", order: 5 }, { id: "beta", order: 5 }];
  assert.deepEqual(defaultOrder(hinted), ["zed", "beta", "mid", "audio"]);
  assert.deepEqual(mergeOrder(hinted, []), ["zed", "beta", "mid", "audio"]);
  // a saved order wins; tools it doesn't name are appended alphabetically (hints ignored)
  assert.deepEqual(mergeOrder(hinted, ["audio"]), ["audio", "beta", "mid", "zed"]);
  assert.deepEqual(validateManifest({ id: "a", title: "A", serve: ["x"], order: 2 }), { id: "a", title: "A", serve: ["x"], order: 2 });
  assert.equal(typeof validateManifest({ id: "a", title: "A", serve: ["x"], order: "1" }), "string");
});

test("orderToSave: drops unknown ids, keeps tools the request left out, rejects junk", () => {
  const current = ["audio", "brightness", "inbox", "tmux"];
  assert.deepEqual(orderToSave(["tmux", "gone", "audio", "tmux"], current), ["tmux", "audio", "brightness", "inbox"]);
  assert.deepEqual(orderToSave([], current), current);
  assert.throws(() => orderToSave("audio", current), TypeError);
  assert.throws(() => orderToSave(["audio", 3], current), TypeError);
});

test("config: order is read leniently; a corrupt order is ignored and the rest still applies", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ma-order-cfg-"));
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, JSON.stringify({ port: 9000, tools: { demo: { enabled: false } }, order: ["b", 3, "a", "b", ""] }));
  assert.deepEqual(loadConfig(file).config, { port: 9000, tools: { demo: { enabled: false } }, order: ["b", "a"], lan: { enabled: false, trusted: [] }, localhostSubdomains: true });
  fs.writeFileSync(file, JSON.stringify({ port: 9000, tools: { demo: { enabled: false } }, order: "audio" }));
  assert.deepEqual(loadConfig(file).config, { port: 9000, tools: { demo: { enabled: false } }, lan: { enabled: false, trusted: [] }, localhostSubdomains: true });
  fs.rmSync(dir, { recursive: true });
});

test("updateConfigFile: keeps every other key, writes atomically, never overwrites broken JSON", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ma-order-upd-"));
  const file = path.join(dir, "config.json");
  const before = { port: 7323, tools: { demo: { enabled: false, note: "mine" } }, network: { lan: false }, extra: [1, 2] };
  fs.writeFileSync(file, JSON.stringify(before));
  updateConfigFile(file, (raw) => {
    raw.order = ["audio", "brightness"];
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { ...before, order: ["audio", "brightness"] });
  assert.deepEqual(fs.readdirSync(dir), ["config.json"], "no temp file left behind");

  // a missing file starts empty
  const fresh = path.join(dir, "sub", "new.json");
  updateConfigFile(fresh, (raw) => {
    raw.order = ["x"];
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(fresh, "utf8")), { order: ["x"] });

  for (const broken of ["{broken", "[1,2]", "null"]) {
    fs.writeFileSync(file, broken);
    assert.throws(() => updateConfigFile(file, (raw) => void (raw.order = [])), /fix or delete it/);
    assert.equal(fs.readFileSync(file, "utf8"), broken, "broken file left as it was");
  }
  fs.rmSync(dir, { recursive: true });
});

/** A tools dir with disabled tools (nothing is spawned) and a config.json next to it. */
function setup(t: { after(fn: () => void): void }, ids: string[], config: unknown) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ma-order-"));
  const toolsDir = path.join(tmp, "tools");
  for (const id of ids) {
    fs.mkdirSync(path.join(toolsDir, id), { recursive: true });
    const m: Record<string, unknown> = { id, title: id[0]!.toUpperCase() + id.slice(1), serve: ["node", "x.ts"], defaultEnabled: false };
    if (id === "zaudio") m.order = 1;
    fs.writeFileSync(path.join(toolsDir, id, "manifest.json"), JSON.stringify(m));
  }
  const configFile = path.join(tmp, "config.json");
  if (config !== undefined) fs.writeFileSync(configFile, typeof config === "string" ? config : JSON.stringify(config));
  const log = new LogService({ stdout: null });
  const manager = new Manager({ toolsDir, configFile, log });
  manager.init();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  return { manager, configFile, toolsDir, log };
}

test("manager: lists in the saved order, saves it with other keys kept, resets to the hints", async (t) => {
  const { manager, configFile } = setup(t, ["brightness", "inbox", "tmux", "zaudio"], { port: 0, tools: { tmux: { enabled: true } }, order: ["tmux", "gone", "inbox"], mine: { keep: true } });
  // saved first (unknown "gone" skipped), then the rest alphabetically (hints don't apply)
  assert.deepEqual(manager.list().map((i) => i.id), ["tmux", "inbox", "brightness", "zaudio"]);
  assert.equal(manager.orderSaved, true);

  manager.setOrder(["zaudio", "gone", "brightness"]);
  assert.deepEqual(manager.list().map((i) => i.id), ["zaudio", "brightness", "tmux", "inbox"]);
  const saved = JSON.parse(fs.readFileSync(configFile, "utf8"));
  assert.deepEqual(saved, { port: 0, tools: { tmux: { enabled: true } }, order: ["zaudio", "brightness", "tmux", "inbox"], mine: { keep: true } });

  // enabling keeps the order and the unknown key too
  await manager.setEnabled("tmux", false);
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile, "utf8")).order, ["zaudio", "brightness", "tmux", "inbox"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile, "utf8")).mine, { keep: true });
  // disabled tools keep their place
  assert.deepEqual(manager.list().map((i) => i.id), ["zaudio", "brightness", "tmux", "inbox"]);

  manager.resetOrder();
  assert.equal(manager.orderSaved, false);
  assert.deepEqual(manager.list().map((i) => i.id), ["zaudio", "brightness", "inbox", "tmux"]); // hint first
  assert.equal("order" in JSON.parse(fs.readFileSync(configFile, "utf8")), false);
  assert.throws(() => manager.setOrder("nope"), /order must be an array/);
});

test("manager: a new tool folder is appended; a corrupt config is never overwritten", (t) => {
  const { manager } = setup(t, ["aaa", "brightness", "tmux"], { port: 0, tools: {}, order: ["tmux", "brightness"] });
  assert.deepEqual(manager.list().map((i) => i.id), ["tmux", "brightness", "aaa"]);

  const broken = setup(t, ["brightness", "tmux"], "{ not json");
  assert.deepEqual(broken.manager.list().map((i) => i.id), ["brightness", "tmux"]);
  assert.throws(() => broken.manager.setOrder(["tmux"]), /Not saved: .*not valid JSON/);
  assert.equal(fs.readFileSync(broken.configFile, "utf8"), "{ not json");
  assert.deepEqual(broken.manager.list().map((i) => i.id), ["brightness", "tmux"], "nothing changed in memory either");
});

class WsClient {
  ws: WebSocket;
  msgs: Record<string, any>[] = [];
  private id = 0;
  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on("message", (d) => this.msgs.push(JSON.parse(d.toString())));
  }
  open() {
    return new Promise<void>((res, rej) => {
      this.ws.once("open", () => res());
      this.ws.once("error", rej);
    });
  }
  async call(method: string, params: unknown) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    await waitFor(() => this.msgs.some((m) => m.id === id), `reply to ${method}`);
    return this.msgs.find((m) => m.id === id) as { result?: unknown; error?: { code: number; message: string } };
  }
  lastTools() {
    return this.msgs.filter((m) => m.method === "tools").at(-1)?.params as { tools: { id: string }[]; orderSaved: boolean } | undefined;
  }
}

test("server: tools.setOrder / tools.resetOrder reach every connected client", async (t) => {
  const { manager, log, configFile } = setup(t, ["brightness", "inbox", "tmux"], { port: 0, tools: {} });
  const server = await startServer({ manager, log, webDir: path.join(os.tmpdir(), "ma-no-web"), port: 0 });
  t.after(() => server.close());
  const url = `ws://127.0.0.1:${server.port}/ws`;
  const a = new WsClient(url);
  const b = new WsClient(url);
  await Promise.all([a.open(), b.open()]);
  await waitFor(() => a.lastTools() !== undefined && b.lastTools() !== undefined, "initial tools");
  assert.deepEqual(b.lastTools()!.tools.map((x) => x.id), ["brightness", "inbox", "tmux"]);
  assert.equal(b.lastTools()!.orderSaved, false);

  const r = await a.call("tools.setOrder", { order: ["tmux", "brightness", "inbox"] });
  assert.equal(r.result, null);
  for (const c of [a, b]) {
    await waitFor(() => c.lastTools()?.tools.map((x) => x.id).join() === "tmux,brightness,inbox", "new order on every client");
    assert.equal(c.lastTools()!.orderSaved, true);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile, "utf8")).order, ["tmux", "brightness", "inbox"]);

  // a client that connects later gets the saved order straight away
  const late = new WsClient(url);
  await late.open();
  await waitFor(() => late.lastTools() !== undefined, "tools on connect");
  assert.deepEqual(late.lastTools()!.tools.map((x) => x.id), ["tmux", "brightness", "inbox"]);

  const bad = await b.call("tools.setOrder", { order: "tmux" });
  assert.equal(bad.error?.code, -32602);

  await b.call("tools.resetOrder", {});
  for (const c of [a, b, late]) {
    await waitFor(() => c.lastTools()?.orderSaved === false, "reset on every client");
    assert.deepEqual(c.lastTools()!.tools.map((x) => x.id), ["brightness", "inbox", "tmux"]);
  }
  for (const c of [a, b, late]) c.ws.close();
});
