// inboxctl: output and exit codes, through a (fake) running core and directly on the files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { runCli } from "../src/cli.ts";
import type { CliIO } from "../src/cli.ts";
import type { CoreConnection } from "../src/coreClient.ts";
import { DEFAULTS } from "../src/limits.ts";
import { Store } from "../src/store.ts";
import { FakeTmux, claudePane, tmpDir } from "./fakes.ts";

const NOW = 1_700_000_000_000;

function fakeCore(state: Record<string, unknown>, actions: Record<string, (args: Record<string, unknown>) => unknown> = {}) {
  const calls: [string, Record<string, unknown>][] = [];
  let closed = false;
  const conn: CoreConnection = {
    state,
    async action(name, args = {}) {
      calls.push([name, args]);
      const f = actions[name];
      if (!f) throw new Error(`unknown action: ${name}`);
      return f(args);
    },
    close: () => void (closed = true),
  };
  return { conn, calls, closed: () => closed };
}

async function cli(argv: string[], over: Partial<CliIO> = {}) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = "";
  let err = "";
  stdout.on("data", (c) => (out += c));
  stderr.on("data", (c) => (err += c));
  const fake = new FakeTmux();
  fake.panes = [claudePane(0), claudePane(1, { command: "bash", session: "other" })];
  const io: CliIO = {
    stdout,
    stderr,
    env: { XDG_CONFIG_HOME: "/nonexistent" },
    stateDir: tmpDir("cli"),
    panes: { runner: fake, exists: () => true },
    connect: async () => undefined,
    now: () => NOW,
    ...over,
  };
  const code = await runCli(argv, io);
  return { code, out, err };
}

test("panes, directly: only Claude panes, with target, id, attached and path", async () => {
  const r = await cli(["panes"]);
  assert.equal(r.code, 0);
  assert.equal(r.out, "motherapp:0.0  %0    attached  /home/u/Desktop/projects/motherapp\n");
  const j = await cli(["panes", "--json"]);
  assert.deepEqual(JSON.parse(j.out), [{ id: "%0", target: "motherapp:0.0", path: "/home/u/Desktop/projects/motherapp", attached: "attached" }]);
});

test("links and log, directly on the files; revoke directly", async () => {
  const stateDir = tmpDir("cli-files");
  const s = new Store(stateDir);
  const { link } = s.create({ ...DEFAULTS, label: "cloud", pane: { id: "%0", target: "motherapp:0.0", pid: 1, path: "/p" }, host: "h" }, NOW);
  s.addDelivery({ time: NOW, linkId: link.id, label: "cloud", pane: "motherapp:0.0", text: "[inbox: cloud] hi", result: "submitted" });
  const l = await cli(["links"], { stateDir });
  assert.equal(l.code, 0);
  assert.equal(l.out, `${link.id}  …${link.last4}  cloud  → motherapp:0.0  expires in 24 h, used 0/20\n`);
  const log = await cli(["log"], { stateDir });
  assert.equal(log.out, `${new Date(NOW).toISOString()}  ${link.id} → motherapp:0.0  submitted\n    [inbox: cloud] hi\n`);
  assert.equal(JSON.parse((await cli(["log", "--json", "-n", "1"], { stateDir })).out).length, 1);
  const rv = await cli(["revoke", link.id], { stateDir });
  assert.deepEqual([rv.code, rv.out], [0, `revoked ${link.id}\n`]);
  assert.equal((await cli(["links"], { stateDir })).out, "No active links.\n");
  const again = await cli(["revoke", link.id], { stateDir });
  assert.deepEqual([again.code, again.err], [1, `inboxctl: no active link with id ${link.id}\n`]);
});

test("new: goes through the core, prints the link once on stdout; exit 1 without the core", async () => {
  const link = `https://h.trycloudflare.com/inbox/${"t".repeat(43)}`;
  const core = fakeCore({}, { create: () => ({ id: "ab12cd34", link, message: `${link}\nGET…`, expires: NOW + 3600_000 }) });
  const r = await cli(["new", "--pane", "motherapp:0.0", "--label", "cloud", "--expires=1h", "--max-uses", "5"], { connect: async () => core.conn, stdoutIsTTY: true });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, `${link}\n`);
  assert.ok(!r.err.includes(link), "printed once");
  assert.match(r.err, /won't be shown again/);
  assert.match(r.err, /GET this link first; it explains how to message me\./);
  assert.deepEqual(core.calls, [["create", { pane: "motherapp:0.0", label: "cloud", expires: "1h", maxUses: "5" }]]);
  assert.ok(core.closed());

  const none = await cli(["new", "--pane", "motherapp:0.0", "--label", "cloud"], { stdoutIsTTY: true });
  assert.equal(none.code, 1);
  assert.match(none.err, /motherapp isn't running/);
  assert.equal(none.out, "");

  const failing = fakeCore({}, { create: () => Promise.reject(new Error("pane motherapp:0.1 runs bash, not Claude")) });
  const f = await cli(["new", "--pane", "motherapp:0.1", "--label", "x"], { connect: async () => failing.conn, stdoutIsTTY: true });
  assert.deepEqual([f.code, f.err], [1, "inboxctl: pane motherapp:0.1 runs bash, not Claude\n"]);
});

test("new: refuses to print a link into captured output unless --print", async () => {
  const link = `https://h.trycloudflare.com/inbox/${"t".repeat(43)}`;
  const core = fakeCore({}, { create: () => ({ id: "ab12cd34", link, message: link, expires: NOW }) });
  const piped = await cli(["new", "--pane", "motherapp:0.0", "--label", "cloud"], { connect: async () => core.conn, stdoutIsTTY: false });
  assert.equal(piped.code, 2);
  assert.match(piped.err, /stdout isn't a terminal/);
  assert.equal(piped.out, "");
  assert.deepEqual(core.calls, [], "no link was made");
  const forced = await cli(["new", "--pane", "motherapp:0.0", "--label", "cloud", "--print"], { connect: async () => core.conn, stdoutIsTTY: false });
  assert.deepEqual([forced.code, forced.out], [0, `${link}\n`]);
});

test("links, panes and revoke through the core", async () => {
  const core = fakeCore(
    {
      panes: { "3": { id: "%3", target: "m:0.0", path: "~/p", attached: "detached" } },
      links: { ab: { id: "ab", label: "cloud", pane: "m:0.0", expires: NOW + 600_000, uses: 2, maxUses: 20, pending: 1, held: "Claude is working", last4: "wxyz" } },
    },
    { revoke: (a) => ({ id: a.id }) },
  );
  const connect = async () => core.conn;
  assert.equal((await cli(["links"], { connect })).out, "ab  …wxyz  cloud  → m:0.0  expires in 10 min, used 2/20, 1 pending (Claude is working)\n");
  assert.equal((await cli(["panes"], { connect })).out, "m:0.0  %3    detached  ~/p\n");
  assert.equal((await cli(["revoke", "ab"], { connect })).code, 0);
  assert.deepEqual(core.calls.at(-1), ["revoke", { id: "ab" }]);
});

test("usage errors exit 2; help exits 0", async () => {
  for (const argv of [[], ["frob"], ["new", "--label", "x"], ["new", "--pane", "m:0.0"], ["new", "--pane"], ["links", "--yaml"], ["revoke"], ["revoke", "a", "b"], ["log", "-n", "0"], ["panes", "extra"]]) {
    assert.equal((await cli(argv)).code, 2, argv.join(" "));
  }
  const h = await cli(["help"]);
  assert.equal(h.code, 0);
  assert.match(h.out, /inboxctl new --pane|new --pane/);
});
