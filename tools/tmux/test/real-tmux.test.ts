// Against a real tmux (3.4 in the cloud container: `apt-get install tmux`), skipped without one.
// Every call uses a private socket (-S <tmpdir>/sock), never the default server, and the
// server is killed afterwards.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { runCli } from "../src/cli.ts";
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
