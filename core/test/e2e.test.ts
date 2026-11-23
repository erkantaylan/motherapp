// End to end: start the real core with the demo tool, talk to it like the browser does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import type { LogEntry, NotificationEntry, NotificationSettings, RpcId } from "@motherapp/protocol";
import { fixturesDir, waitFor } from "./helpers.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function startCore(env: Record<string, string>) {
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(repo, "core/src/main.ts")], {
    // MOTHERAPP_NOTIFY=off, MOTHERAPP_TRAY=off: a test core never puts a popup, a sound or a
    // tray icon on the real desktop
    env: { ...process.env, MOTHERAPP_NOTIFY: "off", MOTHERAPP_TRAY: "off", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines: Record<string, unknown>[] = [];
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (c: string) => {
    buf += c;
    const parts = buf.split("\n");
    buf = parts.pop()!;
    for (const p of parts) if (p) lines.push(JSON.parse(p));
  });
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c));
  const port = async () => {
    await waitFor(() => lines.some((l) => (l.fields as { port?: number } | undefined)?.port), "listening line");
    return (lines.find((l) => (l.fields as { port?: number } | undefined)?.port)!.fields as { port: number }).port;
  };
  return { child, lines, port, stderr: () => stderr };
}

class Client {
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
  async call(method: string, params: unknown): Promise<{ id: RpcId; result?: any; error?: any }> {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    await waitFor(() => this.msgs.some((m) => m.id === id), `reply to ${method}`);
    return this.msgs.find((m) => m.id === id) as { id: RpcId; result?: any; error?: any };
  }
  notes(method: string) {
    return this.msgs.filter((m) => m.method === method).map((m) => m.params);
  }
}

test("core + demo tool over WebSocket: cached state, action, delta, log entry", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ma-e2e-"));
  const cfgDir = path.join(tmp, "config", "motherapp");
  fs.mkdirSync(cfgDir, { recursive: true });
  // only the demo: the real tools would talk to the machine (and their snapshots raced the demo's)
  const tools = Object.fromEntries(fs.readdirSync(path.join(repo, "tools")).map((id) => [id, { enabled: id === "demo" }]));
  fs.writeFileSync(path.join(cfgDir, "config.json"), JSON.stringify({ port: 0, tools }));
  const webDir = path.join(tmp, "web");
  fs.mkdirSync(webDir);
  fs.writeFileSync(path.join(webDir, "index.html"), "<!doctype html><title>test</title>");

  const core = startCore({
    XDG_CONFIG_HOME: path.join(tmp, "config"),
    XDG_STATE_HOME: path.join(tmp, "state"),
    MOTHERAPP_TOOLS_DIR: path.join(repo, "tools"),
    MOTHERAPP_WEB_DIR: webDir,
  });
  t.after(() => {
    core.child.kill("SIGKILL");
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const port = await core.port();
  const base = `http://127.0.0.1:${port}`;

  // static frontend + SPA fallback; foreign Host header refused
  assert.equal((await fetch(`${base}/`)).status, 200);
  assert.match(await (await fetch(`${base}/some/route`)).text(), /<title>test/);
  assert.equal((await fetch(`${base}/missing.js`)).status, 404);

  const c = new Client(`ws://127.0.0.1:${port}/ws`);
  await c.open();
  // wait until the demo is running and its snapshot is cached
  await waitFor(() => c.notes("tools").some((p) => p.tools.find((x: any) => x.id === "demo")?.status === "running"), "demo running");
  const c2 = new Client(`ws://127.0.0.1:${port}/ws`);
  await c2.open();
  // a fresh client gets the cached state immediately, without asking the tool
  await waitFor(() => c2.notes("snapshot").some((s) => s.tool === "demo"), "snapshot on connect");
  const snap = c2.notes("snapshot").find((s) => s.tool === "demo");
  assert.equal(snap.state.count, 0);
  assert.deepEqual(snap.stale, ["level"]); // demo's "slow device" value starts stale
  const info = c2.notes("tools")[0].tools.find((x: any) => x.id === "demo");
  assert.equal(info.page, "declarative");
  assert.ok(Array.isArray(info.layout) && info.layout.length > 0);

  const logs = await c.call("logs.subscribe", { limit: 100 });
  assert.ok((logs.result.entries as LogEntry[]).some((e) => e.tool === "demo" && e.msg === "starting"));

  const r = await c.call("action", { tool: "demo", name: "increment" });
  assert.deepEqual(r.result, { count: 1 });
  await waitFor(() => c.notes("state").some((s) => s.tool === "demo" && s.changes.some((x: any) => x.path === "count" && x.value === 1)), "state delta");
  await waitFor(() => c.notes("log").some((l) => l.entry.tool === "demo" && l.entry.src === "tool" && l.entry.msg === "incremented"), "live log entry");

  // the stale value is refreshed by the tool (~1.5 s after start)
  await waitFor(() => c.notes("state").some((s) => s.changes.some((x: any) => x.path === "level" && !x.stale)), "level refreshed", 5000);

  // errors come back as JSON-RPC errors
  const bad = await c.call("action", { tool: "demo", name: "setMode", args: { value: "zzz" } });
  assert.equal(bad.error.code, -32602);
  const unknown = await c.call("action", { tool: "nope", name: "x" });
  assert.equal(unknown.error.code, -32003);

  // progress is forwarded with the browser's request id
  const slow = await c.call("action", { tool: "demo", name: "slow" });
  assert.equal(slow.result, "done");
  assert.ok(c.notes("progress").filter((p) => p.id === slow.id).length === 5);

  // a tool's notify: history and a live push for subscribers, with the core's view of the tool;
  // this core shows no popup and plays no sound (MOTHERAPP_NOTIFY=off)
  const before = await c.call("notifications.subscribe", {});
  assert.deepEqual(before.result, { entries: [] });
  const ns = (await c.call("notifications.settings.get", {})).result as NotificationSettings;
  assert.equal(ns.delivery, false);
  assert.equal(ns.muted, false);
  assert.deepEqual(ns.tools.find((x) => x.id === "demo"), {
    id: "demo", title: "Demo", icon: "🧪", enabled: true,
    kinds: [{ id: "hello", label: "Demo notification", enabled: true, sound: "message", defaultSound: "message" }],
  });
  assert.equal((await c.call("action", { tool: "demo", name: "notify" })).error, undefined);
  await waitFor(() => c.notes("notification").length === 1, "live notification");
  const entry = c.notes("notification")[0].entry as NotificationEntry;
  assert.deepEqual({ ...entry, ts: "" }, { seq: 1, ts: "", tool: "demo", toolTitle: "Demo", toolIcon: "🧪", kind: "hello", title: "Hello from the demo", body: "The counter is at 1." });
  assert.equal(c2.notes("notification").length, 0, "only subscribers get the push");
  assert.deepEqual((await c2.call("notifications.subscribe", { limit: 5 })).result.entries, [entry], "the backlog for a later page");
  // settings: saved in config.json, pushed to every client; a turned-off kind is dropped entirely
  const off = await c.call("notifications.setKind", { tool: "demo", kind: "hello", enabled: false });
  assert.equal((off.result as NotificationSettings).tools.find((x) => x.id === "demo")!.kinds[0]!.enabled, false);
  await waitFor(() => c2.notes("notifications.settings").length === 1, "settings pushed to the other client");
  const saved = JSON.parse(fs.readFileSync(path.join(cfgDir, "config.json"), "utf8"));
  assert.deepEqual(saved.notifications, { muted: false, tools: { demo: { kinds: { hello: { enabled: false } } } } });
  assert.equal(saved.port, 0, "other keys kept");
  await c.call("action", { tool: "demo", name: "notify" });
  assert.equal((await c.call("notifications.setKind", { tool: "demo", kind: "hello", enabled: true })).error, undefined);
  assert.equal((await c.call("notifications.subscribe", {})).result.entries.length, 1, "nothing recorded while the kind was off");
  assert.equal((await c.call("notifications.setKind", { tool: "demo", kind: "hello", sound: "../../etc/passwd" })).error.code, -32602);
  assert.equal((await c.call("notifications.setKind", { tool: "demo", kind: "nope", enabled: true })).error.code, -32602);
  assert.equal((await c.call("notifications.previewSound", { sound: "/usr/share/sounds/x.oga" })).error.code, -32602);
  await c.call("notifications.unsubscribe", {});

  // the tray icon: off for this core (MOTHERAPP_TRAY=off); the setting is still saved and pushed
  assert.deepEqual((await c.call("tray.get", {})).result, { enabled: true, available: false, state: "off" });
  assert.equal((await c.call("tray.setEnabled", { enabled: "no" })).error.code, -32602);
  assert.deepEqual((await c.call("tray.setEnabled", { enabled: false })).result, { enabled: false, available: false, state: "off" });
  await waitFor(() => c2.notes("tray").length === 1, "tray info pushed to the other client");
  assert.equal(JSON.parse(fs.readFileSync(path.join(cfgDir, "config.json"), "utf8")).tray, false);

  // streams only flow to subscribed clients
  await c.call("stream.open", { tool: "demo", name: "wave" });
  await waitFor(() => c.notes("stream").length >= 3, "stream values");
  assert.equal(c2.notes("stream").length, 0);
  await c.call("stream.close", { tool: "demo", name: "wave" });

  // the core's log goes to stdout as JSON lines and to log.jsonl
  assert.ok(core.lines.some((l) => l.tool === "demo" && l.msg === "incremented"));
  const file = path.join(tmp, "state", "motherapp", "log.jsonl");
  assert.ok(fs.readFileSync(file, "utf8").includes('"msg":"incremented"'));

  // manual restart: tool comes back with its persisted state
  await c.call("tool.restart", { tool: "demo" });
  await waitFor(() => c.notes("snapshot").filter((s) => s.tool === "demo").length >= 1 && c.notes("snapshot").at(-1).state.count === 1, "snapshot after restart");

  c.ws.close();
  c2.ws.close();
  core.child.kill("SIGTERM");
  await new Promise((r) => core.child.once("exit", r));
  assert.ok(core.lines.some((l) => l.msg === "shutting down (SIGTERM)"));
});

// #29. "mixed" is the unit's KillMode now (SIGTERM to the core only); "control-group" is
// systemd's default (SIGTERM to every process, then the core sends its tools another).
for (const mode of ["mixed", "control-group"] as const) {
  test(`stop with KillMode=${mode}: the core stops its tools, they exit 0 and save their state`, async (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ma-e2e-stop-"));
    const cfgDir = path.join(tmp, "config", "motherapp");
    fs.mkdirSync(cfgDir, { recursive: true });
    // only the demo: the real tools would talk to the machine's PipeWire, monitors, …
    const tools = Object.fromEntries(fs.readdirSync(path.join(repo, "tools")).map((id) => [id, { enabled: id === "demo" }]));
    fs.writeFileSync(path.join(cfgDir, "config.json"), JSON.stringify({ port: 0, tools }));
    const env = {
      ...process.env,
      XDG_CONFIG_HOME: path.join(tmp, "config"),
      XDG_STATE_HOME: path.join(tmp, "state"),
      MOTHERAPP_TOOLS_DIR: path.join(repo, "tools"),
      MOTHERAPP_WEB_DIR: path.join(tmp, "noweb"),
      MOTHERAPP_TRAY: "off",
    };
    // its own process group, so "control-group" can signal the core and its tools at once
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(repo, "core/src/main.ts")], { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    t.after(() => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // already gone
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    });
    const lines: Record<string, any>[] = [];
    let buf = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c: string) => {
      buf += c;
      const parts = buf.split("\n");
      buf = parts.pop()!;
      for (const p of parts) if (p) lines.push(JSON.parse(p));
    });
    await waitFor(() => lines.some((l) => l.fields?.port), "listening line");
    const c = new Client(`ws://127.0.0.1:${lines.find((l) => l.fields?.port)!.fields.port}/ws`);
    await c.open();
    await waitFor(() => c.notes("tools").some((p) => p.tools.find((x: any) => x.id === "demo")?.status === "running"), "demo running");
    for (let i = 0; i < 3; i++) assert.equal((await c.call("action", { tool: "demo", name: "increment" })).error, undefined);
    c.ws.close();

    const exited = new Promise<[number | null, NodeJS.Signals | null]>((r) => child.once("exit", (code, sig) => r([code, sig])));
    if (mode === "mixed") child.kill("SIGTERM");
    else process.kill(-child.pid!, "SIGTERM");
    assert.deepEqual(await exited, [0, null]);
    await new Promise((r) => setTimeout(r, 50)); // the last stdout lines
    const stopped = lines.filter((l) => l.tool === "demo" && /^stopped \(/.test(l.msg)).map((l) => l.msg);
    assert.deepEqual(stopped, ["stopped (exited with code 0)"]);
    const stateDir = path.join(tmp, "state", "motherapp");
    assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir, "demo.json"), "utf8")).state.count, 3);
    assert.deepEqual(fs.readdirSync(stateDir).filter((f) => f.endsWith(".tmp")), []);
  });
}

test("custom page modules are served type-stripped; foreign origins are refused", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ma-e2e-"));
  const core = startCore({
    XDG_CONFIG_HOME: path.join(tmp, "config"),
    XDG_STATE_HOME: path.join(tmp, "state"),
    MOTHERAPP_TOOLS_DIR: fixturesDir,
    MOTHERAPP_WEB_DIR: path.join(tmp, "noweb"),
    MOTHERAPP_PORT: "0",
  });
  t.after(() => {
    core.child.kill("SIGKILL");
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const port = await core.port();
  const res = await fetch(`http://127.0.0.1:${port}/tools/custom/page.ts`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /javascript/);
  const js = await res.text();
  assert.match(js, /export default class CustomPage extends HTMLElement/);
  assert.doesNotMatch(js, /import type|: number/);
  assert.equal((await fetch(`http://127.0.0.1:${port}/tools/custom/manifest.json`)).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${port}/tools/custom/..%2F..%2Fpackage.json`)).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 503); // frontend not built

  const evil = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: "https://evil.example" } });
  const outcome = await new Promise<string>((res) => {
    evil.once("open", () => res("open"));
    evil.once("error", () => res("refused"));
  });
  assert.equal(outcome, "refused");
  const ok = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: `http://localhost:${port}` } });
  await new Promise<void>((res, rej) => {
    ok.once("open", () => res());
    ok.once("error", rej);
  });
  ok.close();
});

// ---- tools outside the checkout (DESIGN.md § 4.8) ----

/**
 * A tool as another project would install it: a folder with manifest.json, page.ts and an icon,
 * and a serve command that is an absolute path to an executable elsewhere (no "node" in the
 * manifest, no SDK, not in the workspace). The executable is a script whose shebang is this
 * Node, so the test needs no other interpreter; the core runs it as it would a native binary.
 */
function writeExternalTool(extDir: string, binDir: string, id = "ext"): string {
  const bin = path.join(binDir, `fake-${id}`);
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    bin,
    `#!${process.execPath}
const rl = require("node:readline").createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
let n = 0;
rl.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  if (m.method === "describe") return send({ id: m.id, result: { id: ${JSON.stringify(id)}, title: "External (live)", page: "custom" } });
  if (m.method === "state.get") return send({ id: m.id, result: { state: { n } } });
  if (m.method === "action") {
    const name = m.params.name;
    if (name === "where") return send({ id: m.id, result: { cwd: process.cwd(), argv: process.argv.slice(2), toolId: process.env.MOTHERAPP_TOOL_ID } });
    if (name === "inc") { n++; send({ method: "state", params: { changes: [{ path: "n", value: n }] } }); return send({ id: m.id, result: n }); }
    if (name === "notify") { send({ method: "notify", params: { kind: "finished", title: "Run 7 finished" } }); return send({ id: m.id, result: null }); }
    if (name === "die") { send({ id: m.id, result: null }); return setTimeout(() => process.exit(3), 10); }
    return send({ id: m.id, error: { code: -32601, message: "unknown action " + name } });
  }
  send({ id: m.id, error: { code: -32601, message: "unknown method" } });
});
rl.on("close", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
`,
    { mode: 0o755 },
  );
  const dir = path.join(extDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      id,
      title: "External",
      icon: "icon.svg",
      serve: [bin, "motherapp", "serve"],
      page: "page.ts",
      order: 0,
      localActions: ["where"],
      notifications: [{ id: "finished", label: "A run finished", sound: "message" }, { id: "failed", label: "A run failed" }],
    }),
  );
  fs.writeFileSync(path.join(dir, "icon.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  fs.writeFileSync(path.join(dir, "page.ts"), 'import type { PageContext } from "@motherapp/protocol/page";\nexport default class ExtPage extends HTMLElement {\n  ctx?: PageContext;\n  n: number = 1;\n}\n');
  return dir;
}

test("an external tool (outside the checkout, serve is an absolute executable) works like a built-in one", async (t) => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ma-e2e-ext-")));
  const cfgDir = path.join(tmp, "config", "motherapp");
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, "config.json"), JSON.stringify({ port: 0, tools: { crash: { enabled: false } } }));
  const extDir = path.join(tmp, "external-tools");
  const toolDir = writeExternalTool(extDir, path.join(tmp, "bin"));
  // an external tool that takes a built-in tool's id: skipped, the built-in one stays
  fs.mkdirSync(path.join(extDir, "impostor"));
  fs.writeFileSync(path.join(extDir, "impostor", "manifest.json"), JSON.stringify({ id: "ok", title: "Impostor", serve: ["/bin/false"] }));

  const core = startCore({
    XDG_CONFIG_HOME: path.join(tmp, "config"),
    XDG_STATE_HOME: path.join(tmp, "state"),
    MOTHERAPP_TOOLS_DIR: fixturesDir,
    MOTHERAPP_EXTERNAL_TOOLS_DIR: extDir,
    MOTHERAPP_WEB_DIR: path.join(tmp, "noweb"),
  });
  t.after(() => {
    core.child.kill("SIGKILL");
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const port = await core.port();
  const base = `http://127.0.0.1:${port}`;
  const c = new Client(`ws://127.0.0.1:${port}/ws`);
  await c.open();
  const ext = () => c.notes("tools").at(-1)?.tools.find((x: any) => x.id === "ext");
  await waitFor(() => ext()?.status === "running", "ext running");

  // discovery: both folders, one error for the clash, the built-in "ok" kept
  const lines = core.lines as unknown as LogEntry[];
  const clashes = lines.filter((l) => l.level === "error" && /external tool id "ok" is taken by the built-in tool/.test(l.msg));
  assert.equal(clashes.length, 1);
  assert.equal((clashes[0]!.fields as { dir: string }).dir, path.join(extDir, "impostor"));
  const discovered = lines.find((l) => /^discovered /.test(l.msg))!;
  assert.deepEqual(discovered.fields, { dir: fixturesDir, tools: ["crash", "custom", "ok", "ext"], externalDir: extDir, external: ["ext"] });
  const list = c.notes("tools").at(-1).tools as any[];
  assert.equal(list.find((x) => x.id === "ok").title, "OK fixture");

  // identity, icon file and custom page, served from the tool's own folder
  assert.deepEqual(list.map((x) => x.id), ["ext", "crash", "custom", "ok"], "the manifest's order hint applies");
  assert.deepEqual({ ...ext(), status: "" }, { id: "ext", title: "External (live)", enabled: true, status: "", iconUrl: "/tools/ext/icon.svg", page: "custom", pageUrl: "/tools/ext/page.ts", onNetwork: true });
  const page = await fetch(`${base}/tools/ext/page.ts`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /javascript/);
  const js = await page.text();
  assert.match(js, /export default class ExtPage extends HTMLElement/);
  assert.doesNotMatch(js, /import type|: number/);
  const icon = await fetch(`${base}/tools/ext/icon.svg`);
  assert.equal(icon.status, 200);
  assert.match(icon.headers.get("content-type") ?? "", /svg/);
  assert.equal((await fetch(`${base}/tools/ext/manifest.json`)).status, 404);
  assert.equal((await fetch(`${base}/tools/ext/..%2Fimpostor%2Fmanifest.json`)).status, 404);

  // the process: the executable itself with the manifest's arguments, cwd the tool's folder
  const where = await c.call("action", { tool: "ext", name: "where" }); // a localAction, allowed from loopback
  assert.deepEqual(where.result, { cwd: toolDir, argv: ["motherapp", "serve"], toolId: "ext" });
  assert.ok(lines.some((l) => l.tool === "ext" && l.msg === "starting" && (l.fields as { cmd: string }).cmd === `${path.join(tmp, "bin", "fake-ext")} motherapp serve`));

  // state deltas
  assert.equal((await c.call("action", { tool: "ext", name: "inc" })).result, 1);
  await waitFor(() => c.notes("state").some((s) => s.tool === "ext" && s.changes[0].path === "n" && s.changes[0].value === 1), "ext delta");

  // notifications: kinds from the manifest, entries with the core's view of the tool
  const ns = (await c.call("notifications.settings.get", {})).result as NotificationSettings;
  assert.deepEqual(ns.tools.find((x) => x.id === "ext"), {
    id: "ext", title: "External (live)", iconUrl: "/tools/ext/icon.svg", enabled: true,
    kinds: [
      { id: "finished", label: "A run finished", enabled: true, sound: "message", defaultSound: "message" },
      { id: "failed", label: "A run failed", enabled: true, sound: "none", defaultSound: "none" },
    ],
  });
  await c.call("notifications.subscribe", {});
  await c.call("action", { tool: "ext", name: "notify" });
  await waitFor(() => c.notes("notification").length === 1, "ext notification");
  assert.deepEqual({ ...(c.notes("notification")[0].entry as NotificationEntry), ts: "" }, { seq: 1, ts: "", tool: "ext", toolTitle: "External (live)", toolIconUrl: "/tools/ext/icon.svg", kind: "finished", title: "Run 7 finished" });

  // order and enable/disable, saved in config.json like any tool's
  assert.equal((await c.call("tools.setOrder", { order: ["ok", "ext"] })).error, undefined);
  await waitFor(() => c.notes("tools").at(-1).tools[1].id === "ext", "ext second");
  assert.equal((await c.call("tool.setEnabled", { tool: "ext", enabled: false })).error, undefined);
  await waitFor(() => ext()?.status === "stopped" && ext()?.enabled === false, "ext stopped");
  const saved = JSON.parse(fs.readFileSync(path.join(cfgDir, "config.json"), "utf8"));
  assert.deepEqual(saved.tools.ext, { enabled: false });
  assert.deepEqual(saved.order.slice(0, 2), ["ok", "ext"]);
  assert.equal((await c.call("tool.setEnabled", { tool: "ext", enabled: true })).error, undefined);
  await waitFor(() => ext()?.status === "running", "ext running again");

  // a crash: down, then restarted by the core after the first backoff step (1 s)
  await c.call("action", { tool: "ext", name: "die" });
  await waitFor(() => c.notes("tools").some((p) => p.tools.find((x: any) => x.id === "ext")?.status === "down"), "ext down");
  assert.ok(lines.some((l) => l.tool === "ext" && /^crashed \(exited with code 3\); restarting in 1 s/.test(l.msg)));
  await waitFor(() => ext()?.status === "running", "ext restarted");
  assert.equal((await c.call("action", { tool: "ext", name: "inc" })).result, 1, "a fresh process");
  c.ws.close();
});

test("the default external folder is <config dir>/tools; a core under node --test doesn't read it", async (t) => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ma-e2e-ext-")));
  const cfgDir = path.join(tmp, "config", "motherapp");
  writeExternalTool(path.join(cfgDir, "tools"), path.join(tmp, "bin"));
  const env = {
    XDG_CONFIG_HOME: path.join(tmp, "config"),
    XDG_STATE_HOME: path.join(tmp, "state"),
    MOTHERAPP_TOOLS_DIR: path.join(tmp, "no-tools-here"),
    MOTHERAPP_WEB_DIR: path.join(tmp, "noweb"),
    MOTHERAPP_PORT: "0",
    MOTHERAPP_RELEASE_URL: "off",
  };
  const cores: ReturnType<typeof startCore>[] = [];
  t.after(() => {
    for (const core of cores) core.child.kill("SIGKILL");
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const ids = async (core: ReturnType<typeof startCore>) => {
    cores.push(core);
    const port = await core.port();
    return ((await (await fetch(`http://127.0.0.1:${port}/api/status`)).json()) as { tools: { id: string }[] }).tools.map((x) => x.id);
  };

  // as the tests start it (NODE_TEST_CONTEXT inherited): the folder is there but not read
  assert.ok(process.env.NODE_TEST_CONTEXT !== undefined, "run this file with node --test");
  assert.deepEqual(await ids(startCore(env)), []);
  // "off" and "" mean none even outside a test run; a named folder is read inside one
  const { NODE_TEST_CONTEXT: _ctx, ...outside } = process.env as Record<string, string>;
  const startOutside = (extra: Record<string, string>) => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(repo, "core/src/main.ts")], {
      env: { ...outside, MOTHERAPP_NOTIFY: "off", MOTHERAPP_TRAY: "off", ...env, ...extra },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buf = "";
    const lines: Record<string, unknown>[] = [];
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buf += chunk;
      const parts = buf.split("\n");
      buf = parts.pop()!;
      for (const p of parts) if (p) lines.push(JSON.parse(p));
    });
    const port = async () => {
      await waitFor(() => lines.some((l) => (l.fields as { port?: number } | undefined)?.port), "listening line");
      return (lines.find((l) => (l.fields as { port?: number } | undefined)?.port)!.fields as { port: number }).port;
    };
    return { child, lines, port, stderr: () => "" };
  };
  assert.deepEqual(await ids(startOutside({ MOTHERAPP_EXTERNAL_TOOLS_DIR: "off" })), []);
  assert.deepEqual(await ids(startOutside({ MOTHERAPP_EXTERNAL_TOOLS_DIR: "" })), []);
  // as the service runs it: <config dir>/tools, with no variable set
  assert.deepEqual(await ids(startOutside({})), ["ext"]);
});
