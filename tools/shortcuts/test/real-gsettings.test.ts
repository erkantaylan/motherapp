// Against the real thing, when the container has it: gsettings + dconf + GNOME 46's schemas
// under a private `dbus-run-session` (apt: libglib2.0-bin dconf-cli dconf-gsettings-backend
// gnome-settings-daemon-common gsettings-desktop-schemas gnome-shell-common mutter-common).
// Skipped otherwise. A second test checks our quoting against GLib's own g_shell_parse_argv
// through PyGObject, when a python3 with `gi` is around.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { commandFromArgv, commandFromLine, joinArgv, shellSplit } from "../src/command.ts";
import { DIR } from "./fakes.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const has = (cmd: string) => spawnSync("sh", ["-c", `command -v ${cmd}`]).status === 0;
const schemaInstalled = () => has("gsettings") && spawnSync("gsettings", ["list-keys", "org.gnome.settings-daemon.plugins.media-keys.custom-keybinding"]).status === 0;
const realMissing = !has("dbus-run-session") || !has("dconf") || !schemaInstalled();

test("real gsettings/dconf: add, edit, remove leave the 8 existing shortcuts byte for byte", { skip: realMissing && "needs dbus-run-session, dconf and the GNOME schemas" }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ma-shortcuts-real-"));
  try {
    const run = path.join(tmp, "run");
    fs.mkdirSync(run, { mode: 0o700 });
    fs.mkdirSync(path.join(tmp, "home"));
    // dconf-service is started by the private bus, so it must get the private HOME too
    const r = spawnSync("dbus-run-session", ["--", process.execPath, "--disable-warning=ExperimentalWarning", path.join(here, "real-helper.ts")], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: path.join(tmp, "home"), XDG_CONFIG_HOME: path.join(tmp, "home", ".config"), XDG_RUNTIME_DIR: run, LANG: "C" },
      timeout: 60_000,
    });
    assert.equal(r.status, 0, r.stderr);
    const res = JSON.parse(r.stdout);
    const home = path.join(tmp, "home");
    assert.equal(res.add.code, 0);
    assert.equal(res.add.err, "shortcutsctl: warning: Ctrl+F9 is also used by custom shortcut 'dc-map-toggle'.\n");
    assert.equal(res.addOdd.code, 0, res.addOdd.err);
    assert.equal(res.listJson.length, 10);
    const mine = res.listJson.filter((s: any) => s.owned);
    assert.deepEqual(
      mine.map((s: any) => [s.name, s.binding, s.command]),
      [
        ["Mute Firefox", "<Control>F9", `${home}/.local/bin/audioctl app-mute firefox toggle`],
        [`Say "it's" é 🚀 \\ {key}`, "<Super><Alt>F1", `sh -c 'notify-send "it'\\''s $USER" | cat'`],
      ],
    );
    assert.match(res.arrayAfterAdd, new RegExp(`'${DIR}dc-map-clicks/', '${DIR}motherapp-mute-firefox/', '${DIR}motherapp-say-it-s-e-key/'\\]`));
    assert.match(res.oddRaw, /name "Say \\"it's\\" é 🚀 \\\\ \{key\}"/, "gsettings prints it back intact (UTF-8 locale)");
    assert.equal(res.edit.code, 0);
    assert.equal(res.editedBinding, "'<Primary><Alt><Shift>0'\n");
    assert.equal(res.removeForeign.code, 1);
    assert.equal(res.removeFirst.code, 0);
    assert.equal(res.dconfAfterRemove, "", "dconf reset -f cleared the keys");
    assert.equal(res.removeOdd.code, 0);
    assert.equal(res.after, res.before, "the 8 entries and the array are byte for byte the same");
    assert.ok(res.builtins > 50, `built-in bindings read: ${res.builtins}`);
    assert.equal(res.snapshotHasFit, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

function pythonWithGi(): string | undefined {
  for (const py of ["python3", "python3.12", "python3.13", "python3.11"]) {
    if (spawnSync(py, ["-I", "-c", "from gi.repository import GLib"]).status === 0) return py;
  }
  return undefined;
}
const py = pythonWithGi();

test("our quoting and splitting agree with GLib's g_shell_parse_argv", { skip: !py && "needs python3 with PyGObject (gi)" }, () => {
  const ctx = { binDir: "/home/u/.local/bin", home: "/home/u", bins: new Set(["audioctl"]) };
  const argvs = [
    ["audioctl", "app-mute", "firefox", "toggle"],
    ["notify-send", "it's done", "say \"hi\"", "back\\slash", "$HOME", "`x`", "", "tab\there", "#nope", "é 🚀"],
  ];
  const lines = [
    ...argvs.map((a) => joinArgv(a)),
    ...argvs.map((a) => commandFromArgv(a, ctx)),
    commandFromLine("notify-send \"it's $USER\" | cat", ctx),
    commandFromLine("audioctl app-volume 'Firefox Web' +5", ctx),
    "/a/b 'it'\\''s' x",
    '"d\\$q" "a\\b" #c',
    "x\\ y  z",
    "a#b c",
  ];
  const script = "import sys, json\nfrom gi.repository import GLib\nprint(json.dumps([GLib.shell_parse_argv(l)[1] for l in json.load(sys.stdin)]))";
  const r = spawnSync(py!, ["-I", "-c", script], { input: JSON.stringify(lines), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const glib = JSON.parse(r.stdout) as string[][];
  lines.forEach((l, i) => assert.deepEqual(shellSplit(l).argv, glib[i], l));
  assert.deepEqual(glib[0], argvs[0]);
  assert.deepEqual(glib[1], argvs[1]);
});
