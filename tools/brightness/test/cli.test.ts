// `brightctl` subcommands in direct mode (no core) against a fake backend, plus usage errors.
// The path through a running core is covered by e2e.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { runCli } from "../src/cli.ts";
import { ACER_KEY, FakeBackend, ACER, MSI } from "./fakes.ts";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ma-brightctl-"));
process.env.XDG_STATE_HOME = stateDir; // readPersistedState in direct mode
process.on("exit", () => fs.rmSync(stateDir, { recursive: true, force: true }));

async function cli(argv: string[], backend = new FakeBackend({ info: MSI, value: 48 }, { info: ACER, value: 52 }), env: NodeJS.ProcessEnv = {}) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = "";
  let err = "";
  stdout.on("data", (c) => (out += String(c)));
  stderr.on("data", (c) => (err += String(c)));
  const code = await runCli(argv, { stdout, stderr, env, backend: async () => ({ backend }) });
  return { code, out, err, backend };
}

test("usage", async () => {
  let r = await cli([]);
  assert.equal(r.code, 2);
  assert.match(r.err, /^usage: brightctl/);
  r = await cli(["help"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /set <monitor\|all> <value>/);
  r = await cli(["frobnicate"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /unknown command "frobnicate"/);
  r = await cli(["set", "all"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /missing monitor \(or all\) and value/);
  r = await cli(["set", "all", "150", "--direct"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /brightness must be 0-100/);
  assert.deepEqual(r.backend.calls, [], "a bad value fails before touching any monitor");
});

test("list, list --json", async () => {
  let r = await cli(["list", "--direct"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, "Acer X34 P   DP-2   52%\nMSI G274QPF  DP-1   48%\n");
  r = await cli(["list", "--json", "--direct"]);
  const rows = JSON.parse(r.out) as { id: string; brightness: number; connector: string; stale: boolean }[];
  assert.deepEqual(rows.map((x) => [x.id, x.connector, x.brightness, x.stale]), [
    [ACER_KEY, "DP-2", 52, false],
    ["MSI-MSI_G274QPF-CC2H683C00058", "DP-1", 48, false],
  ]);
});

test("get prints the percent", async () => {
  const r = await cli(["get", "dp-2", "--direct"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, "52\n");
});

test("set: all relative, one absolute; reads first so the step starts from the real value", async () => {
  let r = await cli(["set", "all", "+10", "--direct"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, "Acer X34 P: 62%\nMSI G274QPF: 58%\n");
  assert.deepEqual(r.backend.calls.filter((c) => !c.startsWith("detect")).sort(), ["close", "read 1", "read 3", "write 1 58", "write 3 62"]);
  r = await cli(["set", "msi", "5", "--direct"]);
  assert.equal(r.out, "MSI G274QPF: 5%\n");
  assert.equal(r.backend.mon(1).value, 5);
});

test("errors: unknown monitor, monitor that doesn't answer, no monitors", async () => {
  let r = await cli(["set", "dell", "10", "--direct"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /^brightctl: no monitor matches "dell"/);
  const b = new FakeBackend({ info: MSI, value: 48 });
  b.mon(1).off = true;
  r = await cli(["set", "DP-1", "10", "--direct"], b);
  assert.equal(r.code, 1);
  assert.equal(r.err, "brightctl: MSI G274QPF: no answer over DDC/CI, is it switched on?\n");
  r = await cli(["list", "--direct"], new FakeBackend());
  assert.equal(r.code, 1);
  assert.match(r.err, /No monitors with DDC\/CI found/);
});

test("without --direct and no core listening, it talks to the monitors itself", async () => {
  const r = await cli(["get", "acer"], undefined, { MOTHERAPP_PORT: "1" });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, "52\n");
});
