// The tray icon's core side with a fake helper process: nothing here starts Python or touches
// the real tray.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import type { ToolInfo, TrayInfo } from "@motherapp/protocol";
import { loadConfig } from "../src/config.ts";
import { LogService } from "../src/logService.ts";
import { Manager } from "../src/manager.ts";
import { ToolHealth, Tray, openArgv, parseShowEnvironment, sessionEnv, trayAllowed } from "../src/tray.ts";
import type { TrayView } from "../src/tray.ts";
import { FakeClock, fixturesDir, waitFor } from "./helpers.ts";

class FakeHelper extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  received: unknown[] = [];
  signals: string[] = [];
  stdinEnded = false;
  cmd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  constructor(cmd: string, args: string[], env: NodeJS.ProcessEnv) {
    super();
    this.cmd = cmd;
    this.args = args;
    this.env = env;
    let buf = "";
    this.stdin.on("data", (c: Buffer) => {
      buf += c.toString();
      const parts = buf.split("\n");
      buf = parts.pop()!;
      for (const p of parts) this.received.push(JSON.parse(p));
    });
    this.stdin.on("end", () => (this.stdinEnded = true));
  }
  say(obj: unknown): void {
    this.stdout.write(JSON.stringify(obj) + "\n");
  }
  kill(signal: string): boolean {
    this.signals.push(signal);
    return true;
  }
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit("exit", code, signal);
  }
}

const tick = () => new Promise((r) => setTimeout(r, 5));

function setup(over: { allowed?: boolean; enabled?: boolean; failSpawn?: () => Error | undefined } = {}) {
  const helpers: FakeHelper[] = [];
  const logs: string[] = [];
  const clock = new FakeClock();
  const s = {
    enabled: over.enabled ?? true,
    view: { icon: "ok", status: "2 tools running", muted: false } as TrayView,
    opened: 0,
    muteCalls: [] as boolean[],
    muteFails: false,
    saveFails: false,
  };
  const infos: TrayInfo[] = [];
  const tray = new Tray({
    allowed: over.allowed ?? true,
    store: {
      get: () => s.enabled,
      save: (e) => {
        if (s.saveFails) throw new Error("disk full");
        s.enabled = e;
      },
    },
    command: ["python3", "/repo/core/tray/motherapp-tray.py", "/ok.png", "/warn.png"],
    view: () => s.view,
    onOpen: () => void s.opened++,
    onMute: (m) => {
      if (s.muteFails) throw new Error("Not saved");
      s.muteCalls.push(m);
      s.view = { ...s.view, muted: m };
    },
    log: (level, msg) => logs.push(`${level}: ${msg}`),
    spawn: (cmd, args, opts) => {
      const err = over.failSpawn?.();
      const h = new FakeHelper(cmd, args, opts.env);
      helpers.push(h);
      if (err) setImmediate(() => h.emit("error", err));
      return h as unknown as ChildProcess;
    },
    env: async () => ({ WAYLAND_DISPLAY: "wayland-9" }),
    clock,
    killGraceMs: 20,
  });
  tray.onChange((i) => infos.push(i));
  const warnings = () => logs.filter((l) => l.startsWith("warn"));
  return { tray, helpers, logs, warnings, clock, s, infos };
}

test("trayAllowed: off by MOTHERAPP_TRAY=off and under node --test, unless it says on", () => {
  assert.equal(trayAllowed({}), true);
  assert.equal(trayAllowed({ MOTHERAPP_TRAY: "off" }), false);
  assert.equal(trayAllowed({ MOTHERAPP_TRAY: "0" }), false);
  assert.equal(trayAllowed({ NODE_TEST_CONTEXT: "child-v8" }), false);
  assert.equal(trayAllowed({ NODE_TEST_CONTEXT: "child-v8", MOTHERAPP_TRAY: "on" }), true);
  assert.equal(trayAllowed(), false, "this test process is under node --test");
});

test("ToolHealth: counts running tools; a crashed tool is a warning until it runs again", () => {
  const tool = (id: string, status: ToolInfo["status"], enabled = true): ToolInfo => ({ id, title: id === "tmux" ? "tmux" : `Tool ${id}`, enabled, status });
  const h = new ToolHealth();
  assert.deepEqual(h.update([]), { icon: "ok", status: "No tools enabled" });
  assert.deepEqual(h.update([tool("a", "starting"), tool("tmux", "starting")]), { icon: "ok", status: "Starting…" });
  assert.deepEqual(h.update([tool("a", "running"), tool("tmux", "starting"), tool("off", "stopped", false)]), { icon: "ok", status: "1 tool running" });
  assert.deepEqual(h.update([tool("a", "running"), tool("tmux", "running")]), { icon: "ok", status: "2 tools running" });
  assert.deepEqual(h.update([tool("a", "running"), tool("tmux", "down")]), { icon: "warn", status: "tmux has crashed" });
  assert.deepEqual(h.update([tool("a", "running"), tool("tmux", "starting")]), { icon: "warn", status: "tmux has crashed" }, "no blinking while the core retries it");
  assert.deepEqual(h.update([tool("a", "running"), tool("tmux", "failed")]), { icon: "warn", status: "tmux keeps crashing" });
  assert.deepEqual(h.update([tool("a", "down"), tool("tmux", "failed")]), { icon: "warn", status: "2 tools have crashed" });
  assert.deepEqual(h.update([tool("a", "running"), tool("tmux", "failed", false)]), { icon: "ok", status: "1 tool running" }, "a disabled tool is nobody's problem");
  assert.deepEqual(h.update([tool("a", "running"), tool("tmux", "starting")]), { icon: "ok", status: "1 tool running" }, "re-enabled: a fresh start");
  const long = h.update([{ id: "x", title: "x".repeat(100), enabled: true, status: "down" }]).status;
  assert.equal(long, `${"x".repeat(39)}… has crashed`);
});

test("sessionEnv: fills in the display from the user manager only when the core has none", async () => {
  const shown = "PATH=/usr/bin\nWAYLAND_DISPLAY=wayland-0\nDISPLAY=:0\nXDG_CURRENT_DESKTOP=ubuntu:GNOME\nODD=$'a\\nb'\nXAUTHORITY=$'/run/x y'\nnoequals\n";
  assert.deepEqual(parseShowEnvironment(shown), { PATH: "/usr/bin", WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0", XDG_CURRENT_DESKTOP: "ubuntu:GNOME" });
  const own = { WAYLAND_DISPLAY: "wayland-1", PATH: "/bin" };
  assert.equal(await sessionEnv(own, async () => assert.fail("not asked")), own);
  assert.deepEqual(await sessionEnv({ PATH: "/bin", XDG_RUNTIME_DIR: "/run/user/1" }, async () => shown), {
    PATH: "/bin", XDG_RUNTIME_DIR: "/run/user/1", WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0", XDG_CURRENT_DESKTOP: "ubuntu:GNOME",
  });
  const bare = { PATH: "/bin" };
  assert.equal(await sessionEnv(bare, async () => Promise.reject(new Error("no systemctl"))), bare);
});

test("openArgv: xdg-open, in a scope of its own under the systemd unit", () => {
  assert.deepEqual(openArgv("http://127.0.0.1:7323/", {}), ["xdg-open", "http://127.0.0.1:7323/"]);
  assert.deepEqual(openArgv("http://127.0.0.1:7323/", { INVOCATION_ID: "abc" }), ["systemd-run", "--user", "--scope", "--collect", "--quiet", "--", "xdg-open", "http://127.0.0.1:7323/"]);
});

test("start: spawns the helper with the session environment and sends the view once it is ready", async () => {
  const t = setup();
  assert.deepEqual(t.tray.info(), { enabled: true, available: true, state: "off" });
  t.tray.start();
  assert.equal(t.tray.info().state, "starting");
  await tick();
  assert.equal(t.helpers.length, 1);
  const h = t.helpers[0]!;
  assert.deepEqual([h.cmd, ...h.args], ["python3", "/repo/core/tray/motherapp-tray.py", "/ok.png", "/warn.png"]);
  assert.deepEqual(h.env, { WAYLAND_DISPLAY: "wayland-9" });
  t.tray.refresh();
  await tick();
  assert.deepEqual(h.received, [], "nothing before the helper says ready");
  h.say({ event: "ready" });
  await waitFor(() => h.received.length === 1, "first view");
  assert.deepEqual(h.received, [{ icon: "ok", status: "2 tools running", muted: false }]);
  assert.deepEqual(t.tray.info(), { enabled: true, available: true, state: "running" });
  assert.deepEqual(t.infos.map((i) => i.state), ["starting", "running"]);

  t.tray.refresh();
  t.tray.refresh();
  await tick();
  assert.equal(h.received.length, 1, "an unchanged view isn't sent again");
  t.s.view = { icon: "warn", status: "tmux has crashed", muted: false };
  t.tray.refresh();
  await waitFor(() => h.received.length === 2, "changed view");
  assert.deepEqual(h.received[1], { icon: "warn", status: "tmux has crashed", muted: false });
  assert.deepEqual(t.warnings(), []);
});

test("menu events: open; mute goes to the core and the tick is re-synced, also when saving fails", async () => {
  const t = setup();
  t.tray.start();
  await tick();
  const h = t.helpers[0]!;
  h.say({ event: "ready" });
  await waitFor(() => h.received.length === 1, "first view");
  h.say({ event: "open" });
  h.say({ event: "mute", muted: true });
  await waitFor(() => h.received.length === 2, "view after mute");
  assert.equal(t.s.opened, 1);
  assert.deepEqual(t.s.muteCalls, [true]);
  assert.deepEqual(h.received[1], { icon: "ok", status: "2 tools running", muted: true });

  t.s.muteFails = true;
  h.say({ event: "mute", muted: false });
  await waitFor(() => h.received.length === 3, "the tick is put back");
  assert.deepEqual(h.received[2], { icon: "ok", status: "2 tools running", muted: true });
  assert.deepEqual(t.warnings(), ["warn: tray: couldn't change mute: Not saved"]);

  // junk on stdout is ignored
  h.stdout.write("not json\n[1]\n{\"event\":\"mute\",\"muted\":\"yes\"}\n{\"event\":\"nope\"}\n");
  await tick();
  assert.equal(h.received.length, 3);
  assert.deepEqual(t.s.muteCalls, [true]);
});

test("a missing dependency is one warning and no retry", async () => {
  const t = setup();
  t.tray.start();
  await tick();
  const h = t.helpers[0]!;
  h.say({ event: "unavailable", reason: "the AyatanaAppIndicator3 typelib is missing (Ubuntu package: gir1.2-ayatanaappindicator3-0.1)", retry: false });
  await tick();
  h.exit(3);
  assert.equal(t.tray.info().state, "failed");
  assert.match(t.tray.info().message!, /gir1\.2-ayatanaappindicator3-0\.1/);
  assert.equal(t.warnings().length, 1);
  assert.match(t.warnings()[0]!, /^warn: No tray icon: the AyatanaAppIndicator3 typelib is missing/);
  assert.deepEqual(t.clock.pending(), [], "no retry scheduled");
  t.clock.advance(600_000);
  assert.equal(t.helpers.length, 1);
});

test("python3 itself missing is one warning and no retry", async () => {
  const t = setup({ failSpawn: () => Object.assign(new Error("spawn python3 ENOENT"), { code: "ENOENT" }) });
  t.tray.start();
  await waitFor(() => t.tray.info().state === "failed", "failed");
  assert.deepEqual(t.warnings(), ["warn: No tray icon: python3 isn't installed. Everything else works; `motherapp doctor` shows what to install."]);
  assert.deepEqual(t.clock.pending(), []);
});

test("a crashing helper is restarted with backoff, then given up on with one warning", async () => {
  const t = setup();
  t.tray.start();
  const delays: number[] = [];
  for (let i = 0; i < 8; i++) {
    await tick();
    assert.equal(t.helpers.length, i + 1);
    const h = t.helpers[i]!;
    h.stderr.write("Traceback\nRuntimeError: boom\n");
    await tick();
    h.exit(1);
    const pending = t.clock.pending();
    if (pending.length === 0) break;
    assert.equal(t.tray.info().state, "starting");
    delays.push(pending[0]!);
    t.clock.advance(pending[0]!);
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  assert.equal(t.helpers.length, 8);
  assert.equal(t.tray.info().state, "failed");
  assert.equal(t.warnings().length, 1, "retries are debug lines; only giving up warns");
  assert.match(t.warnings()[0]!, /^warn: No tray icon: the helper exited with code 1 \(RuntimeError: boom\); gave up after 8 tries/);
  t.clock.advance(600_000);
  assert.equal(t.helpers.length, 8);

  // the Settings toggle is the way to try again
  await t.tray.setEnabled(false);
  assert.equal(t.tray.info().state, "off");
  await t.tray.setEnabled(true);
  await tick();
  assert.equal(t.helpers.length, 9);
});

test("no display yet (retry: true) is retried; a later start works and re-sends the view", async () => {
  const t = setup();
  t.tray.start();
  await tick();
  t.helpers[0]!.say({ event: "unavailable", reason: "no display to connect to (WAYLAND_DISPLAY / DISPLAY)", retry: true });
  await tick();
  t.helpers[0]!.exit(3);
  assert.deepEqual(t.tray.info(), { enabled: true, available: true, state: "starting", message: "no display to connect to (WAYLAND_DISPLAY / DISPLAY); trying again." });
  assert.deepEqual(t.warnings(), []);
  t.clock.advance(1000);
  await tick();
  const h = t.helpers[1]!;
  h.say({ event: "ready" });
  await waitFor(() => h.received.length === 1, "view for the new helper");
  assert.deepEqual(t.tray.info(), { enabled: true, available: true, state: "running" });
});

test("no tray host: one warning, the helper stays, and the message clears when a host appears", async () => {
  const t = setup();
  t.tray.start();
  await tick();
  const h = t.helpers[0]!;
  h.say({ event: "ready" });
  h.say({ event: "host", connected: false });
  h.say({ event: "host", connected: false });
  await waitFor(() => t.tray.info().message !== undefined, "message");
  assert.equal(t.tray.info().state, "running");
  assert.match(t.tray.info().message!, /^Not visible: nothing on this desktop shows tray icons/);
  assert.equal(t.warnings().length, 1);
  assert.equal(h.signals.length, 0);
  h.say({ event: "host", connected: true });
  await waitFor(() => t.tray.info().message === undefined, "message cleared");
});

test("stop: closes the helper's stdin, SIGTERM, SIGKILL after the grace; no restart", async () => {
  const t = setup();
  t.tray.start();
  await tick();
  const h = t.helpers[0]!;
  h.say({ event: "ready" });
  await waitFor(() => h.received.length === 1, "ready");
  let stopped = false;
  const p = t.tray.stop().then(() => (stopped = true));
  await waitFor(() => h.stdinEnded, "stdin closed");
  assert.deepEqual(h.signals, ["SIGTERM"]);
  await waitFor(() => h.signals.length === 2, "SIGKILL after the grace");
  assert.deepEqual(h.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(stopped, false);
  h.exit(null, "SIGKILL");
  await p;
  assert.equal(t.tray.info().state, "off");
  assert.deepEqual(t.clock.pending(), []);
  assert.deepEqual(t.warnings(), []);
  await tick();
  assert.equal(t.helpers.length, 1);
});

test("stop while a retry is pending or the environment is still being read: nothing starts", async () => {
  const t = setup();
  t.tray.start(); // waiting for env
  await t.tray.stop();
  await tick();
  assert.equal(t.helpers.length, 0);

  const u = setup();
  u.tray.start();
  await tick();
  u.helpers[0]!.exit(1);
  assert.deepEqual(u.clock.pending(), [1000]);
  await u.tray.stop();
  assert.deepEqual(u.clock.pending(), []);
  assert.equal(u.tray.info().state, "off");
});

test("the setting: off never starts; setEnabled saves, starts and stops; not allowed never starts", async () => {
  const t = setup({ enabled: false });
  t.tray.start();
  await tick();
  assert.equal(t.helpers.length, 0);
  assert.deepEqual(t.tray.info(), { enabled: false, available: true, state: "off" });
  assert.equal((await t.tray.setEnabled(true)).state, "starting");
  await tick();
  assert.equal(t.helpers.length, 1);
  assert.equal(t.s.enabled, true);
  t.helpers[0]!.say({ event: "ready" });
  await waitFor(() => t.tray.info().state === "running", "running");
  const off = t.tray.setEnabled(false);
  await waitFor(() => t.helpers[0]!.signals.length === 1, "SIGTERM");
  t.helpers[0]!.exit(0);
  assert.deepEqual(await off, { enabled: false, available: true, state: "off" });
  assert.equal(t.s.enabled, false);
  t.s.saveFails = true;
  await assert.rejects(t.tray.setEnabled(true), /disk full/);
  await tick();
  assert.equal(t.helpers.length, 1, "not saved, not started");

  const n = setup({ allowed: false });
  n.tray.start();
  assert.deepEqual(await n.tray.setEnabled(true), { enabled: true, available: false, state: "off" });
  await tick();
  assert.equal(n.helpers.length, 0);
});

test("manager: the tray shows tool health and the mute switch, both ways; `tray` is saved in config.json", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "motherapp-tray-"));
  const configFile = path.join(tmp, "config.json");
  fs.writeFileSync(configFile, JSON.stringify({ port: 0, tools: {}, custom: 1 }));
  const helpers: FakeHelper[] = [];
  const log = new LogService({ stdout: null });
  let opened = 0;
  const manager = new Manager({
    toolsDir: path.join(fixturesDir, "..", "empty-does-not-exist"),
    configFile,
    log,
    tray: {
      allowed: true,
      command: ["python3", "helper.py"],
      onOpen: () => void opened++,
      env: async () => ({}),
      killGraceMs: 20,
      spawn: (cmd, args, opts) => {
        const h = new FakeHelper(cmd, args, opts.env);
        helpers.push(h);
        return h as unknown as ChildProcess;
      },
    },
  });
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  manager.init();
  manager.tray.start();
  await tick();
  const h = helpers[0]!;
  h.say({ event: "ready" });
  await waitFor(() => h.received.length === 1, "first view");
  assert.deepEqual(h.received[0], { icon: "ok", status: "No tools enabled", muted: false });

  // Settings -> tray
  manager.notifications.setMuted(true);
  await waitFor(() => h.received.length === 2, "mute from Settings reaches the tray");
  assert.deepEqual(h.received[1], { icon: "ok", status: "No tools enabled", muted: true });
  // tray -> Settings (pages hear it through onSettings)
  const pushed: boolean[] = [];
  manager.notifications.onSettings((s) => pushed.push(s.muted));
  h.say({ event: "mute", muted: false });
  await waitFor(() => h.received.length === 3, "mute from the tray comes back as the new view");
  assert.deepEqual(pushed, [false]);
  assert.equal(loadConfig(configFile).config.notifications.muted, false);
  h.say({ event: "open" });
  await waitFor(() => opened === 1, "open");

  // the setting
  assert.equal(loadConfig(configFile).config.tray, true, "default on");
  const off = manager.tray.setEnabled(false);
  await waitFor(() => h.signals.length === 1, "SIGTERM");
  h.exit(0);
  await off;
  const raw = JSON.parse(fs.readFileSync(configFile, "utf8"));
  assert.equal(raw.tray, false);
  assert.equal(raw.custom, 1, "other keys kept");
  assert.equal(loadConfig(configFile).config.tray, false);
  await manager.shutdown();
});

test("manager: without a helper command (every other test's Manager) the tray is unavailable", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "motherapp-tray-"));
  const manager = new Manager({ toolsDir: path.join(tmp, "none"), configFile: path.join(tmp, "config.json"), log: new LogService({ stdout: null }) });
  manager.init();
  manager.tray.start();
  assert.deepEqual(manager.tray.info(), { enabled: true, available: false, state: "off" });
  await manager.shutdown();
  fs.rmSync(tmp, { recursive: true, force: true });
});
