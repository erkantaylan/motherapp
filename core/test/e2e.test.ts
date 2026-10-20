// End to end: start the real core with the demo tool, talk to it like the browser does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import type { LogEntry, RpcId } from "@motherapp/protocol";
import { fixturesDir, waitFor } from "./helpers.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function startCore(env: Record<string, string>) {
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(repo, "core/src/main.ts")], {
    env: { ...process.env, ...env },
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
