// shortcutsctl subcommands against fake gsettings/dconf: output and exit codes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { runCli } from "../src/cli.ts";
import { DIR, FakeGnome, MACHINE_19, MACHINE_PATHS, machineSnapshot, machineStore, testEnv } from "./fakes.ts";

async function cli(fake: FakeGnome, ...argv: string[]) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = "";
  let err = "";
  stdout.on("data", (c) => (out += c));
  stderr.on("data", (c) => (err += c));
  const code = await runCli(argv, { runner: fake, env: testEnv(), stdout, stderr });
  return { code, out, err };
}

test("list --flat: every entry in GNOME's order, * for ours, conflicts noted", async () => {
  const fake = new FakeGnome();
  const r = await cli(fake, "list", "--flat");
  assert.equal(r.code, 0);
  const lines = r.out.trimEnd().split("\n");
  assert.equal(lines.length, 8);
  // GNOME 46 binds <Super>v to the message tray by default
  assert.match(lines[0]!, /^ {2}CopyQ +<Super>v +copyq toggle {2}\(also: GNOME Shell: toggle-message-tray\)$/);
  assert.match(lines[5]!, /^ {2}dc-map-fit +<Control><Shift>F9 +\/home\/erkan\/\.local\/bin\/dc-map fit$/);
  await cli(fake, "add", "Lock too", "<Super>l", "--", "audioctl", "app-mute", "firefox", "toggle");
  const after = await cli(fake, "list", "--flat");
  assert.match(after.out, /^\* Lock too +<Super>l +\/home\/u\/\.local\/bin\/audioctl app-mute firefox toggle {2}\(also: Settings daemon: screensaver\)$/m);
});

test("list --json and an empty list", async () => {
  const fake = new FakeGnome();
  const j = JSON.parse((await cli(fake, "list", "--json")).out);
  assert.equal(j.length, 8);
  assert.deepEqual(Object.keys(j[0]).sort(), ["binding", "command", "conflicts", "group", "id", "name", "order", "owned", "path"]);
  assert.equal(j[1].path, `${DIR}dc-map-toggle/`);
  const empty = new FakeGnome({ values: {}, builtins: {} });
  assert.deepEqual(await cli(empty, "list"), { code: 0, out: "No custom shortcuts.\n", err: "" });
  assert.equal((await cli(empty, "list", "--yaml")).code, 2);
});

test("add: argv after --, a single command line, absolute wrapper paths; conflicts warn but succeed", async () => {
  const fake = new FakeGnome();
  const before = machineSnapshot(fake.store);
  const a = await cli(fake, "add", "Mute Firefox", "<Control><Alt>m", "--", "audioctl", "app-mute", "firefox", "toggle");
  assert.deepEqual([a.code, a.err], [0, ""]);
  assert.equal(a.out, "added 'Mute Firefox' (Ctrl+Alt+M): /home/u/.local/bin/audioctl app-mute firefox toggle\n");
  const b = await cli(fake, "add", "Brighter", "<Primary>F9", "--", "brightctl set all +10");
  assert.equal(b.code, 0);
  assert.equal(b.err, "shortcutsctl: warning: Ctrl+F9 is also used by custom shortcut 'dc-map-toggle'.\n");
  assert.equal(fake.store.values[`${DIR}motherapp-brighter/command`], "/home/u/.local/bin/brightctl set all +10");
  const c = await cli(fake, "add", "Pipe", "<Super>F1", "--", "tmuxctl list | head -1");
  assert.equal(fake.store.values[`${DIR}motherapp-pipe/command`], "sh -c '/home/u/.local/bin/tmuxctl list | head -1'");
  assert.equal(c.code, 0);
  const d = await cli(fake, "add", "Gone", "<Super>F2", "--", "/home/u/.local/bin/nothere");
  assert.match(d.err, /warning: \/home\/u\/\.local\/bin\/nothere doesn't exist \(run \.\/install\.sh/);
  assert.deepEqual(fake.paths(), [...MACHINE_PATHS, `${DIR}motherapp-mute-firefox/`, `${DIR}motherapp-brighter/`, `${DIR}motherapp-pipe/`, `${DIR}motherapp-gone/`]);
  assert.deepEqual(machineSnapshot(fake.store), before);
});

test("add: exit codes", async () => {
  const fake = new FakeGnome();
  const usage = [
    ["add"],
    ["add", "x"],
    ["add", "x", "<Super>F1"],
    ["add", "x", "<Super>F1", "--"],
    ["add", "x", "y", "<Super>F1", "--", "cmd"],
  ];
  for (const argv of usage) assert.equal((await cli(fake, ...argv)).code, 2, argv.join(" "));
  const bad = await cli(fake, "add", "x", "Ctrl+F1", "--", "cmd");
  assert.deepEqual([bad.code, bad.err], [1, `shortcutsctl: "Ctrl+F1" isn't a GNOME accelerator. Write it like <Control><Shift>F9 or <Super>m.\n`]);
  assert.equal((await cli(fake, "add", "x", "<Super>F1", "--", "echo 'oops")).code, 1);
  assert.equal((await cli(fake, "add", "Dup", "<Super>F1", "--", "a")).code, 0);
  const dup = await cli(fake, "add", "dup", "<Super>F2", "--", "b");
  assert.deepEqual([dup.code, dup.err], [1, "shortcutsctl: There is already a motherapp shortcut named 'Dup'.\n"]);
  const nogs = new FakeGnome();
  nogs.missing.add("gsettings");
  assert.equal((await cli(nogs, "add", "x", "<Super>F1", "--", "a")).code, 1);
});

test("remove: by name or path segment; foreign names refused (exit 1), nothing written", async () => {
  const fake = new FakeGnome();
  await cli(fake, "add", "Mute Firefox", "<Control><Alt>m", "--", "audioctl", "app-mute", "firefox", "toggle");
  await cli(fake, "add", "Other", "<Control><Alt>o", "--", "x");
  const writes = fake.writes().length;
  const foreign = await cli(fake, "remove", "CopyQ");
  assert.deepEqual([foreign.code, foreign.err], [1, "shortcutsctl: 'CopyQ' wasn't made by motherapp, so shortcutsctl won't change it. Use GNOME Settings.\n"]);
  assert.equal((await cli(fake, "remove", "dc-map-toggle")).code, 1);
  const none = await cli(fake, "remove", "nope");
  assert.deepEqual([none.code, none.err], [1, "shortcutsctl: no motherapp shortcut named 'nope'\n"]);
  assert.equal(fake.writes().length, writes, "refusals write nothing");
  assert.equal((await cli(fake, "remove")).code, 2);
  assert.equal((await cli(fake, "remove", "a", "b")).code, 2);
  const r = await cli(fake, "remove", "Mute Firefox");
  assert.deepEqual([r.code, r.out], [0, "removed 'Mute Firefox'\n"]);
  assert.equal((await cli(fake, "remove", "motherapp-other")).code, 0, "by path segment");
  assert.deepEqual(fake.paths(), MACHINE_PATHS);
});

test("edit: name, binding, command; exit codes", async () => {
  const fake = new FakeGnome();
  await cli(fake, "add", "A", "<Super>F5", "--", "x");
  const r = await cli(fake, "edit", "A", "--name", "B", "--binding", "<Super>F6", "--", "audioctl", "list");
  assert.deepEqual([r.code, r.out], [0, "changed 'B'\n"]);
  assert.equal(fake.store.values[`${DIR}motherapp-a/name`], "B");
  assert.equal(fake.store.values[`${DIR}motherapp-a/binding`], "<Super>F6");
  assert.equal(fake.store.values[`${DIR}motherapp-a/command`], "/home/u/.local/bin/audioctl list");
  assert.equal((await cli(fake, "edit", "B")).code, 2, "nothing to change");
  assert.equal((await cli(fake, "edit", "--name", "x")).code, 2);
  assert.equal((await cli(fake, "edit", "B", "--bogus")).code, 2);
  assert.equal((await cli(fake, "edit", "CopyQ", "--binding", "<Super>c")).code, 1);
  assert.equal((await cli(fake, "edit", "B", "--binding", "nope!")).code, 1);
});

test("suggestions, help, unknown commands", async () => {
  const fake = new FakeGnome();
  const s = await cli(fake, "suggestions");
  assert.equal(s.code, 0);
  assert.match(s.out, /^Mute\/unmute Firefox +\/home\/u\/\.local\/bin\/audioctl app-mute firefox toggle$/m);
  assert.match(s.out, /^All monitors brighter +\/home\/u\/\.local\/bin\/brightctl set all \+10$/m);
  assert.match(s.out, /tmuxctl kill scratch {2}\(wrapper not installed\)$/m);
  const j = JSON.parse((await cli(fake, "suggestions", "--json")).out);
  assert.ok(j.some((x: { tool: string; args: string[] }) => x.tool === "audio" && x.args.join(" ") === "app-mute firefox toggle"));
  assert.equal((await cli(fake, "help")).code, 0);
  assert.equal((await cli(fake)).code, 2);
  const u = await cli(fake, "frobnicate");
  assert.equal(u.code, 2);
  assert.match(u.err, /unknown command "frobnicate"/);
});

test("list: grouped like the page (#19), headers with count and keys; --json has group", async () => {
  const fake = new FakeGnome(machineStore(MACHINE_19));
  const r = await cli(fake, "list");
  assert.equal(r.code, 0);
  const D = "/home/erkan/.local/bin/dc-map";
  assert.equal(
    r.out,
    [
      "  CopyQ              <Primary><Alt><Shift>0  copyq toggle",
      "  Dead Cells map  (7 shortcuts, Ctrl+F9–F12 · Ctrl+Shift+F9–F11)",
      `    follow the hero  <Control><Shift>F10     ${D} follow`,
      `    opacity          <Control>F10            ${D} opacity`,
      `    show / hide      <Control>F9             ${D} toggle`,
      `    take clicks      <Control><Shift>F11     ${D} clicks`,
      `    whole level      <Control><Shift>F9      ${D} fit`,
      `    zoom in          <Control>F12            ${D} zoomin`,
      `    zoom out         <Control>F11            ${D} zoomout`,
      "",
    ].join("\n"),
  );
  const flat = await cli(fake, "list", "--flat");
  assert.deepEqual(
    flat.out.trimEnd().split("\n").map((l) => l.slice(2, 2 + 31).trimEnd()),
    MACHINE_19.map((m) => m.name),
  );
  const j = JSON.parse((await cli(fake, "list", "--json")).out) as { name: string; group: string | null }[];
  assert.deepEqual(j.map((x) => x.group), [...Array(7).fill("Dead Cells map"), null]);
  assert.deepEqual(JSON.parse((await cli(fake, "list", "--json", "--flat")).out), j, "--flat doesn't change the JSON");

  // ours first, grouped by tool; a conflict shows on the header and on the row
  await cli(fake, "add", "Mute Firefox", "<Control><Alt>m", "--", "audioctl", "app-mute", "firefox", "toggle");
  await cli(fake, "add", "Louder", "<Control>F9", "--", "audioctl", "volume", "+5");
  const g = (await cli(fake, "list")).out.split("\n");
  assert.match(g[0]!, /^\* Audio {2}\(2 shortcuts, Ctrl\+F9 · Ctrl\+Alt\+M, 1 conflict\)$/);
  assert.match(g[1]!, /^\* {3}Louder +<Control>F9 +\/home\/u\/\.local\/bin\/audioctl volume \+5 {2}\(also: custom shortcut 'Dead Cells map: show \/ hide'\)$/);
  assert.match(g[2]!, /^\* {3}Mute Firefox /);
  assert.match(g[3]!, /^ {2}CopyQ /);
  const j2 = JSON.parse((await cli(fake, "list", "--json")).out) as { name: string; group: string | null }[];
  assert.equal(j2.find((x) => x.name === "Louder")!.group, "Audio");
});

test("add/edit --group writes the 'Group: ' prefix; --group \"\" takes it out", async () => {
  const fake = new FakeGnome(machineStore(MACHINE_19));
  const a = await cli(fake, "add", "--group", "Dead Cells map", "reset", "<Control><Shift>F12", "--", "/home/erkan/.local/bin/dc-map", "reset");
  assert.equal(a.code, 0);
  assert.match(a.out, /^added 'Dead Cells map: reset' /);
  assert.equal(fake.store.values[`${DIR}motherapp-dead-cells-map-reset/name`], "Dead Cells map: reset");
  const mine = async () => (JSON.parse((await cli(fake, "list", "--json")).out) as { id: string; name: string; group: string | null }[]).find((x) => x.id === "motherapp-dead-cells-map-reset")!;
  assert.equal((await mine()).group, null, "motherapp's own are grouped apart from the others, and one alone is no group");
  // only the group changes: the old prefix is replaced
  assert.equal((await cli(fake, "edit", "Dead Cells map: reset", "--group", "Map")).code, 0);
  assert.equal((await mine()).name, "Map: reset");
  // name and group together
  assert.equal((await cli(fake, "edit", "Map: reset", "--name", "start over", "--group", "Dead Cells map")).code, 0);
  assert.equal((await mine()).name, "Dead Cells map: start over");
  // out of the group
  assert.equal((await cli(fake, "edit", "Dead Cells map: start over", "--group", "")).out, "changed 'start over'\n");
  assert.equal((await mine()).name, "start over");
  const bad = await cli(fake, "add", "--group", "a: b", "x", "<Super>F1", "--", "x");
  assert.deepEqual([bad.code, bad.err], [1, `shortcutsctl: A group name can't contain ": " or end with ":".\n`]);
  assert.equal((await cli(fake, "add", "x", "<Super>F1", "--group")).code, 2);
  assert.equal((await cli(fake, "add", "--group", "a", "--group", "b", "x", "<Super>F1", "--", "x")).code, 2);
});
