// tmuxctl subcommands against a fake tmux: output and exit codes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { runCli } from "../src/cli.ts";
import type { FakeServer } from "./fakes.ts";
import { FakeTmux, session } from "./fakes.ts";

const NOW = 1_700_000_000_000;

async function cli(server: FakeServer, ...argv: string[]) {
  const fake = new FakeTmux();
  fake.server = server;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = "";
  let err = "";
  stdout.on("data", (c) => (out += c));
  stderr.on("data", (c) => (err += c));
  const code = await runCli(argv, { tmux: { runner: fake, defaultSocket: fake.socket, exists: () => true }, stdout, stderr, now: () => NOW });
  return { code, out, err, lines: fake.lines(), server: fake.server };
}

const two = (): FakeServer => ({
  sessions: [
    session(0, "work", { windows: 3, attached: 1, created: 1_700_000_000 - 7200, activity: 1_700_000_000 - 30 }),
    session(1, "a b", { created: 1_700_000_000 - 600, activity: 1_700_000_000 - 120 }),
  ],
});

test("list: sorted by name, windows, attached, relative times", async () => {
  const r = await cli(two(), "list");
  assert.equal(r.code, 0);
  assert.equal(
    r.out,
    [
      "a b   1 window    detached                created 10 min ago, active 2 min ago",
      "work  3 windows   attached (1 client)     created 2 h ago, active just now",
      "",
    ].join("\n"),
  );
});

test("list reads tmux itself every time (the serve process polls only while its page is watched)", async () => {
  const r = await cli(two(), "list");
  assert.equal(r.lines.length, 1);
  assert.match(r.lines[0]!, /^list-sessions -F /);
});

test("list --json: raw fields plus the attach command", async () => {
  const r = await cli(two(), "list", "--json");
  assert.equal(r.code, 0);
  const j = JSON.parse(r.out);
  assert.equal(j.length, 2);
  assert.deepEqual(j[1], { ...session(1, "a b", { created: 1_700_000_000 - 600, activity: 1_700_000_000 - 120 }), attachCommand: "tmux attach -t '=a b'" });
});

test("list: no server is exit 0 with an empty list", async () => {
  const r = await cli({ noServer: "stale-socket" }, "list");
  assert.deepEqual([r.code, r.out], [0, "No tmux server running on /tmp/tmux-1000/default.\n"]);
  const j = await cli({ noServer: "no-socket" }, "list", "--json");
  assert.deepEqual([j.code, JSON.parse(j.out)], [0, []]);
  const e = await cli({ sessions: [] }, "list");
  assert.deepEqual([e.code, e.out], [0, "No tmux sessions.\n"]);
});

test("list: tmux errors are exit 1, bad options exit 2", async () => {
  const r = await cli({ fail: "error connecting to /tmp/tmux-1000/default (Permission denied)" }, "list");
  assert.equal(r.code, 1);
  assert.equal(r.err, "tmuxctl: Can't connect to the tmux server at /tmp/tmux-1000/default: Permission denied\n");
  assert.equal((await cli({ missing: true }, "list")).code, 1);
  assert.equal((await cli(two(), "list", "--yaml")).code, 2);
});

test("attach-cmd: exact name, quoted; unknown name exit 1", async () => {
  const r = await cli({ sessions: [session(0, "it's here"), session(1, "it")] }, "attach-cmd", "it");
  assert.deepEqual([r.code, r.out], [0, "tmux attach -t '=it'\n"]);
  const q = await cli({ sessions: [session(0, "it's here")] }, "attach-cmd", "it's here");
  assert.equal(q.out, "tmux attach -t '=it'\\''s here'\n");
  const none = await cli({ sessions: [session(0, "foo2")] }, "attach-cmd", "foo");
  assert.deepEqual([none.code, none.err], [1, "tmuxctl: no session named 'foo'\n"]);
  const noServer = await cli({ noServer: "stale-socket" }, "attach-cmd", "foo");
  assert.equal(noServer.code, 1);
  assert.equal((await cli(two(), "attach-cmd")).code, 2);
  assert.equal((await cli(two(), "attach-cmd", "a", "b")).code, 2);
});

test("kill: exact match (=name), so foo doesn't kill foo2", async () => {
  const r = await cli({ sessions: [session(0, "foo2"), session(1, "foo")] }, "kill", "foo");
  assert.equal(r.code, 0);
  assert.equal(r.out, "killed 'foo'\n");
  assert.deepEqual(r.lines, ["kill-session -t =foo"]);
  assert.deepEqual("sessions" in r.server && r.server.sessions.map((s) => s.name), ["foo2"]);
  const miss = await cli({ sessions: [session(0, "foo2")] }, "kill", "foo");
  assert.deepEqual([miss.code, miss.err], [1, "tmuxctl: no session named 'foo'\n"]);
  assert.equal((await cli(two(), "kill")).code, 2);
});

test("help and unknown commands", async () => {
  assert.equal((await cli(two(), "help")).code, 0);
  assert.equal((await cli(two())).code, 2);
  const u = await cli(two(), "frobnicate");
  assert.equal(u.code, 2);
  assert.match(u.err, /unknown command "frobnicate"/);
});
