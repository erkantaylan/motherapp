// Runs inside `dbus-run-session` with a private HOME (see real-gsettings.test.ts): seeds the
// machine's 8 shortcuts into a real dconf, drives shortcutsctl and the Gnome class against real
// gsettings/dconf, and prints what it saw as one JSON object.
import { spawnSync } from "node:child_process";
import { PassThrough } from "node:stream";
import { runCli } from "../src/cli.ts";
import { Gnome } from "../src/gnome.ts";
import { printString, printStringArray } from "../src/gvariant.ts";
import { RealRunner } from "../src/runner.ts";
import { DIR, MACHINE, MACHINE_PATHS } from "./fakes.ts";

const MEDIA = "org.gnome.settings-daemon.plugins.media-keys";
const env = { ...process.env, LC_ALL: "C.UTF-8" };
const gs = (...args: string[]) => {
  const r = spawnSync("gsettings", args, { encoding: "utf8", env });
  if (r.status !== 0) throw new Error(`gsettings ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
};
const dconf = (...args: string[]) => spawnSync("dconf", args, { encoding: "utf8", env }).stdout;

for (const m of MACHINE) {
  const p = `${DIR}${m.seg}/`;
  gs("set", `${MEDIA}.custom-keybinding:${p}`, "name", printString(m.name));
  gs("set", `${MEDIA}.custom-keybinding:${p}`, "command", printString(m.command));
  gs("set", `${MEDIA}.custom-keybinding:${p}`, "binding", printString(m.binding));
}
gs("set", MEDIA, "custom-keybindings", printStringArray(MACHINE_PATHS));

/** Raw gsettings output for the array and each machine entry: must not change at all. */
const raw = () => [gs("get", MEDIA, "custom-keybindings"), ...MACHINE_PATHS.map((p) => gs("list-recursively", `${MEDIA}.custom-keybinding:${p}`))].join("");

const home = process.env.HOME!;
const cliEnv = { home, binDir: `${home}/.local/bin`, toolsDir: new URL("../..", import.meta.url).pathname, exists: () => true };
async function cli(...argv: string[]) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = "";
  let err = "";
  stdout.on("data", (c) => (out += c));
  stderr.on("data", (c) => (err += c));
  const code = await runCli(argv, { runner: new RealRunner(), env: cliEnv, stdout, stderr });
  return { code, out, err };
}

const before = raw();
const result: Record<string, unknown> = { before };
result.add = await cli("add", "Mute Firefox", "<Control>F9", "--", "audioctl", "app-mute", "firefox", "toggle");
const odd = `Say "it's" é 🚀 \\ {key}`;
result.addOdd = await cli("add", odd, "<Super><Alt>F1", "--", "notify-send \"it's $USER\" | cat");
result.listJson = JSON.parse((await cli("list", "--json")).out);
result.arrayAfterAdd = gs("get", MEDIA, "custom-keybindings");
result.oddRaw = gs("list-recursively", `${MEDIA}.custom-keybinding:${DIR}motherapp-say-it-s-e-key/`);
result.edit = await cli("edit", "Mute Firefox", "--binding", "<Primary><Alt><Shift>0");
result.editedBinding = gs("get", `${MEDIA}.custom-keybinding:${DIR}motherapp-mute-firefox/`, "binding");
result.removeForeign = await cli("remove", "CopyQ");
result.removeFirst = await cli("remove", "Mute Firefox");
result.dconfAfterRemove = dconf("list", `${DIR}motherapp-mute-firefox/`);
result.removeOdd = await cli("remove", odd);
result.after = raw();
const g = new Gnome({ runner: new RealRunner() });
result.builtins = (await g.builtins()).length;
result.snapshotHasFit = /dc-map-fit/.test((await g.snapshot()) ?? "");
process.stdout.write(JSON.stringify(result));
