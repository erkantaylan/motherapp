// Grouping rules (issue #19), with the machine's 8 shortcuts as the fixture.
import { test } from "node:test";
import assert from "node:assert/strict";
import { groupOf, groupProblem, groupShortcuts, joinGroup, keysSummary, splitPrefix } from "../src/groups.ts";
import type { Entry, Groupable } from "../src/groups.ts";
import { readToolCommands } from "../src/suggestions.ts";
import { MACHINE, MACHINE_19, REPO_TOOLS } from "./fakes.ts";

type It = Groupable & { conflicts: string };
const items = (list: typeof MACHINE, owned = false): It[] => list.map((m) => ({ id: m.seg, name: m.name, command: m.command, binding: m.binding, owned, conflicts: "" }));
const BIN = "/home/u/.local/bin";
const own = (id: string, name: string, command: string, binding = ""): It => ({ id, name, command, binding, owned: true, conflicts: "" });

/** A compact view: groups as "Name[rule]: label, label", singles as their label. */
const view = (es: Entry<It>[]) => es.map((e) => (e.kind === "single" ? e.label : `${e.name}[${e.rule}]: ${e.members.map((m) => m.label).join(", ")}`));

test("the machine's 8 (#19): Dead Cells map by name prefix, CopyQ stays a plain row", () => {
  const es = groupShortcuts(items(MACHINE_19));
  assert.deepEqual(view(es), [
    "CopyQ",
    "Dead Cells map[prefix]: follow the hero, opacity, show / hide, take clicks, whole level, zoom in, zoom out",
  ]);
  const g = es[1]!;
  assert.equal(g.kind, "group");
  if (g.kind !== "group") return;
  assert.equal(g.key, "dead cells map");
  assert.equal(g.members.length, 7);
  assert.equal(g.keys, "Ctrl+F9–F12 · Ctrl+Shift+F9–F11");
  assert.equal(g.conflicts, 0);
  assert.deepEqual(g.members.map((m) => m.item.binding).slice(0, 2), ["<Control><Shift>F10", "<Control>F10"]);
  assert.equal(groupOf(es).get("custom3"), "Dead Cells map");
  assert.equal(groupOf(es).has("custom7"), false);
});

test("without a prefix: the same program groups, shown by its file name", () => {
  // the #7 fixture: names like dc-map-fit, all calling /home/erkan/.local/bin/dc-map
  assert.deepEqual(view(groupShortcuts(items(MACHINE))), ["CopyQ", "dc-map[program]: dc-map-clicks, dc-map-fit, dc-map-follow, dc-map-opacity, dc-map-toggle, dc-map-zoomin, dc-map-zoomout"]);
  // sh -c's first word counts; launchers don't
  const other = [
    { id: "a", name: "A", command: "sh -c '/opt/x/run.sh one | tee /tmp/l'", binding: "<Super>F1", owned: false },
    { id: "b", name: "B", command: "/opt/x/run.sh two", binding: "<Super>F2", owned: false },
    { id: "c", name: "C", command: "flatpak run org.a.App", binding: "<Super>F3", owned: false },
    { id: "d", name: "D", command: "flatpak run org.b.App", binding: "<Super>F4", owned: false },
    { id: "e", name: "E", command: "/usr/bin/run.sh", binding: "<Super>F5", owned: false },
  ];
  assert.deepEqual(view(groupShortcuts(other) as Entry<It>[]), ["C", "D", "E", "run.sh[program]: A, B"], "a different run.sh doesn't join");
  // two different programs with one file name: the second group names its directory
  const two = [...other, { id: "f", name: "F", command: "/usr/bin/run.sh x", binding: "", owned: false }];
  assert.deepEqual(view(groupShortcuts(two) as Entry<It>[]), ["C", "D", "run.sh[program]: A, B", "run.sh (/usr/bin)[program]: E, F"]);
});

test("at least 2 per group; a lone prefix falls through to the next rule", () => {
  assert.deepEqual(view(groupShortcuts([{ ...items(MACHINE_19)[7]!, name: "Clipboard: CopyQ" }])), ["Clipboard: CopyQ"]);
  const list = [...items(MACHINE_19), { id: "x", name: "Map: one more", command: "/home/erkan/.local/bin/dc-map extra", binding: "<Super>F1", owned: false, conflicts: "" }];
  // "Map" alone is too small, and by program it's alone too (the other dc-map ones are in
  // their prefix group already), so it's a plain row with its whole name
  assert.deepEqual(view(groupShortcuts(list)), ["CopyQ", "Dead Cells map[prefix]: follow the hero, opacity, show / hide, take clicks, whole level, zoom in, zoom out", "Map: one more"]);
  // a lone prefix that matches by program goes there
  const dc = [...items(MACHINE), { id: "y", name: "Map: one more", command: "/home/erkan/.local/bin/dc-map extra", binding: "", owned: false, conflicts: "" }];
  assert.equal(view(groupShortcuts(dc))[1], "dc-map[program]: dc-map-clicks, dc-map-fit, dc-map-follow, dc-map-opacity, dc-map-toggle, dc-map-zoomin, dc-map-zoomout, Map: one more");
  // an empty side of ": " isn't a prefix
  assert.equal(splitPrefix(": x"), null);
  assert.equal(splitPrefix("x: "), null);
  assert.equal(splitPrefix("a:b"), null);
  assert.deepEqual(splitPrefix("A: b: c"), { group: "A", rest: "b: c" });
});

test("motherapp's own group by tool, titled from the manifests; prefixes still come first", () => {
  const { binTools } = readToolCommands(REPO_TOOLS, BIN, () => true);
  assert.equal(binTools.audioctl, "Audio");
  assert.equal(binTools.brightctl, "Brightness");
  assert.equal(binTools.tmuxctl, "tmux");
  const mine = [
    own("m1", "Mute Firefox", `${BIN}/audioctl app-mute firefox toggle`, "<Control><Alt>m"),
    own("m2", "Volume up", `${BIN}/audioctl volume +5`, "<Control><Alt>Up"),
    own("m3", "Audio: mute mic", `${BIN}/audioctl mute --input toggle`, "<Control><Alt>i"),
    own("m4", "Brighter", `${BIN}/brightctl set all +10`, "<Super>F9"),
    own("m5", "Darker", `sh -c '${BIN}/brightctl set all -10 && true'`, "<Super>F8"),
    own("m6", "Kill scratch", `${BIN}/tmuxctl kill scratch`, "<Super>k"),
    own("m7", "Work: lights", `${BIN}/brightctl set all 100`, "<Super>F10"),
    own("m8", "Work: sound", `${BIN}/audioctl volume 30`, "<Super>F11"),
  ];
  assert.deepEqual(view(groupShortcuts(mine, binTools)), [
    "Audio[tool]: Mute Firefox, mute mic, Volume up",
    "Brightness[tool]: Brighter, Darker",
    "Kill scratch",
    "Work[prefix]: lights, sound",
  ]);
  // not for other people's shortcuts: those group by program
  const theirs = mine.slice(0, 2).map((m) => ({ ...m, owned: false }));
  assert.deepEqual(view(groupShortcuts(theirs, binTools)), ["audioctl[program]: Mute Firefox, Volume up"]);
  // a prefix group of 2 named like the tool takes in the tool's other shortcuts
  const merged = groupShortcuts([own("p1", "Audio: a", "/x/a"), own("p2", "audio: b", "/y/b"), mine[0]!], binTools);
  assert.deepEqual(view(merged), ["Audio[prefix]: a, b, Mute Firefox"]);
});

test("sorting: groups and rows together by name, case-insensitive and numeric", () => {
  const list = [
    { id: "1", name: "zeta", command: "/a", binding: "<Super>1", owned: false },
    { id: "2", name: "Apps: F10 thing", command: "/b", binding: "<Super>2", owned: false },
    { id: "3", name: "Apps: f2 thing", command: "/c", binding: "<Super>3", owned: false },
    { id: "4", name: "beta", command: "/d", binding: "<Super>4", owned: false },
    { id: "5", name: "Apps: F9 thing", command: "/e", binding: "<Super>5", owned: false },
  ];
  assert.deepEqual(view(groupShortcuts(list) as Entry<It>[]), ["Apps[prefix]: f2 thing, F9 thing, F10 thing", "beta", "zeta"]);
});

test("conflicts are counted per group (string or list form)", () => {
  const list = items(MACHINE_19);
  list[0]!.conflicts = "Also used by custom shortcut 'x'.";
  list[7]!.conflicts = "Also used by GNOME Shell: something.";
  const conflictsOf = (es: Entry<Groupable>[]) => es.map((e) => (e.kind === "group" ? e.conflicts : e.label));
  assert.deepEqual(conflictsOf(groupShortcuts(list)), ["CopyQ", 1], "a single row's conflict isn't anyone's group's");
  const arr = MACHINE_19.map((m, i) => ({ id: m.seg, name: m.name, command: m.command, binding: m.binding, owned: false, conflicts: i < 3 ? ["custom shortcut 'x'"] : [] }));
  assert.deepEqual(conflictsOf(groupShortcuts(arr)), ["CopyQ", 3]);
});

test("keysSummary: runs of 3+, short runs listed, modifier sets ordered, capped", () => {
  assert.equal(keysSummary(["<Control>F9", "<Control>F10"]), "Ctrl+F9, F10");
  assert.equal(keysSummary(["<Super>3", "<Super>1", "<Super>2", "<Super>a", "<Super>Page_Up"]), "Super+1–3, A, Page Up");
  assert.equal(keysSummary(["F5", "<Primary>F5", "<Control>F5", ""]), "F5 · Ctrl+F5");
  assert.equal(keysSummary(["<Alt>a", "<Super>b", "<Control>c", "<Shift><Super>d"]), "Alt+A · Ctrl+C · Super+B · …");
  assert.equal(keysSummary(["disabled", "<Bogus>x", "Ctrl+F1"]), "");
});

test("joinGroup and groupProblem: what the Group field writes", () => {
  assert.equal(joinGroup("Dead Cells map", "zoom in"), "Dead Cells map: zoom in");
  assert.equal(joinGroup("  G ", " n "), "G: n");
  assert.equal(joinGroup("", "n"), "n");
  assert.deepEqual(splitPrefix(joinGroup("Dead Cells map", "zoom in")), { group: "Dead Cells map", rest: "zoom in" });
  assert.equal(groupProblem(""), null);
  assert.equal(groupProblem("Dead Cells map"), null);
  assert.match(groupProblem("a: b")!, /can't contain/);
  assert.match(groupProblem("a:")!, /can't contain/);
});
