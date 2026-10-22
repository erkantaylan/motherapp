// End to end: the real core starts the CPU tool, which reads a fixture tree
// (MOTHERAPP_CPU_ROOT), never the real /sys. Talks to the core over WebSocket like the browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { setFreq, tempTree } from "./fixtures.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..", "..");

async function waitFor(pred: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
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
  async call(method: string, params: unknown): Promise<{ result?: any; error?: any }> {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    await waitFor(() => this.msgs.some((m) => m.id === id), `reply to ${method}`, 10_000);
    return this.msgs.find((m) => m.id === id)!;
  }
  notes(method: string) {
    return this.msgs.filter((m) => m.method === method).map((m) => m.params);
  }
  /** The cpu tool's state changes (snapshot excluded). */
  changes(): { path: string; value: any; stale?: boolean }[] {
    return this.notes("state").filter((p) => p.tool === "cpu").flatMap((p) => p.changes);
  }
}

test("core + cpu tool on a fixture tree: stale until watched, live deltas while watched, cpu.json created", async (t) => {
  const tree = tempTree();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ma-cpu-e2e-"));
  const cfgDir = path.join(tmp, "config", "motherapp");
  fs.mkdirSync(cfgDir, { recursive: true });
  // only the cpu tool, so the test doesn't depend on the others
  const others = fs.readdirSync(path.join(repo, "tools")).filter((d) => d !== "cpu" && fs.existsSync(path.join(repo, "tools", d, "manifest.json")));
  fs.writeFileSync(path.join(cfgDir, "config.json"), JSON.stringify({ port: 0, tools: Object.fromEntries(others.map((id) => [id, { enabled: false }])) }));

  const core = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(repo, "core/src/main.ts")], {
    env: {
      ...process.env,
      MOTHERAPP_CPU_ROOT: tree.root,
      XDG_CONFIG_HOME: path.join(tmp, "config"),
      XDG_STATE_HOME: path.join(tmp, "state"),
      MOTHERAPP_TOOLS_DIR: path.join(repo, "tools"),
      MOTHERAPP_WEB_DIR: path.join(tmp, "noweb"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => {
    core.kill("SIGKILL");
    fs.rmSync(tmp, { recursive: true, force: true });
    tree.cleanup();
  });
  const lines: Record<string, any>[] = [];
  let buf = "";
  core.stdout.setEncoding("utf8");
  core.stdout.on("data", (c: string) => {
    buf += c;
    const parts = buf.split("\n");
    buf = parts.pop()!;
    for (const p of parts) if (p) lines.push(JSON.parse(p));
  });
  await waitFor(() => lines.some((l) => l.fields?.port), "core listening", 10_000);
  const port = lines.find((l) => l.fields?.port)!.fields.port as number;

  const c = new Client(`ws://127.0.0.1:${port}/ws`);
  await c.open();
  await waitFor(() => c.notes("tools").some((p) => p.tools.find((x: any) => x.id === "cpu")?.status === "running"), "cpu running", 15_000);
  const info = c.notes("tools").at(-1).tools.find((x: any) => x.id === "cpu");
  assert.equal(info.page, "declarative");
  assert.equal(info.title, "CPU");

  // Before anyone watches: the shape is there (one read at start), polled values stale.
  await waitFor(() => c.notes("snapshot").some((s) => s.tool === "cpu" && s.state.cpu?.model), "snapshot", 5000);
  const snap = c.notes("snapshot").filter((s) => s.tool === "cpu").at(-1);
  assert.equal(snap.state.cpu.model, "AMD Ryzen 9 3900X 12-Core Processor");
  assert.deepEqual(Object.keys(snap.state.ccx), ["0", "1", "2", "3"]);
  for (const k of ["cpu", "ccx", "cores", "sensors"]) assert.ok(snap.stale.includes(k), `${k} stale before watching`);
  assert.equal(snap.state.profiles.overclock.value, "1.250 V");
  assert.equal(snap.state.profiles.underclock.detail, "values not set yet");
  const cfg = JSON.parse(fs.readFileSync(path.join(cfgDir, "cpu.json"), "utf8"));
  assert.deepEqual(cfg.profiles.overclock.ccx, [4250, 4250, 4125, 4100]);
  assert.equal(cfg.active, null);
  assert.equal(cfg.applyOnStart, true);

  // The tab shows the page: fresh at once, then a changed frequency arrives as a small delta.
  assert.equal((await c.call("tool.watch", { tool: "cpu" })).error, undefined);
  await waitFor(() => c.changes().some((x) => x.path === "ccx" && !x.stale), "fresh ccx", 5000);
  setFreq(tree.root, 4, 4_455_000);
  await waitFor(() => c.changes().some((x) => x.path === "cores.4.value" && x.value === "4455 MHz"), "frequency delta", 5000);
  assert.ok(!c.changes().some((x) => x.path === "cores.0.value"), "unchanged cores aren't resent");
  assert.ok(lines.some((l) => l.tool === "cpu" && l.src === "tool" && l.msg === "cpu tool serving"));
  c.ws.close();
});
