// End to end: the real core starts the brightness tool. With libddcutil made unloadable the tool
// falls back to a fake ddcutil first on PATH; brightctl then goes through the running core;
// a restart shows the cached values before the re-read. A second test runs the real
// libddcutil (when installed) and checks that its C stdout output never reaches the protocol.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { ACER_KEY, MACHINE_MONITORS, MSI_KEY, fakeDdcutil, waitFor } from "./fakes.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..", "..");
const brightctl = path.join(repo, "tools", "brightness", "brightctl.ts");
const libInstalled = ["/usr/lib/x86_64-linux-gnu/libddcutil.so.4", "/usr/lib/aarch64-linux-gnu/libddcutil.so.4"].some((f) => fs.existsSync(f));

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
  async call(method: string, params: unknown): Promise<{ result?: any; error?: any }> {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    await waitFor(() => this.msgs.some((m) => m.id === id), `reply to ${method}`, 15_000);
    return this.msgs.find((m) => m.id === id)!;
  }
  notes(method: string) {
    return this.msgs.filter((m) => m.method === method).map((m) => m.params);
  }
  changes(): { path: string; value: any; stale?: boolean }[] {
    return this.notes("state").filter((s) => s.tool === "brightness").flatMap((s) => s.changes);
  }
}

interface Core {
  proc: ChildProcess;
  port: number;
  lines: Record<string, any>[];
  stop(): Promise<void>;
}

async function startCore(env: NodeJS.ProcessEnv): Promise<Core> {
  const proc = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(repo, "core/src/main.ts")], { env, stdio: ["ignore", "pipe", "pipe"] });
  const lines: Record<string, any>[] = [];
  let buf = "";
  proc.stdout!.setEncoding("utf8");
  proc.stdout!.on("data", (c: string) => {
    buf += c;
    const parts = buf.split("\n");
    buf = parts.pop()!;
    for (const p of parts) if (p) lines.push(JSON.parse(p));
  });
  await waitFor(() => lines.some((l) => l.fields?.port), "core listening", 15_000);
  return {
    proc,
    port: lines.find((l) => l.fields?.port)!.fields.port as number,
    lines,
    stop: async () => {
      if (proc.exitCode !== null) return;
      proc.kill("SIGTERM");
      await new Promise((res) => proc.once("exit", res));
    },
  };
}

function baseEnv(tmp: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const cfgDir = path.join(tmp, "config", "motherapp");
  fs.mkdirSync(cfgDir, { recursive: true });
  // Only the brightness tool runs.
  const tools: Record<string, { enabled: boolean }> = {};
  for (const id of fs.readdirSync(path.join(repo, "tools"))) {
    if (fs.existsSync(path.join(repo, "tools", id, "manifest.json"))) tools[id] = { enabled: id === "brightness" };
  }
  fs.writeFileSync(path.join(cfgDir, "config.json"), JSON.stringify({ port: 0, tools }));
  return {
    ...process.env,
    XDG_CONFIG_HOME: path.join(tmp, "config"),
    XDG_STATE_HOME: path.join(tmp, "state"),
    MOTHERAPP_TOOLS_DIR: path.join(repo, "tools"),
    MOTHERAPP_WEB_DIR: path.join(tmp, "noweb"),
    ...extra,
  };
}

async function connect(core: Core): Promise<Client> {
  const c = new Client(`ws://127.0.0.1:${core.port}/ws`);
  await c.open();
  await waitFor(() => c.notes("tools").some((p) => p.tools.find((x: any) => x.id === "brightness")?.status === "running"), "brightness running", 15_000);
  return c;
}

test("core + brightness tool: fallback to a fake ddcutil, brightctl through the core, restart from cache", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ma-bright-e2e-"));
  const cores: Core[] = [];
  t.after(async () => {
    for (const c of cores) c.proc.kill("SIGKILL");
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const ddc = fakeDdcutil(tmp, MACHINE_MONITORS);
  const env = baseEnv(tmp, { PATH: `${ddc.bin}:${process.env.PATH}`, BRIGHTCTL_LIBDDCUTIL: "libddcutil-missing.so.4" });

  const core = await startCore(env);
  cores.push(core);
  const c = await connect(core);
  const info = c.notes("tools").at(-1).tools.find((x: any) => x.id === "brightness");
  assert.equal(info.title, "Brightness");
  assert.equal(info.page, "declarative");

  // The fallback is obvious on the page, and both monitors are read.
  await waitFor(() => c.changes().some((x) => x.path === "warning" && /libddcutil could not be loaded/.test(x.value)), "fallback warning", 10_000);
  await waitFor(() => c.changes().some((x) => x.path === `monitors.${ACER_KEY}.brightness` && x.value === 52 && !x.stale), "Acer read", 10_000);
  await waitFor(() => c.changes().some((x) => x.path === `monitors.${MSI_KEY}.brightness` && x.value === 48 && !x.stale), "MSI read", 10_000);
  assert.ok(core.lines.some((l) => l.tool === "brightness" && l.level === "warn" && /libddcutil could not be loaded/.test(l.msg)), "warning logged");

  // The linked slider sets both.
  const r = await c.call("action", { tool: "brightness", name: "setAll", args: { value: 70 } });
  assert.equal(r.error, undefined);
  assert.equal(ddc.value(1), 70);
  assert.equal(ddc.value(3), 70);

  // brightctl goes through the running core: no detection of its own, and the page sees it.
  const cliEnv = { ...env, MOTHERAPP_PORT: String(core.port) };
  const detectsBefore = ddc.calls().filter((x) => x.startsWith("detect")).length;
  const set = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", brightctl, "set", "all", "+10"], { env: cliEnv, encoding: "utf8", timeout: 20_000 });
  assert.equal(set.status, 0, set.stderr);
  assert.equal(set.stdout, "Acer X34 P: 80%\nMSI G274QPF: 80%\n");
  assert.equal(ddc.value(1), 80);
  assert.equal(ddc.calls().filter((x) => x.startsWith("detect")).length, detectsBefore);
  await waitFor(() => c.changes().some((x) => x.path === `monitors.${MSI_KEY}.brightness` && x.value === 80 && !x.stale), "CLI change reaches the page");
  const list = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", brightctl, "list"], { env: cliEnv, encoding: "utf8", timeout: 20_000 });
  assert.equal(list.status, 0, list.stderr);
  assert.equal(list.stdout, "Acer X34 P   DP-2   80%\nMSI G274QPF  DP-1   80%\n");
  // Nobody watches the page here, so nothing re-reads in the background; `list` reads itself:
  // a change made on the monitor's own buttons shows up at once.
  ddc.patch(3, { value: 33 });
  const fresh = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", brightctl, "list"], { env: cliEnv, encoding: "utf8", timeout: 20_000 });
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.equal(fresh.stdout, "Acer X34 P   DP-2   33%\nMSI G274QPF  DP-1   80%\n");
  const one = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", brightctl, "get", "DP-2"], { env: cliEnv, encoding: "utf8", timeout: 20_000 });
  assert.equal(one.stdout, "33\n", one.stderr);

  // A monitor that is switched off: the action fails with a message for the dot.
  ddc.patch(3, { off: true });
  const off = await c.call("action", { tool: "brightness", name: "setBrightness", args: { id: ACER_KEY, value: 10 } });
  assert.match(off.error?.message, /^Acer X34 P: no answer over DDC\/CI, is it switched on\?/);
  ddc.patch(3, { off: false });

  // Restart with slow monitors: the page gets the cached values at once, stale, then fresh.
  c.ws.close();
  await core.stop();
  const slowEnv = { ...env, FAKE_DDC_DELAY_MS: "1500" };
  const core2 = await startCore(slowEnv);
  cores.push(core2);
  const c2 = await connect(core2);
  await waitFor(() => c2.notes("snapshot").some((s) => s.tool === "brightness"), "snapshot", 10_000);
  const snap = c2.notes("snapshot").find((s) => s.tool === "brightness");
  assert.equal(snap.state.monitors[MSI_KEY].brightness, 80);
  assert.equal(snap.state.monitors[ACER_KEY].title, "Acer X34 P");
  assert.ok(snap.stale.includes(`monitors.${MSI_KEY}.brightness`), "cached value is marked stale");
  await waitFor(() => c2.changes().some((x) => x.path === `monitors.${MSI_KEY}.brightness` && x.value === 80 && !x.stale), "re-read confirms it", 15_000);
  c2.ws.close();
  await core2.stop();
});

test("real libddcutil in serve mode: its stdout chatter goes to the log, never into the protocol", { skip: !libInstalled && "libddcutil4 is not installed" }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ma-bright-e2e-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const core = await startCore(baseEnv(tmp));
  t.after(() => core.proc.kill("SIGKILL"));
  const c = await connect(core);
  await waitFor(() => c.changes().some((x) => x.path === "backend" && /libddcutil 1\.4/.test(x.value)), "libddcutil backend", 10_000);
  // With or without monitors attached: either the "none found" status or at least one monitor row.
  await waitFor(() => c.changes().some((x) => (x.path === "status" && /No monitors with DDC\/CI found/.test(x.value)) || x.path.startsWith("monitors.")), "detection finished", 15_000);
  assert.ok(!core.lines.some((l) => /ignoring tool output/.test(l.msg)), "no stray lines on the JSON-RPC channel");
  assert.ok(!core.lines.some((l) => l.tool === "brightness" && l.src === "core" && /crash|exit/i.test(l.msg)), "no crash");
  c.ws.close();
  await core.stop();
});
