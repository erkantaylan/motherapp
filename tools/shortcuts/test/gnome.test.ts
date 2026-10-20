// The gsettings/dconf layer against the machine's real set of 8 custom shortcuts: nothing
// foreign is ever reordered, dropped or changed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Gnome, GnomeError, idForPath, isOwnedPath, slugify } from "../src/gnome.ts";
import { DIR, FakeGnome, LIST, MACHINE, MACHINE_PATHS, machineSnapshot } from "./fakes.ts";

const P = (seg: string) => `${DIR}${seg}/`;

function setup() {
  const fake = new FakeGnome();
  const gnome = new Gnome({ runner: fake });
  const before = machineSnapshot(fake.store);
  /** The 8 machine entries are exactly as they were, in their original order. */
  const untouched = () => {
    assert.deepEqual(machineSnapshot(fake.store), before, "machine entries unchanged");
    assert.deepEqual(
      fake.paths().filter((p) => MACHINE_PATHS.includes(p)),
      MACHINE_PATHS,
      "machine paths kept in order",
    );
  };
  return { fake, gnome, untouched };
}

test("list: all 8 machine shortcuts in array order, none owned; LC_ALL=C.UTF-8 on every call", async () => {
  const { fake, gnome } = setup();
  const list = await gnome.list();
  assert.deepEqual(
    list.map((s) => [s.id, s.name, s.binding, s.owned, s.order]),
    MACHINE.map((m, i) => [m.seg, m.name, m.binding, false, i]),
  );
  assert.equal(list[1]!.command, "/home/erkan/.local/bin/dc-map toggle");
  assert.ok(fake.envs.every((e) => e?.LC_ALL === "C.UTF-8"));
  assert.equal(fake.writes().length, 0, "listing writes nothing");
});

test("ownership: only …/custom-keybindings/motherapp-<slug>/ is ours", () => {
  assert.ok(isOwnedPath(P("motherapp-mute-firefox")));
  assert.ok(isOwnedPath(P("motherapp-x-2")));
  for (const p of [P("custom0"), P("dc-map-fit"), P("motherapp-"), P("motherapp-Up"), `${DIR}motherapp-x`, "/org/other/motherapp-x/", P("motherapp-a/b"), P("motherapp--x")]) {
    assert.ok(!isOwnedPath(p), p);
  }
});

test("slugify and ids", () => {
  assert.equal(slugify("Mute Firefox"), "mute-firefox");
  assert.equal(slugify("  Sesi kapat / Işık +10%  "), "sesi-kapat-isik-10");
  assert.equal(slugify("Ünïcödé"), "unicode");
  assert.equal(slugify("🚀🚀"), "shortcut");
  assert.equal(slugify("x".repeat(60)).length, 40);
  const used = new Set<string>();
  assert.equal(idForPath(P("custom0"), used), "custom0");
  assert.equal(idForPath(P("custom0"), used), "custom0~2", "a duplicated array entry gets its own row");
  assert.equal(idForPath("/a/b.c d/", used), "b_2ec_20d");
});

test("add: three keys first, then appended after the 8 existing entries", async () => {
  const { fake, gnome, untouched } = setup();
  const s = await gnome.add({ name: "Mute Firefox", binding: "<Control><Alt>m", command: "/home/u/.local/bin/audioctl app-mute firefox toggle" });
  assert.equal(s.path, P("motherapp-mute-firefox"));
  assert.equal(s.id, "motherapp-mute-firefox");
  assert.equal(s.order, 8);
  assert.deepEqual(fake.paths(), [...MACHINE_PATHS, s.path]);
  assert.equal(fake.store.values[`${s.path}name`], "Mute Firefox");
  assert.equal(fake.store.values[`${s.path}binding`], "<Control><Alt>m");
  assert.equal(fake.store.values[`${s.path}command`], "/home/u/.local/bin/audioctl app-mute firefox toggle");
  const writes = fake.writes();
  assert.equal(writes.length, 4);
  assert.ok(writes.slice(0, 3).every((w) => w.includes(`custom-keybinding:${s.path}`)), "keys before the array");
  assert.match(writes[3]!, /^gsettings set org\.gnome\.settings-daemon\.plugins\.media-keys custom-keybindings \['/);
  untouched();
});

test("add: odd names and commands are stored exactly", async () => {
  const { fake, gnome, untouched } = setup();
  const name = `Say "it's" é {key} \\ 🚀`;
  const command = "sh -c 'notify-send \"it'\\''s\"'";
  const s = await gnome.add({ name, binding: "<Super>F1", command });
  assert.equal(fake.store.values[`${s.path}name`], name);
  assert.equal(fake.store.values[`${s.path}command`], command);
  const back = (await gnome.list()).find((x) => x.path === s.path)!;
  assert.deepEqual([back.name, back.command, back.owned], [name, command, true]);
  untouched();
});

test("add: slug collisions with the list and with leftover dconf data; duplicate names refused", async () => {
  const { fake, gnome, untouched } = setup();
  const a = await gnome.add({ name: "Volume up", binding: "<Super>F2", command: "x" });
  // leftover keys from an earlier crash, not in the list
  fake.store.values[`${P("motherapp-volume-up-2")}name`] = "leftover";
  const b = await gnome.add({ name: "  volume  UP ", binding: "<Super>F3", command: "y" }).catch((e: Error) => e);
  assert.ok(b instanceof GnomeError && /already a motherapp shortcut named 'Volume up'/.test(b.message), "same name, other spelling");
  const c = await gnome.add({ name: "Volume-up", binding: "<Super>F3", command: "y" });
  assert.equal(a.path, P("motherapp-volume-up"));
  assert.equal(c.path, P("motherapp-volume-up-3"), "skips the list entry and the leftover data");
  assert.equal(fake.store.values[`${P("motherapp-volume-up-2")}name`], "leftover", "leftover untouched");
  // a foreign entry may have the same name
  const d = await gnome.add({ name: "CopyQ", binding: "<Super>F4", command: "z" });
  assert.equal(d.path, P("motherapp-copyq"));
  assert.deepEqual(fake.paths(), [...MACHINE_PATHS, a.path, c.path, d.path]);
  await assert.rejects(gnome.add({ name: "  ", binding: "<Super>F5", command: "z" }), /needs a name/);
  untouched();
});

test("add: re-reads the array right before writing, so a concurrent change survives", async () => {
  const { fake, gnome, untouched } = setup();
  let gets = 0;
  const other = P("custom1");
  fake.before = (cmd, args) => {
    // GNOME Settings adds custom1 between our first read and the write
    if (cmd === "gsettings" && args[0] === "get" && args[2] === "custom-keybindings" && ++gets === 2) {
      fake.store.values[LIST] = [...fake.paths(), other];
    }
  };
  const s = await gnome.add({ name: "Race", binding: "<Super>F6", command: "x" });
  assert.deepEqual(fake.paths(), [...MACHINE_PATHS, other, s.path]);
  untouched();
});

test("add: if GNOME doesn't keep the array, the keys are cleaned up and it fails", async () => {
  const { fake, gnome, untouched } = setup();
  fake.before = (cmd, args) => {
    if (cmd === "gsettings" && args[0] === "set" && args[2] === "custom-keybindings") args[3] = fake.store.values[LIST] ? `[${(fake.store.values[LIST] as string[]).map((p) => `'${p}'`).join(", ")}]` : "@as []";
  };
  await assert.rejects(gnome.add({ name: "Lost", binding: "<Super>F7", command: "x" }), /didn't keep the new shortcut/);
  assert.ok(!Object.keys(fake.store.values).some((k) => k.includes("motherapp-lost")), "no leftover keys");
  untouched();
});

test("edit: changes only the given keys of a motherapp shortcut", async () => {
  const { fake, gnome, untouched } = setup();
  const s = await gnome.add({ name: "A", binding: "<Super>F8", command: "x" });
  const n = fake.writes().length;
  await gnome.edit(s.path, { binding: "<Super>F9" });
  assert.equal(fake.writes().length, n + 1);
  assert.equal(fake.store.values[`${s.path}binding`], "<Super>F9");
  await gnome.edit(s.path, { name: "B", command: "y" });
  assert.deepEqual([fake.store.values[`${s.path}name`], fake.store.values[`${s.path}command`]], ["B", "y"]);
  assert.deepEqual(fake.paths(), [...MACHINE_PATHS, s.path], "path kept on rename");
  const other = await gnome.add({ name: "C", binding: "<Super>F10", command: "z" });
  await assert.rejects(gnome.edit(other.path, { name: "b" }), /already a motherapp shortcut named 'B'/);
  untouched();
});

test("edit/remove refuse foreign entries and write nothing", async () => {
  const { fake, gnome, untouched } = setup();
  for (const m of MACHINE) {
    await assert.rejects(gnome.edit(P(m.seg), { binding: "<Super>x" }), /wasn't made by motherapp/);
    await assert.rejects(gnome.remove(P(m.seg)), /wasn't made by motherapp/);
  }
  await assert.rejects(gnome.remove(P("motherapp-ghost")), /doesn't exist anymore/);
  assert.equal(fake.writes().length, 0);
  untouched();
});

test("remove: out of the array (others in order), then dconf reset -f of its path", async () => {
  const { fake, gnome, untouched } = setup();
  const a = await gnome.add({ name: "A", binding: "<Super>F8", command: "x" });
  const b = await gnome.add({ name: "B", binding: "<Super>F9", command: "y" });
  await gnome.remove(a.path);
  assert.deepEqual(fake.paths(), [...MACHINE_PATHS, b.path]);
  assert.ok(!Object.keys(fake.store.values).some((k) => k.startsWith(a.path)), "keys reset");
  assert.ok(fake.calls.includes(`dconf reset -f ${a.path}`));
  await gnome.remove(b.path);
  assert.deepEqual(fake.paths(), MACHINE_PATHS);
  untouched();
});

test("remove from an array holding only ours writes @as []; without dconf it resets key by key", async () => {
  const fake = new FakeGnome({ values: {}, builtins: {} });
  const gnome = new Gnome({ runner: fake });
  const a = await gnome.add({ name: "Only", binding: "<Super>F8", command: "x" });
  fake.missing.add("dconf");
  await gnome.remove(a.path);
  assert.ok(fake.calls.includes("gsettings set org.gnome.settings-daemon.plugins.media-keys custom-keybindings @as []"));
  assert.ok(fake.calls.includes(`gsettings reset org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:${a.path} name`));
  assert.deepEqual(fake.store.values[LIST], []);
  assert.deepEqual(Object.keys(fake.store.values), [LIST]);
});

test("errors: gsettings missing, schema missing, unreadable entries", async () => {
  const fake = new FakeGnome();
  fake.missing.add("gsettings");
  await assert.rejects(new Gnome({ runner: fake }).list(), /gsettings not found \(Ubuntu package libglib2\.0-bin\)/);
  const noSchema = new FakeGnome();
  noSchema.before = (_c, args) => {
    if (args[1]?.startsWith("org.gnome.settings-daemon")) args[1] = "org.gnome.missing";
  };
  await assert.rejects(new Gnome({ runner: noSchema }).list(), /GNOME's settings schema is missing: No such schema/);
  // an entry with an invalid path is listed read-only with an error, the rest still work
  const odd = new FakeGnome();
  odd.store.values[LIST] = [...MACHINE_PATHS.slice(0, 2), "nope", "/bad//path/"];
  const list = await new Gnome({ runner: odd }).list();
  assert.equal(list.length, 4);
  assert.deepEqual(
    list.slice(2).map((s) => [s.owned, s.error]),
    [
      [false, "not a valid dconf path"],
      [false, "not a valid dconf path"],
    ],
  );
});

test("builtins: GNOME 46's keybinding schemas, without custom-keybindings or empty values", async () => {
  const { gnome } = setup();
  const b = await gnome.builtins();
  const find = (key: string) => b.filter((x) => x.key === key).map((x) => x.accel);
  assert.deepEqual(find("close"), ["<Alt>F4"]);
  assert.deepEqual(find("screensaver"), ["<Super>l"]);
  assert.deepEqual(find("screensaver-static"), ["XF86ScreenSaver"]);
  assert.deepEqual(find("custom-keybindings"), []);
  assert.deepEqual(find("toggle-overview"), [], "@as [] has nothing");
  assert.ok(b.every((x) => x.accel !== ""));
  assert.ok(new Set(b.map((x) => x.title)).size >= 4);
});

test("snapshot: one dconf dump of the media-keys dir; null without dconf", async () => {
  const { fake, gnome } = setup();
  const s1 = await gnome.snapshot();
  assert.match(s1!, /\[custom-keybindings\/dc-map-fit\]\nbinding='<Control><Shift>F9'/);
  await gnome.add({ name: "A", binding: "<Super>F8", command: "x" });
  assert.notEqual(await gnome.snapshot(), s1);
  fake.missing.add("dconf");
  assert.equal(await gnome.snapshot(), null);
});
