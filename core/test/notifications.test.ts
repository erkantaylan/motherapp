// The notification service (settings, history, rate limit) and its desktop delivery, with fake
// commands: nothing here can show a popup or play a sound.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { LogEntry, NotificationEntry, NotificationSettings } from "@motherapp/protocol";
import { loadConfig } from "../src/config.ts";
import { LogService } from "../src/logService.ts";
import { Manager } from "../src/manager.ts";
import { HISTORY_SIZE, NotificationError, NotificationService, RATE_MAX, RATE_WINDOW_MS, normalizeNotifications } from "../src/notifications.ts";
import type { NotificationsConfig, NotifyingTool } from "../src/notifications.ts";
import { DesktopDelivery, deliveryEnabled, gdbusArgs, listSounds, notifySendArgs, popupBody } from "../src/notifyDelivery.ts";
import type { Delivery, Exec } from "../src/notifyDelivery.ts";
import { fixturesDir, waitFor } from "./helpers.ts";

class FakeDelivery implements Delivery {
  enabled = true;
  popups: [string, string][] = [];
  played: string[] = [];
  list = ["bell", "message", "window-attention"];
  popup(summary: string, body: string): void {
    this.popups.push([summary, body]);
  }
  play(sound: string, opts?: { preview?: boolean }): void {
    this.played.push(opts?.preview ? `preview:${sound}` : sound);
  }
  sounds(): string[] {
    return this.list;
  }
}

const TMUX: NotifyingTool = {
  id: "tmux",
  title: "tmux",
  icon: "🖥️",
  kinds: [
    { id: "finished", label: "A session finished", sound: "bell" },
    { id: "waiting", label: "A session is waiting on you", sound: "window-attention" },
  ],
};
const OTHER: NotifyingTool = { id: "other", title: "Other", iconUrl: "/tools/other/o.svg", kinds: [] };

function setup(initial?: NotificationsConfig) {
  let cfg: NotificationsConfig = initial ?? { muted: false, tools: {} };
  const delivery = new FakeDelivery();
  const logs: string[] = [];
  const clock = { t: Date.parse("2026-11-10T10:00:00Z") };
  let saves = 0;
  const service = new NotificationService({
    store: {
      get: () => cfg,
      save: (next) => {
        saves++;
        cfg = next;
      },
    },
    tools: () => [TMUX, OTHER],
    delivery,
    log: (level, msg, _fields, tool) => logs.push(`${level} ${tool ?? "core"}: ${msg}`),
    now: () => clock.t,
  });
  return { service, delivery, logs, clock, config: () => cfg, saves: () => saves };
}

test("submit: recorded with the core's view of the tool, popup titled by the event, the kind's sound", () => {
  const t = setup();
  const live: NotificationEntry[] = [];
  t.service.subscribe((e) => live.push(e));
  const e = t.service.submit(TMUX, { kind: "finished", title: "Nebula finished", tool: "audio", toolTitle: "Audio" });
  assert.deepEqual(e, { seq: 1, ts: "2026-11-10T10:00:00.000Z", tool: "tmux", toolTitle: "tmux", toolIcon: "🖥️", kind: "finished", title: "Nebula finished" });
  assert.deepEqual(t.delivery.popups, [["Nebula finished", "tmux"]], "title = the event, second line = the tool's name");
  assert.deepEqual(t.delivery.played, ["bell"]);
  t.service.submit(TMUX, { kind: "waiting", title: "a<b> is waiting on you", body: "see <pane> & co" });
  assert.deepEqual(t.delivery.popups[1], ["a<b> is waiting on you", "tmux\nsee &lt;pane&gt; &amp; co"], "the body is markup for GNOME, the summary isn't");
  assert.deepEqual(t.delivery.played, ["bell", "window-attention"]);
  assert.deepEqual(live.map((x) => x.seq), [1, 2]);
  assert.deepEqual(t.service.backlog().map((x) => x.title), ["Nebula finished", "a<b> is waiting on you"]);
  assert.equal(t.service.backlog()[1]!.body, "see <pane> & co", "history keeps plain text");
  assert.deepEqual(t.service.backlog(1).map((x) => x.seq), [2], "limit keeps the newest");
});

test("submit: invalid ones are ignored; a title is one line and capped; an icon file becomes toolIconUrl", () => {
  const t = setup();
  for (const bad of [undefined, null, "x", {}, { kind: "finished" }, { kind: "Not A Kind", title: "x" }, { kind: "finished", title: 5 }, { kind: "finished", title: " \n " }]) {
    assert.equal(t.service.submit(TMUX, bad), undefined);
  }
  assert.deepEqual(t.delivery.popups, []);
  const e = t.service.submit(OTHER, { kind: "any", title: `two\nlines ${"x".repeat(500)}`, body: "y".repeat(5000) })!;
  assert.equal(e.title.length, 200);
  assert.ok(e.title.startsWith("two lines xxx"));
  assert.equal(e.body!.length, 1000);
  assert.equal(e.toolIconUrl, "/tools/other/o.svg");
  assert.equal(e.toolIcon, undefined);
});

test("an undeclared kind is delivered without a sound, with one warning", () => {
  const t = setup();
  assert.ok(t.service.submit(TMUX, { kind: "other", title: "x" }));
  assert.ok(t.service.submit(TMUX, { kind: "other", title: "y" }));
  assert.equal(t.delivery.popups.length, 2);
  assert.deepEqual(t.delivery.played, ["none", "none"]);
  assert.equal(t.logs.filter((l) => /^warn tmux: notification kind "other" isn't in the manifest/.test(l)).length, 1);
});

test("settings: a tool or kind turned off drops it entirely; mute all records it silently; the sound follows the choice", () => {
  const t = setup();
  const pushed: NotificationSettings[] = [];
  t.service.onSettings((s) => pushed.push(s));
  const s0 = t.service.settings();
  assert.deepEqual(s0, {
    muted: false,
    delivery: true,
    sounds: ["bell", "message", "window-attention"],
    tools: [
      {
        id: "tmux", title: "tmux", icon: "🖥️", enabled: true,
        kinds: [
          { id: "finished", label: "A session finished", enabled: true, sound: "bell", defaultSound: "bell" },
          { id: "waiting", label: "A session is waiting on you", enabled: true, sound: "window-attention", defaultSound: "window-attention" },
        ],
      },
    ],
  }, "only tools that declare kinds are listed");

  // a kind off
  const s1 = t.service.setKind("tmux", "finished", { enabled: false });
  assert.equal(s1.tools[0]!.kinds[0]!.enabled, false);
  assert.deepEqual(pushed.at(-1), s1);
  assert.equal(t.service.submit(TMUX, { kind: "finished", title: "dropped" }), undefined);
  assert.ok(t.service.submit(TMUX, { kind: "waiting", title: "kept" }));
  assert.deepEqual(t.service.backlog().map((e) => e.title), ["kept"]);

  // the tool off
  t.service.setTool("tmux", false);
  assert.equal(t.service.submit(TMUX, { kind: "waiting", title: "dropped too" }), undefined);
  assert.equal(t.service.backlog().length, 1);
  t.service.setTool("tmux", true);
  t.service.setKind("tmux", "finished", { enabled: true, sound: "message" });
  assert.deepEqual(t.config(), { muted: false, tools: { tmux: { enabled: true, kinds: { finished: { enabled: true, sound: "message" } } } } });

  // the chosen sound; "none" plays nothing
  t.delivery.played = [];
  t.service.submit(TMUX, { kind: "finished", title: "with message" });
  t.service.setKind("tmux", "finished", { sound: "none" });
  t.service.submit(TMUX, { kind: "finished", title: "with none" });
  assert.deepEqual(t.delivery.played, ["message", "none"]);
  assert.equal(t.service.settings().tools[0]!.kinds[0]!.defaultSound, "bell");

  // mute all: in the history and pushed live, marked; no popup, no sound
  const before = { popups: t.delivery.popups.length, played: t.delivery.played.length };
  const live: NotificationEntry[] = [];
  t.service.subscribe((e) => live.push(e));
  assert.equal(t.service.setMuted(true).muted, true);
  const e = t.service.submit(TMUX, { kind: "waiting", title: "silent" })!;
  assert.equal(e.muted, true);
  assert.deepEqual(live, [e]);
  assert.deepEqual({ popups: t.delivery.popups.length, played: t.delivery.played.length }, before);
  t.service.setMuted(false);
  assert.equal(t.service.submit(TMUX, { kind: "waiting", title: "loud" })!.muted, undefined);
  assert.equal(t.delivery.popups.length, before.popups + 1);
});

test("settings: only known tools, declared kinds and listed sounds; preview takes a listed name only", () => {
  const t = setup();
  assert.throws(() => t.service.setTool("nope", false), NotificationError);
  assert.throws(() => t.service.setKind("tmux", "nope", { enabled: false }), NotificationError);
  assert.throws(() => t.service.setKind("other", "finished", { enabled: false }), NotificationError);
  for (const sound of ["/usr/share/sounds/freedesktop/stereo/bell.oga", "../bell", "bell.oga", "", "missing"]) {
    assert.throws(() => t.service.setKind("tmux", "finished", { sound }), NotificationError, sound);
    assert.throws(() => t.service.previewSound(sound), NotificationError, sound);
  }
  assert.throws(() => t.service.previewSound("none"), NotificationError);
  assert.equal(t.saves(), 0, "nothing was saved");
  t.service.setMuted(true);
  t.service.previewSound("bell");
  assert.deepEqual(t.delivery.played, ["preview:bell"], "a preview plays even while muted");
});

test("rate limit: at most RATE_MAX per tool per window, the rest dropped with one warning; other tools unaffected", () => {
  const t = setup();
  const sent = () => t.service.backlog().length;
  for (let i = 0; i < RATE_MAX + 5; i++) t.service.submit(TMUX, { kind: "finished", title: `n${i}` });
  assert.equal(sent(), RATE_MAX);
  assert.equal(t.delivery.popups.length, RATE_MAX);
  assert.equal(t.logs.filter((l) => /too many notifications/.test(l)).length, 1);
  assert.ok(t.service.submit(OTHER, { kind: "x", title: "another tool" }));
  t.clock.t += RATE_WINDOW_MS - 1;
  assert.equal(t.service.submit(TMUX, { kind: "finished", title: "still limited" }), undefined);
  t.clock.t += 1;
  assert.ok(t.service.submit(TMUX, { kind: "finished", title: "window over" }));
});

test("history: the last HISTORY_SIZE, oldest first", () => {
  const t = setup();
  for (let i = 0; i < HISTORY_SIZE + 20; i++) {
    t.clock.t += RATE_WINDOW_MS;
    t.service.submit(TMUX, { kind: "finished", title: `n${i}` });
  }
  const all = t.service.backlog();
  assert.equal(all.length, 200);
  assert.equal(all[0]!.title, "n20");
  assert.equal(all.at(-1)!.seq, HISTORY_SIZE + 20);
});

test("normalizeNotifications: defaults, and only well-formed parts of a saved value", () => {
  assert.deepEqual(normalizeNotifications(undefined), { muted: false, tools: {} });
  assert.deepEqual(normalizeNotifications({ muted: "yes", tools: [] }), { muted: false, tools: {} });
  assert.deepEqual(
    normalizeNotifications({
      muted: true,
      tools: {
        tmux: { enabled: false, kinds: { finished: { enabled: false, sound: "bell" }, waiting: { sound: "../x" }, "Bad Kind": { enabled: false } }, junk: 1 },
        empty: {},
        bad: 3,
      },
    }),
    { muted: true, tools: { tmux: { enabled: false, kinds: { finished: { enabled: false, sound: "bell" } } } } },
  );
});

// ---- delivery ----

test("deliveryEnabled: MOTHERAPP_NOTIFY=off, and off under node --test unless it says on", () => {
  assert.equal(deliveryEnabled({}), true);
  assert.equal(deliveryEnabled({ MOTHERAPP_NOTIFY: "off" }), false);
  assert.equal(deliveryEnabled({ MOTHERAPP_NOTIFY: "OFF" }), false);
  assert.equal(deliveryEnabled({ NODE_TEST_CONTEXT: "child-v8" }), false);
  assert.equal(deliveryEnabled({ NODE_TEST_CONTEXT: "child-v8", MOTHERAPP_NOTIFY: "on" }), true);
  assert.equal(deliveryEnabled(), false, "this very test run");
});

test("popup arguments: app motherapp, the desktop-entry hint, no actions, escaping", () => {
  assert.equal(popupBody("a<b>&c"), "a&lt;b&gt;&amp;c");
  assert.equal(popupBody("tmux", "1 < 2"), "tmux\n1 &lt; 2");
  assert.deepEqual(notifySendArgs("/i/icon.png", "-x finished", "tmux"), ["-a", "motherapp", "-i", "/i/icon.png", "-h", "string:desktop-entry:motherapp", "--", "-x finished", "tmux"], "-- so a title can't be an option");
  const g = gdbusArgs("/i/icon.png", "it's a \\ name", "tmux\nbody");
  assert.deepEqual(g.slice(-8), ["motherapp", "0", "'/i/icon.png'", `'it\\'s a \\\\ name'`, `'tmux\\nbody'`, "[]", "{'desktop-entry': <'motherapp'>}", "8000"]);
});

/** Scripted commands: "ok", "missing" (ENOENT) or an exit code, per command. */
class FakeExec {
  calls: string[] = [];
  killed: string[] = [];
  answer: (cmd: string) => "ok" | "missing" | "hang" | number = () => "ok";
  exec: Exec = (cmd, args) => {
    const line = `${cmd} ${args.join(" ")}`;
    this.calls.push(line);
    const a = this.answer(cmd);
    let finish: (r: { code: number | null; stderr: string }) => void = () => {};
    const done =
      a === "missing"
        ? Promise.reject(Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }))
        : a === "hang"
          ? new Promise<{ code: number | null; stderr: string }>((r) => (finish = r))
          : Promise.resolve(a === "ok" ? { code: 0, stderr: "" } : { code: a, stderr: "boom\n" });
    done.catch(() => {});
    return {
      done,
      kill: () => {
        this.killed.push(line);
        finish({ code: null, stderr: "" });
      },
    };
  };
}

const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
};

function soundDir(names: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ma-sounds-"));
  for (const n of names) fs.writeFileSync(path.join(dir, n), "");
  return dir;
}

test("DesktopDelivery popup: notify-send; gdbus when it's missing, and stays there; warns once when neither works", async () => {
  const x = new FakeExec();
  const warnings: string[] = [];
  const d = new DesktopDelivery({ exec: x.exec, icon: "/i.png", soundDir: "/nonexistent", warn: (m) => warnings.push(m) });
  d.popup("a finished", "tmux");
  await settle();
  assert.equal(x.calls[0], "notify-send -a motherapp -i /i.png -h string:desktop-entry:motherapp -- a finished tmux");

  x.answer = (cmd) => (cmd === "notify-send" ? "missing" : "ok");
  d.popup("b is waiting on you", "tmux");
  await settle();
  assert.match(x.calls.at(-1)!, /^gdbus call --session .* motherapp 0 '\/i\.png' 'b is waiting on you' 'tmux' \[\] \{'desktop-entry': <'motherapp'>\} 8000$/);
  d.popup("c", "tmux");
  await settle();
  assert.equal(x.calls.filter((c) => c.startsWith("notify-send")).length, 2, "not tried again");

  x.answer = () => 1;
  d.popup("d", "tmux");
  d.popup("e", "tmux");
  await settle();
  assert.deepEqual(warnings, ["gdbus failed: boom"], "a failure is logged once, and never with the title");

  x.answer = () => "missing";
  d.popup("f", "tmux");
  await settle();
  assert.equal(warnings.at(-1), "No notification popups: neither notify-send nor gdbus could be started.");
});

test("DesktopDelivery sounds: lists *.oga; pw-play only for a listed name; a missing dir or pw-play warns once", async (t) => {
  const dir = soundDir(["bell.oga", "window-attention.oga", "readme.txt", "none.oga", "we ird.oga"]);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(listSounds(dir), ["bell", "window-attention"]);
  assert.deepEqual(listSounds(path.join(dir, "missing")), []);

  const x = new FakeExec();
  const warnings: string[] = [];
  const d = new DesktopDelivery({ exec: x.exec, soundDir: dir, warn: (m) => warnings.push(m) });
  d.play("bell");
  d.play("none");
  d.play("../bell");
  d.play("readme");
  await settle();
  assert.deepEqual(x.calls, [`pw-play ${path.join(dir, "bell.oga")}`]);
  assert.equal(warnings.length, 2, "one per unknown name");

  // a new preview stops the one still playing; a notification's own sound is left alone
  x.answer = () => "hang";
  d.play("bell", { preview: true });
  d.play("bell");
  d.play("window-attention", { preview: true });
  assert.deepEqual(x.killed, [`pw-play ${path.join(dir, "bell.oga")}`]);

  x.answer = () => "missing";
  warnings.length = 0;
  d.play("bell");
  d.play("bell");
  await settle();
  assert.deepEqual(warnings, ["No notification sounds: pw-play could not be started (Ubuntu package: pipewire-bin)."]);

  const none = new DesktopDelivery({ exec: x.exec, soundDir: path.join(dir, "missing"), warn: (m) => warnings.push(m) });
  warnings.length = 0;
  assert.deepEqual(none.sounds(), []);
  assert.deepEqual(none.sounds(), []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /^No notification sounds: no \.oga files in /);
});

test("DesktopDelivery disabled (MOTHERAPP_NOTIFY=off): runs nothing, still lists the sounds", async (t) => {
  const dir = soundDir(["bell.oga"]);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const x = new FakeExec();
  const d = new DesktopDelivery({ enabled: false, exec: x.exec, soundDir: dir, warn: () => {} });
  d.popup("a", "b");
  d.play("bell");
  d.play("bell", { preview: true });
  await settle();
  assert.deepEqual(x.calls, []);
  assert.deepEqual(d.sounds(), ["bell"]);
});

// ---- through the manager: a real tool process, the config file ----

test("Manager: a tool's notify goes through the service under the tool's own id; settings land in config.json", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ma-notify-"));
  const toolsDir = path.join(tmp, "tools");
  fs.mkdirSync(path.join(toolsDir, "pinger"), { recursive: true });
  // node_modules next to the copy, so it resolves @motherapp/tool-sdk
  fs.symlinkSync(path.join(fixturesDir, "..", "..", "..", "..", "node_modules"), path.join(tmp, "node_modules"));
  fs.writeFileSync(path.join(toolsDir, "pinger", "manifest.json"), JSON.stringify({ id: "pinger", title: "Pinger", icon: "p.svg", serve: ["node", "pinger.ts"], notifications: [{ id: "ping", label: "Ping", sound: "bell" }] }));
  fs.writeFileSync(
    path.join(toolsDir, "pinger", "pinger.ts"),
    `import { createTool } from "@motherapp/tool-sdk";
const tool = createTool({ id: "pinger", title: "Pinger (live)", persist: false });
tool.action("ping", (args) => { tool.notify({ kind: "ping", title: String(args.title), tool: "audio" } as never); });
await tool.serve();
`,
  );
  const configFile = path.join(tmp, "config.json");
  fs.writeFileSync(configFile, JSON.stringify({ port: 1234, mine: "kept" }));
  const log = new LogService({ stdout: null });
  const entries: LogEntry[] = [];
  log.subscribe((e) => entries.push(e));
  const delivery = new FakeDelivery();
  const manager = new Manager({ toolsDir, configFile, log, delivery });
  t.after(async () => {
    await manager.shutdown();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  manager.init();
  await waitFor(() => manager.hosts.get("pinger")?.status === "running", "pinger running");

  await manager.action("pinger", "ping", { title: "pong" });
  await waitFor(() => manager.notifications.backlog().length === 1, "recorded");
  const e = manager.notifications.backlog()[0]!;
  assert.deepEqual({ ...e, ts: "" }, { seq: 1, ts: "", tool: "pinger", toolTitle: "Pinger (live)", toolIconUrl: "/tools/pinger/p.svg", kind: "ping", title: "pong" });
  assert.deepEqual(delivery.popups, [["pong", "Pinger (live)"]]);
  assert.deepEqual(delivery.played, ["bell"]);
  assert.ok(!entries.some((x) => JSON.stringify(x).includes("pong")), "the title isn't logged");

  manager.notifications.setKind("pinger", "ping", { sound: "message" });
  manager.notifications.setMuted(true);
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile, "utf8")), { port: 1234, mine: "kept", notifications: { muted: true, tools: { pinger: { kinds: { ping: { sound: "message" } } } } } });
  assert.deepEqual(loadConfig(configFile).config.notifications, { muted: true, tools: { pinger: { kinds: { ping: { sound: "message" } } } } });
  assert.equal(manager.notifications.settings().tools[0]!.kinds[0]!.sound, "message");
});
