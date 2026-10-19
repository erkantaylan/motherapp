// End to end: the real core starts the audio tool, which runs fake pw-dump/wpctl/pw-record
// binaries put first on PATH. Talks to the core over WebSocket like the browser does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { monitorBatches, waitFor } from "./fakes.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..", "..");

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
}

test("core + audio tool with fake PipeWire commands", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ma-audio-e2e-"));
  const bin = path.join(tmp, "bin");
  const pw = path.join(tmp, "pw");
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(pw, "queue"), { recursive: true });
  for (const name of ["pw-dump", "wpctl", "pw-play", "pw-record"]) {
    const script = `#!/bin/sh\nexec "${process.execPath}" --disable-warning=ExperimentalWarning "${path.join(here, "fake-pipewire.ts")}" ${name} "$@"\n`;
    fs.writeFileSync(path.join(bin, name), script, { mode: 0o755 });
  }
  const cfgDir = path.join(tmp, "config", "motherapp");
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, "config.json"), JSON.stringify({ port: 0, tools: {} }));
  const calls = () =>
    fs.existsSync(path.join(pw, "calls.log"))
      ? fs.readFileSync(path.join(pw, "calls.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { cmd: string; args?: string[]; signal?: string })
      : [];

  const core = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(repo, "core/src/main.ts")], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_PW_DIR: pw,
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
  // enabled by default, and the first dump arrives as fresh state
  await waitFor(() => c.notes("tools").some((p) => p.tools.find((x: any) => x.id === "audio")?.status === "running"), "audio running", 15_000);
  const info = c.notes("tools").at(-1).tools.find((x: any) => x.id === "audio");
  assert.equal(info.page, "declarative");
  assert.equal(info.title, "Audio");
  // The first dump lands either in the snapshot (if it beat the core's state.get) or as a delta.
  const firstDump = () =>
    c.notes("snapshot").some((s) => s.tool === "audio" && s.state.apps?.Firefox && (s.stale ?? []).length === 0) ||
    c.notes("state").some((s) => s.tool === "audio" && s.changes.some((x: any) => x.path === "apps" && !x.stale && x.value.Firefox));
  await waitFor(firstDump, "first dump", 10_000);
  assert.deepEqual(calls().filter((x) => x.cmd === "pw-dump").map((x) => x.args), [["--monitor"]]);

  // per-app volume goes to every Firefox stream through wpctl
  const r = await c.call("action", { tool: "audio", name: "setAppVolume", args: { app: "Firefox", value: 30 } });
  assert.equal(r.error, undefined);
  assert.deepEqual(
    calls().filter((x) => x.cmd === "wpctl").map((x) => x.args!.join(" ")).sort(), // the streams are set in parallel
    ["set-volume 101 0.30", "set-volume 102 0.30"],
  );
  await waitFor(() => c.notes("state").some((s) => s.changes.some((x: any) => x.path === "apps.Firefox.volume" && x.value === 30)), "volume delta");

  // a failing wpctl comes back as a failed action with its message
  const bad = await c.call("action", { tool: "audio", name: "setAppMute", args: { app: "mpv", value: true } });
  assert.equal(bad.error?.message, "wpctl set-mute failed: Object '115' not found");

  // a device plugged in shows up through pw-dump --monitor, and the default follows the metadata
  fs.writeFileSync(path.join(pw, "queue", "1.json"), JSON.stringify(monitorBatches()[2]));
  await waitFor(() => c.notes("state").some((s) => s.changes.some((x: any) => x.path === "sinks.71")), "headset delta via pw-dump --monitor");
  await waitFor(() => c.notes("state").some((s) => s.changes.some((x: any) => x.path === "defaultSink" && x.value === "71")), "default follows metadata");

  // mic meter: pw-record runs only while the stream is open
  await c.call("stream.open", { tool: "audio", name: "level/50" });
  await waitFor(() => c.notes("stream").length >= 3, "level values", 10_000);
  const level = c.notes("stream").at(-1);
  assert.equal(level.name, "level/50");
  assert.ok(level.value > 0.6 && level.value < 0.7);
  await c.call("stream.close", { tool: "audio", name: "level/50" });
  await waitFor(() => calls().some((x) => x.cmd === "pw-record" && x.signal === "SIGTERM"), "pw-record killed");

  // logs go through the core's log service
  assert.ok(lines.some((l) => l.tool === "audio" && l.src === "tool" && l.msg === "audio tool serving"));

  // shutting the core down doesn't leave pw-dump behind
  c.ws.close();
  core.kill("SIGTERM");
  await new Promise((res) => core.once("exit", res));
  await waitFor(() => calls().some((x) => x.cmd === "pw-dump" && x.signal === "SIGTERM"), "pw-dump stopped", 5000);
});
