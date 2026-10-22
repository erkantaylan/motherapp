// #26: every tool CLI, run with a stdout whose reader has gone away (`audioctl list | head -1`),
// exits 0 without a stack trace. Each CLI runs against the fakes its own tests use (fake
// pw-dump, ddcutil, gsettings/dconf, tmux, a temp state dir), never the real machine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { fakeDdcutil, MACHINE_MONITORS } from "../../../tools/brightness/test/fakes.ts";
import { MACHINE_19, machineStore } from "../../../tools/shortcuts/test/fakes.ts";
import { session } from "../../../tools/tmux/test/fakes.ts";
import { ryzen3900x, writeTree } from "../../../tools/cpu/test/fixtures.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..", "..");
const sdk = path.join(repo, "packages", "tool-sdk", "src", "index.ts");

interface Run {
  code: number | null;
  signal: NodeJS.Signals | null;
  err: string;
}

/**
 * Starts `node <args>` with stdout on a pipe whose read end is closed at once, so the child's
 * first write to stdout fails with EPIPE (deterministically: the child is still starting up).
 */
function runClosedStdout(args: string[], env: NodeJS.ProcessEnv): Promise<Run> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    p.stdout.destroy();
    let err = "";
    p.stderr.setEncoding("utf8");
    p.stderr.on("data", (d: string) => (err += d));
    p.on("close", (code, signal) => resolve({ code, signal, err }));
  });
}

/** Runs `node <args> | head -1` in a shell; returns the CLI's exit status and stderr. */
function runPipedToHead(args: string[], env: NodeJS.ProcessEnv): Promise<Run & { out: string }> {
  const quoted = [process.execPath, "--disable-warning=ExperimentalWarning", ...args].map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ");
  return new Promise((resolve) => {
    const p = spawn("/bin/bash", ["-c", `set -o pipefail; ${quoted} 2>"$ERR_FILE" | head -1`], { env, stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    p.stdout.setEncoding("utf8");
    p.stdout.on("data", (d: string) => (out += d));
    p.on("close", (code, signal) => resolve({ code, signal, out, err: fs.readFileSync(env.ERR_FILE!, "utf8") }));
  });
}

/** A port nothing listens on (was free a moment ago), so no CLI reaches a running core. */
async function deadPort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

function assertQuiet(r: Run, what: string): void {
  assert.equal(r.signal, null, `${what}: killed by ${r.signal}`);
  assert.equal(r.code, 0, `${what}: exit ${r.code}\n${r.err}`);
  assert.doesNotMatch(r.err, /EPIPE|Unhandled 'error' event|at .*\.ts:\d+/, `${what}: stack trace on stderr`);
}

/** One temp "machine" with every fake the CLIs need. */
async function fakeMachine(tmp: string) {
  const bin = path.join(tmp, "bin");
  const home = path.join(tmp, "home");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
  const shim = (name: string, script: string, pre = "") =>
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${pre}exec "${process.execPath}" --disable-warning=ExperimentalWarning "${script}" "$@"\n`, { mode: 0o755 });

  // audio: fake pw-dump/wpctl
  const pw = path.join(tmp, "pw");
  fs.mkdirSync(path.join(pw, "queue"), { recursive: true });
  const fakePw = path.join(repo, "tools/audio/test/fake-pipewire.ts");
  for (const name of ["pw-dump", "wpctl", "pw-play", "pw-record"]) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nexec "${process.execPath}" --disable-warning=ExperimentalWarning "${fakePw}" ${name} "$@"\n`, { mode: 0o755 });
  }
  // brightness: fake ddcutil (own bin dir), libddcutil made unloadable so the fake is used
  const ddc = fakeDdcutil(path.join(tmp, "ddc-root"), MACHINE_MONITORS);
  // shortcuts: fake gsettings/dconf with the 8 shortcuts from #19
  const gnome = path.join(tmp, "gnome");
  fs.mkdirSync(gnome);
  fs.writeFileSync(path.join(gnome, "store.json"), JSON.stringify(machineStore(MACHINE_19)));
  const fakeGnome = path.join(repo, "tools/shortcuts/test/fake-gnome.ts");
  for (const name of ["gsettings", "dconf"]) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nexec "${process.execPath}" --disable-warning=ExperimentalWarning "${fakeGnome}" ${name} "$@"\n`, { mode: 0o755 });
  }
  // tmux: fake tmux with a few sessions
  const tmuxDir = path.join(tmp, "tmux");
  fs.mkdirSync(tmuxDir);
  const now = Math.floor(Date.now() / 1000);
  fs.writeFileSync(path.join(tmuxDir, "server.json"), JSON.stringify([0, 1, 2].map((i) => session(i, `s${i}`, { created: now, activity: now }))));
  shim("tmux", path.join(repo, "tools/tmux/test/fake-tmux.ts"));
  // cpu: a fixture sysfs tree instead of the real /sys
  const cpuRoot = path.join(tmp, "cpu-root");
  writeTree(cpuRoot, ryzen3900x());
  // inbox: a temp state dir (an empty delivery log still prints a line)
  const state = path.join(tmp, "state");
  fs.mkdirSync(path.join(state, "motherapp", "inbox"), { recursive: true, mode: 0o700 });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    PATH: `${bin}:${ddc.bin}:${process.env.PATH}`,
    FAKE_PW_DIR: pw,
    FAKE_GNOME_DIR: gnome,
    FAKE_TMUX_DIR: tmuxDir,
    TMUX_TMPDIR: tmuxDir,
    XDG_CONFIG_HOME: path.join(tmp, "config"),
    XDG_STATE_HOME: state,
    XDG_RUNTIME_DIR: path.join(tmp, "run"),
    MOTHERAPP_PORT: String(await deadPort()),
    MOTHERAPP_CPU_ROOT: cpuRoot,
    BRIGHTCTL_LIBDDCUTIL: "libddcutil-missing.so.4",
    ERR_FILE: path.join(tmp, "stderr.txt"),
  };
  delete env.BRIGHTCTL_BACKEND;
  return env;
}

const CLIS: [string, string[]][] = [
  ["audioctl list", ["tools/audio/audioctl.ts", "list"]],
  ["brightctl list", ["tools/brightness/brightctl.ts", "list"]],
  ["shortcutsctl list", ["tools/shortcuts/shortcutsctl.ts", "list"]],
  ["tmuxctl list", ["tools/tmux/tmuxctl.ts", "list"]],
  ["inboxctl log", ["tools/inbox/inboxctl.ts", "log"]],
  ["cpuctl status", ["tools/cpu/cpuctl.ts", "status"]],
];

test("the harness really produces EPIPE: a plain write without the helper dies with a stack trace", async () => {
  const r = await runClosedStdout(["-e", "setInterval(() => process.stdout.write('x\\n'), 5)"], process.env);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /EPIPE/);
});

test("exitOnBrokenPipe: EPIPE on stdout exits 0 quietly", async () => {
  const script = `import { exitOnBrokenPipe } from ${JSON.stringify(sdk)}; exitOnBrokenPipe(); setInterval(() => process.stdout.write("x\\n"), 5);`;
  const r = await runClosedStdout(["--input-type=module", "-e", script], process.env);
  assertQuiet(r, "helper");
});

test("exitOnBrokenPipe: any other stream error is still thrown", async () => {
  const script = `import { exitOnBrokenPipe } from ${JSON.stringify(sdk)}; exitOnBrokenPipe(); const e = Object.assign(new Error("disk on fire"), { code: "EIO" }); process.stdout.emit("error", e);`;
  const r = await runClosedStdout(["--input-type=module", "-e", script], process.env);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /disk on fire/);
});

for (const [name, args] of CLIS) {
  test(`${name} with a closed stdout exits 0 without a stack trace (#26)`, async (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ma-epipe-"));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const env = await fakeMachine(tmp);
    assertQuiet(await runClosedStdout([path.join(repo, args[0]!), ...args.slice(1)], env), name);
    const piped = await runPipedToHead([path.join(repo, args[0]!), ...args.slice(1)], env);
    assertQuiet(piped, `${name} | head -1`);
    assert.equal(piped.out.split("\n").filter(Boolean).length, 1, `${name} | head -1 printed one line`);
  });
}
