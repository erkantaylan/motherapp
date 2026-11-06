// Against a real tmux (3.4 in the cloud container, 3.6a on the machine), skipped without one.
// Every call uses a private socket (-S <tmpdir>/sock), never the default server, and the
// server is killed afterwards.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { parseAnsi } from "../src/ansi.ts";
import { runCli } from "../src/cli.ts";
import { launch, openArgv, openEnv } from "../src/open.ts";
import { RealRunner } from "../src/runner.ts";
import { Tmux, attachCommand } from "../src/tmux.ts";

const hasTmux = spawnSync("tmux", ["-V"], { encoding: "utf8" }).status === 0;
const skip = hasTmux ? false : "tmux is not installed";

let dir = "";
let sock = "";
const runner = new RealRunner();

function tmux(...args: string[]) {
  const r = spawnSync("tmux", ["-u", "-S", sock, ...args], { encoding: "utf8", env: { ...process.env, TMUX: "" } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function newSession(name: string): void {
  const r = tmux("new-session", "-d", "-s", name, "-x", "80", "-y", "24", "-c", dir);
  assert.equal(r.code, 0, r.err);
}

const client = () => new Tmux({ runner, socket: sock });
const names = async () => {
  const r = await client().list();
  assert.equal(r.kind, "ok");
  return r.kind === "ok" ? r.sessions.map((s) => s.name).sort() : [];
};

async function cli(...argv: string[]) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = "";
  let err = "";
  stdout.on("data", (c) => (out += c));
  stderr.on("data", (c) => (err += c));
  const code = await runCli(argv, { tmux: { runner, socket: sock }, stdout, stderr });
  return { code, out, err };
}

before(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ma-tmux-real-")));
  sock = path.join(dir, "sock");
});

after(() => {
  if (hasTmux) tmux("kill-server");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("real tmux: no server (no socket, no socket dir, stale socket) is an empty list", { skip }, async () => {
  assert.deepEqual(await client().list(), { kind: "none", reason: `No tmux server running (no socket at ${sock}).` });
  const missing = path.join(dir, "nope", "sock");
  assert.deepEqual(await new Tmux({ runner, socket: missing }).list(), {
    kind: "none",
    reason: `No tmux server has run for this user yet (${path.dirname(missing)} doesn't exist).`,
  });
  const stale = path.join(dir, "stale");
  fs.writeFileSync(stale, "");
  const r = await new Tmux({ runner, socket: stale }).list();
  assert.equal(r.kind, "none");
  const c = await cli("list");
  assert.deepEqual([c.code, c.out], [0, `No tmux server running (no socket at ${sock}).\n`]);
});

test("real tmux: list-sessions output, names with spaces, quotes and unicode", { skip }, async () => {
  const nasty = `it's a "test" é🚀 $(x) \`y\``;
  newSession("my project");
  newSession(nasty);
  const r = await client().list();
  assert.equal(r.kind, "ok");
  if (r.kind !== "ok") return;
  const byName = new Map(r.sessions.map((s) => [s.name, s]));
  assert.ok(byName.has("my project"));
  assert.ok(byName.has(nasty), `unicode and quotes survive -u: ${[...byName.keys()].join(" | ")}`);
  const s = byName.get(nasty)!;
  assert.match(s.id, /^\$\d+$/);
  assert.equal(s.windows, 1);
  assert.equal(s.attached, 0);
  assert.ok(Math.abs(s.created - Date.now() / 1000) < 60);
  assert.ok(s.activity >= s.created);
  assert.ok(s.command.length > 0, "the active pane's command");
  assert.equal(s.path, dir);
  // The copied command, read by the shell, targets exactly that session.
  for (const name of ["my project", nasty]) {
    const argv = spawnSync("/bin/sh", ["-c", `set -- ${attachCommand(name)}; printf '%s\\0' "$@"`], { encoding: "utf8" }).stdout.split("\0").slice(0, -1);
    assert.deepEqual(argv.slice(0, 3), ["tmux", "attach", "-t"]);
    assert.equal(tmux("has-session", "-t", argv[3]!).code, 0, `has-session ${argv[3]}`);
  }
  const j = await cli("list", "--json");
  assert.equal(j.code, 0);
  assert.ok(JSON.parse(j.out).some((x: { name: string; attachCommand: string }) => x.name === nasty && x.attachCommand === attachCommand(nasty)));
  tmux("kill-session", "-t", "=my project");
  tmux("kill-session", "-t", `=${nasty}`);
});

test("real tmux: kill is an exact match, foo never kills foo2", { skip }, async () => {
  newSession("foo2");
  newSession("foobar");
  // no session "foo": a prefix match would hit foo2/foobar
  assert.equal((await cli("kill", "foo")).code, 1);
  await assert.rejects(client().kill("=foo"), { message: "That session doesn't exist anymore." });
  assert.deepEqual(await names(), ["foo2", "foobar"]);
  newSession("foo");
  const k = await cli("kill", "foo");
  assert.deepEqual([k.code, k.out], [0, "killed 'foo'\n"]);
  assert.deepEqual(await names(), ["foo2", "foobar"]);
  // by id too
  const r = await client().list();
  const id = r.kind === "ok" ? r.sessions.find((s) => s.name === "foobar")!.id : "";
  await client().kill(id);
  assert.deepEqual(await names(), ["foo2"]);
  tmux("kill-session", "-t", "=foo2");
});

test("real tmux: rename keeps the session id", { skip }, async () => {
  newSession("before");
  const r1 = await client().list();
  const id = r1.kind === "ok" ? r1.sessions.find((s) => s.name === "before")!.id : "";
  assert.equal(tmux("rename-session", "-t", "=before", "after rename").code, 0);
  const r2 = await client().list();
  assert.equal(r2.kind, "ok");
  if (r2.kind !== "ok") return;
  assert.deepEqual(
    r2.sessions.filter((s) => s.id === id).map((s) => s.name),
    ["after rename"],
  );
  const a = await cli("attach-cmd", "after rename");
  assert.deepEqual([a.code, a.out], [0, "tmux attach -t '=after rename'\n"]);
});

const sessionNamed = async (name: string) => {
  const r = await client().list();
  assert.equal(r.kind, "ok");
  return r.kind === "ok" ? r.sessions.find((s) => s.name === name) : undefined;
};

test("real tmux: one list-panes gives every window and pane; activity is the max across windows", { skip }, async () => {
  newSession("panes");
  assert.equal(tmux("new-window", "-t", "=panes:", "-c", dir).code, 0);
  assert.equal(tmux("split-window", "-t", "=panes:", "-c", dir).code, 0);
  const s = (await sessionNamed("panes"))!;
  assert.equal(s.windows, 2);
  assert.equal(s.panes.length, 3);
  assert.equal(s.panes.filter((p) => p.active).length, 1, "only the current window's active pane");
  for (const p of s.panes) {
    assert.match(p.id, /^%\d+$/);
    assert.ok(fs.existsSync(`/proc/${p.pid}`), "pane_pid is a real process");
    assert.ok(p.width > 0 && p.height > 0);
  }
  const raw = tmux("list-windows", "-t", "=panes", "-F", "#{window_activity}").out.trim().split("\n").map(Number);
  assert.equal(s.activity, Math.max(...raw));
  tmux("kill-session", "-t", "=panes");
});

test("real tmux: rename by id gives back the real name; awkward names; empty, taken and gone", { skip }, async () => {
  newSession("orig");
  newSession("taken_name");
  const { id } = (await sessionNamed("orig"))!;
  const c = client();
  assert.equal(await c.rename(id, "a.b:c"), "a_b_c", "tmux's own substitution comes back");
  assert.equal(await c.rename(id, "  my app; echo x  "), "my app; echo x");
  assert.equal(await c.rename(id, "-dash"), "-dash");
  assert.equal(await c.rename(id, "50% #S #{session_id} ##"), "50% #S #{session_id} ##", "no format expansion");
  assert.equal((await sessionNamed("50% #S #{session_id} ##"))?.id, id, "same session, and `list` agrees");
  await assert.rejects(c.rename(id, "   "), { message: "The name can't be empty." });
  await assert.rejects(c.rename(id, "taken.name"), { message: "There is already a session named 'taken_name'." });
  await assert.rejects(c.rename("$9999", "x"), { message: "That session doesn't exist anymore." });

  const ok = await cli("rename", "50% #S #{session_id} ##", "cli.name");
  assert.deepEqual([ok.code, ok.out], [0, "renamed '50% #S #{session_id} ##' to 'cli_name'\n"]);
  const dup = await cli("rename", "cli_name", "taken_name");
  assert.deepEqual([dup.code, dup.err], [1, "tmuxctl: There is already a session named 'taken_name'.\n"]);
  const none = await cli("rename", "nope", "x");
  assert.deepEqual([none.code, none.err], [1, "tmuxctl: no session named 'nope'\n"]);
  assert.equal((await cli("rename", "only-one")).code, 2);
  tmux("kill-session", "-t", "=cli_name");
  tmux("kill-session", "-t", "=taken_name");
});

test("real tmux: capture gives the active pane's screen, with colours, parsed into runs", { skip }, async () => {
  // The command itself, not typed at a shell: the user's shell may take seconds to start.
  assert.equal(tmux("new-session", "-d", "-s", "cap", "-x", "80", "-y", "24", `printf '\\033[31mred\\033[0m plain\\n'; sleep 60`).code, 0);
  const { id } = (await sessionNamed("cap"))!;
  let text = "";
  for (let i = 0; i < 300 && !text.includes("\x1b[31mred"); i++) {
    await new Promise((r) => setTimeout(r, 30));
    text = await client().capture(id);
  }
  assert.match(text, /\x1b\[31mred/);
  const runs = parseAnsi(text).flat();
  assert.deepEqual(runs.find((x) => x.text === "red"), { text: "red", fg: "#cd3131" });
  assert.ok(runs.every((x) => !x.text.includes("\x1b")));
  await assert.rejects(client().capture("$9999"), { message: "That session doesn't exist anymore." });
  tmux("kill-session", "-t", "=cap");
});

test("launch: the name reaches the program as one argument; a failure says why; a stub stands in for terminator", { skip }, async () => {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const log = path.join(dir, "argv.log");
  fs.writeFileSync(path.join(bin, "terminator"), `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> '${log}'; done\nprintf 'TMUX=%s\\n' "$TMUX" >> '${log}'\nsleep 2\n`, { mode: 0o755 });
  const env = { ...openEnv({ ...process.env, TMUX: "x,1,0", TMUX_PANE: "%1" }), PATH: `${bin}:${process.env.PATH}` };
  const name = "my app; echo x";
  await launch(openArgv(client().attachArgv(name), {}), env);
  assert.deepEqual(fs.readFileSync(log, "utf8").trim().split("\n"), ["--no-dbus", "-x", "tmux", "-u", "-S", sock, "attach-session", "-t", `=${name}`, "TMUX="]);

  fs.writeFileSync(path.join(bin, "terminator"), "#!/bin/sh\nexit 3\n");
  await assert.rejects(launch(["terminator"], env), { message: "The terminal closed at once (exit code 3)." });
  await assert.rejects(launch(["no-such-terminal"], env), { message: "no-such-terminal isn't installed." });
});
