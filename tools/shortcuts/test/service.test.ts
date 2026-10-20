// Serve mode against fake gsettings/dconf: state, actions, polling, ownership, warnings.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createTool } from "@motherapp/tool-sdk";
import { LineDecoder } from "@motherapp/protocol";
import { Gnome } from "../src/gnome.ts";
import { groupShortcuts } from "../src/groups.ts";
import { INITIAL_STATE, POLL_MS, ShortcutsService } from "../src/service.ts";
import type { Row } from "../src/service.ts";
import { DIR, FakeGnome, FakeTimers, LIST, MACHINE, MACHINE_19, MACHINE_PATHS, machineSnapshot, machineStore, testEnv, tick, waitFor } from "./fakes.ts";

type Msg = { id?: number; method?: string; params?: any; result?: any; error?: { code: number; message: string } };

function setup(fake = new FakeGnome(), opts: { watched?: boolean } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const tool = createTool({ id: "shortcuts", title: "Shortcuts", page: "custom", initialState: INITIAL_STATE, persist: false, captureConsole: false, input, output });
  const timers = new FakeTimers();
  const service = new ShortcutsService({ tool, gnome: new Gnome({ runner: fake }), env: testEnv(), timers });
  const received: Msg[] = [];
  const dec = new LineDecoder();
  output.setEncoding("utf8");
  output.on("data", (c: string) => {
    for (const l of dec.push(c)) received.push(JSON.parse(l));
  });
  let id = 0;
  const action = async (name: string, args: unknown): Promise<Msg> => {
    const myId = ++id;
    input.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method: "action", params: { name, args } }) + "\n");
    await waitFor(() => received.some((m) => m.id === myId), `reply to ${name}`);
    return received.find((m) => m.id === myId)!;
  };
  const settle = async () => {
    for (let i = 0; i < 40; i++) await tick();
  };
  const rows = () => tool.get("shortcuts") as Record<string, Row>;
  const done = tool.serve();
  /** The core's `watch` notification (a visible tab opened or left the page). */
  const watch = (watching: boolean) => input.write(JSON.stringify({ jsonrpc: "2.0", method: "watch", params: { watching } }) + "\n");
  if (opts.watched !== false) watch(true);
  const end = async () => {
    service.stop();
    input.end();
    await done;
  };
  return { tool, fake, timers, service, action, settle, rows, received, watch, end };
}

test("start: all 8 rows (read-only), suggestions, bindings for the page", async () => {
  const t = setup();
  t.service.start();
  await t.settle();
  const rows = t.rows();
  assert.deepEqual(Object.keys(rows), MACHINE.map((m) => m.seg));
  assert.ok(Object.values(rows).every((r) => !r.owned));
  assert.equal(rows["dc-map-fit"]!.label, "Ctrl+Shift+F9");
  assert.equal(rows["custom0"]!.conflicts, "Also used by GNOME Shell: toggle-message-tray.");
  assert.equal(t.tool.isStale("shortcuts"), false);
  const sug = t.tool.get("suggestions") as Record<string, { command: string; installed: boolean }>;
  assert.equal(sug["audio-1"]!.command, "/home/u/.local/bin/audioctl app-mute firefox toggle");
  assert.equal(sug["audio-1"]!.installed, true);
  assert.equal(sug["tmux-1"]!.installed, false);
  assert.equal(t.tool.get("binDir"), "/home/u/.local/bin");
  assert.ok((t.tool.get("bins") as string[]).includes("brightctl"));
  const bindings = t.tool.get("bindings") as { accel: string; what: string }[];
  assert.ok(bindings.some((b) => b.accel === "<Control>f9" && b.what === "custom shortcut 'dc-map-toggle'"));
  assert.ok(bindings.some((b) => b.what === "Window manager: close"));
  assert.equal(t.fake.writes().length, 0, "starting up writes nothing");
  await t.end();
});

test("add from a suggestion: absolute command, appended, row appears; conflict comes back as a warning", async () => {
  const t = setup();
  const before = machineSnapshot(t.fake.store);
  t.service.start();
  await t.settle();
  const r = await t.action("add", { name: "Mute Firefox", binding: "<Primary>F9", command: "/home/u/.local/bin/audioctl app-mute firefox toggle" });
  assert.equal(r.error, undefined);
  assert.equal(r.result.id, "motherapp-mute-firefox");
  assert.deepEqual(r.result.warnings, ["Ctrl+F9 is also used by custom shortcut 'dc-map-toggle'."]);
  await t.settle();
  const row = t.rows()["motherapp-mute-firefox"]!;
  assert.deepEqual([row.owned, row.binding, row.order, row.command], [true, "<Primary>F9", 8, "/home/u/.local/bin/audioctl app-mute firefox toggle"]);
  assert.equal(row.conflicts, "Also used by custom shortcut 'dc-map-toggle'.");
  assert.equal(t.rows()["dc-map-toggle"]!.conflicts, "Also used by custom shortcut 'Mute Firefox'.");
  assert.deepEqual(t.fake.paths(), [...MACHINE_PATHS, `${DIR}motherapp-mute-firefox/`]);
  assert.deepEqual(machineSnapshot(t.fake.store), before);
  // a typed command with a bare tool name, and an argv
  const b = await t.action("add", { name: "Darker", binding: "<Super>F2", command: "brightctl set all -10" });
  assert.equal(b.result.command, "/home/u/.local/bin/brightctl set all -10");
  const c = await t.action("add", { name: "Kill", binding: "<Super>F3", command: ["tmuxctl", "kill", "my session"] });
  assert.equal(c.result.command, "/home/u/.local/bin/tmuxctl kill 'my session'");
  assert.deepEqual(c.result.warnings, ["/home/u/.local/bin/tmuxctl doesn't exist (run ./install.sh to write the tool wrappers)."]);
  await t.settle();
  assert.equal(t.rows()["motherapp-kill"]!.missing, "/home/u/.local/bin/tmuxctl doesn't exist (run ./install.sh to write the tool wrappers).");
  await t.end();
});

test("add: bad input is refused with a readable message", async () => {
  const t = setup();
  t.service.start();
  await t.settle();
  const cases: [unknown, RegExp][] = [
    [{ name: "x", binding: "Ctrl+F1", command: "a" }, /isn't a GNOME accelerator/],
    [{ name: "x", binding: "", command: "a" }, /Press a key combination/],
    [{ name: "", binding: "<Super>F1", command: "a" }, /needs a name/],
    [{ name: "x", binding: "<Super>F1", command: "" }, /empty/],
    [{ name: "x", binding: "<Super>F1", command: 5 }, /command must be/],
    [{ binding: "<Super>F1", command: "a" }, /name must be a string/],
  ];
  for (const [args, re] of cases) {
    const r = await t.action("add", args);
    assert.match(r.error?.message ?? "", re, JSON.stringify(args));
  }
  assert.equal(t.fake.writes().length, 0);
  await t.end();
});

test("edit and remove: only motherapp rows; foreign ids refused without writes", async () => {
  const t = setup();
  const before = machineSnapshot(t.fake.store);
  t.service.start();
  await t.settle();
  await t.action("add", { name: "A", binding: "<Super>F5", command: "audioctl list" });
  const n = t.fake.writes().length;
  for (const m of MACHINE) {
    const e = await t.action("edit", { id: m.seg, binding: "<Super>x" });
    assert.match(e.error!.message, /wasn't made by motherapp, so it is read-only here/);
    const r = await t.action("remove", { id: m.seg });
    assert.match(r.error!.message, /read-only/);
  }
  assert.equal((await t.action("remove", { id: "nope" })).error?.message, "That shortcut doesn't exist anymore.");
  assert.equal((await t.action("remove", { id: "a.b" })).error?.code, -32602);
  assert.equal(t.fake.writes().length, n);

  const e = await t.action("edit", { id: "motherapp-a", name: "B", binding: "<Control>F10" });
  assert.equal(e.error, undefined);
  assert.deepEqual(e.result.warnings, ["Ctrl+F10 is also used by custom shortcut 'dc-map-opacity'."]);
  await t.settle();
  assert.deepEqual([t.rows()["motherapp-a"]!.name, t.rows()["motherapp-a"]!.binding], ["B", "<Control>F10"]);
  assert.equal(t.fake.store.values[`${DIR}motherapp-a/command`], "/home/u/.local/bin/audioctl list", "command untouched when not sent");
  // editing without changing the binding doesn't conflict with itself
  const same = await t.action("edit", { id: "motherapp-a", name: "C" });
  assert.deepEqual(same.result.warnings, ["Ctrl+F10 is also used by custom shortcut 'dc-map-opacity'."]);

  const r = await t.action("remove", { id: "motherapp-a" });
  assert.equal(r.error, undefined);
  await t.settle();
  assert.equal(t.rows()["motherapp-a"], undefined, "row gone with the reply");
  assert.deepEqual(t.fake.paths(), MACHINE_PATHS);
  assert.deepEqual(machineSnapshot(t.fake.store), before);
  await t.end();
});

test("polling: a change made elsewhere shows up on the next tick, as deltas; no change, no re-read", async () => {
  const t = setup();
  t.service.start();
  await t.settle();
  const calls = t.fake.calls.length;
  t.timers.advance(POLL_MS);
  await t.settle();
  assert.deepEqual(t.fake.calls.slice(calls), [`dconf dump /org/gnome/settings-daemon/plugins/media-keys/`], "only the dump");
  const mark = t.received.length;
  // GNOME Settings renames CopyQ and adds custom1
  t.fake.store.values[`${DIR}custom0/name`] = "CopyQ clipboard";
  t.fake.store.values[`${DIR}custom1/name`] = "Terminal";
  t.fake.store.values[`${DIR}custom1/binding`] = "<Control><Alt>t";
  t.fake.store.values[`${DIR}custom1/command`] = "gnome-terminal";
  t.fake.store.values[LIST] = [...MACHINE_PATHS, `${DIR}custom1/`];
  t.timers.advance(POLL_MS);
  await t.settle();
  const changes = t.received.slice(mark).filter((m) => m.method === "state").flatMap((m) => m.params.changes);
  assert.ok(changes.some((c: any) => c.path === "shortcuts.custom0.name" && c.value === "CopyQ clipboard"));
  assert.ok(changes.some((c: any) => c.path === "shortcuts.custom1" && c.value.owned === false));
  assert.ok(!changes.some((c: any) => c.path === "shortcuts"), "deltas, not the whole map");
  await t.end();
});

test("no dconf: still works, full re-read every few ticks; gsettings errors keep rows, stale, with a status", async () => {
  const fake = new FakeGnome();
  fake.missing.add("dconf");
  const t = setup(fake);
  t.service.start();
  await t.settle();
  assert.equal(Object.keys(t.rows()).length, 8);
  fake.missing.add("gsettings");
  for (let i = 0; i < 4; i++) {
    t.timers.advance(POLL_MS);
    await t.settle();
  }
  assert.equal(t.tool.isStale("shortcuts"), true);
  assert.equal(Object.keys(t.rows()).length, 8, "last known rows kept");
  assert.equal(t.tool.get("status"), "Can't read GNOME's shortcuts: gsettings not found (Ubuntu package libglib2.0-bin).");
  fake.missing.delete("gsettings");
  for (let i = 0; i < 4; i++) {
    t.timers.advance(POLL_MS);
    await t.settle();
  }
  assert.equal(t.tool.isStale("shortcuts"), false);
  assert.equal(t.tool.get("status"), undefined);
  await t.end();
});

test("groups (#19): add/edit take a group and write 'Group: name'; renaming out of a prefix leaves the group", async () => {
  const t = setup(new FakeGnome(machineStore(MACHINE_19)));
  t.service.start();
  await t.settle();
  assert.deepEqual((t.tool.get("binTools") as Record<string, string>).audioctl, "Audio");
  const grouped = () => {
    const rows = Object.entries(t.rows()).map(([id, r]) => ({ ...r, id }));
    return [true, false].map((owned) => groupShortcuts(rows.filter((r) => r.owned === owned), t.tool.get("binTools") as Record<string, string>).map((e) => (e.kind === "group" ? `${e.name}: ${e.members.map((m) => m.label).join(", ")}` : e.label)));
  };
  const a = await t.action("add", { name: "reset", group: "Dead Cells map", binding: "<Control><Shift>F12", command: "/home/erkan/.local/bin/dc-map reset" });
  assert.equal(a.error, undefined);
  const b = await t.action("add", { name: "map off", group: "Dead Cells map", binding: "<Control><Shift>F8", command: "/opt/other/map-off" });
  assert.equal(b.error, undefined);
  await t.settle();
  assert.equal(t.fake.store.values[`${DIR}${a.result.id}/name`], "Dead Cells map: reset");
  assert.deepEqual(grouped()[0], ["Dead Cells map: map off, reset"]);
  // the page sends the group with every edit; "" takes it out, and the group shrinks live
  const e = await t.action("edit", { id: a.result.id, name: "reset", group: "", binding: "<Control><Shift>F12" });
  assert.equal(e.error, undefined);
  await t.settle();
  assert.equal(t.rows()[a.result.id]!.name, "reset");
  assert.deepEqual(grouped()[0], ["Dead Cells map: map off", "reset"], "a lone prefix is a plain row");
  // a rename by hand (no group field) that drops the prefix does the same
  await t.action("edit", { id: b.result.id, name: "map off for good" });
  await t.settle();
  assert.deepEqual(grouped()[0], ["map off for good", "reset"]);
  assert.equal(grouped()[1]!.length, 2, "the other 8 untouched: CopyQ and the Dead Cells map group");
  const bad = await t.action("add", { name: "x", group: "a: b", binding: "<Super>F1", command: "x" });
  assert.match(bad.error?.message ?? "", /can't contain/);
  const bad2 = await t.action("edit", { id: b.result.id, group: 5 });
  assert.match(bad2.error?.message ?? "", /group must be a string/);
  await t.end();
});

test("unwatched: no gsettings or dconf calls over 60 s; opening the page reads at once, then every 3 s", async () => {
  for (const noDconf of [false, true]) {
    const fake = new FakeGnome();
    if (noDconf) fake.missing.add("dconf");
    const t = setup(fake, { watched: false });
    t.service.start();
    await t.settle();
    for (let i = 0; i < 20; i++) {
      t.timers.advance(POLL_MS);
      await t.settle();
    }
    assert.equal(t.fake.calls.length, 0, `nothing runs while nobody looks (dconf ${noDconf ? "missing" : "present"})`);
    assert.equal(t.tool.isStale("shortcuts"), true);

    t.watch(true);
    await t.settle();
    assert.equal(Object.keys(t.rows()).length, 8, "read at once");
    assert.equal(t.tool.isStale("shortcuts"), false);
    const first = t.fake.calls.length;
    assert.ok(first > 0);
    for (let i = 0; i < 4; i++) {
      t.timers.advance(POLL_MS);
      await t.settle();
    }
    assert.ok(t.fake.calls.length > first, "keeps polling while watched");
    if (!noDconf) assert.equal(t.fake.calls.slice(first).filter((c) => c.startsWith("dconf dump")).length, 4, "one dump every 3 s");

    t.watch(false);
    await t.settle();
    assert.equal(t.tool.isStale("shortcuts"), true, "rows kept, stale");
    const stopped = t.fake.calls.length;
    for (let i = 0; i < 20; i++) {
      t.timers.advance(POLL_MS);
      await t.settle();
    }
    assert.equal(t.fake.calls.length, stopped, "stops when the last viewer leaves");

    // an action still reads GNOME's current list while nobody looks
    t.fake.store.values[`${DIR}custom0/name`] = "Renamed elsewhere";
    const r = await t.action("refresh", {});
    assert.equal(r.error, undefined);
    assert.equal(t.rows()["custom0"]!.name, "Renamed elsewhere");
    assert.equal(t.fake.writes().length, 0);
    await t.end();
  }
});
