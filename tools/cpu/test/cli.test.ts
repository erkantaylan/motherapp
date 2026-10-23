// cpuctl subcommands against fixture trees: output, JSON and exit codes.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { runCli } from "../src/cli.ts";
import { intelHybrid, setFreq, tempTree } from "./fixtures.ts";

async function cli(root: string, ...argv: string[]) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = "";
  let err = "";
  stdout.on("data", (c) => (out += c));
  stderr.on("data", (c) => (err += c));
  const settingsFile = path.join(root, "config", "motherapp", "cpu.json");
  const stockFile = path.join(root, "state", "motherapp", "cpu-stock.json");
  const code = await runCli(argv, { root, settingsFile, stockFile, stdout, stderr });
  return { code, out, err, settingsFile };
}

test("status: reads sysfs fresh on every call", async (t) => {
  const { root, cleanup } = tempTree();
  t.after(cleanup);
  const a = await cli(root, "status");
  assert.equal(a.code, 0);
  assert.match(a.out, /^AMD Ryzen 9 3900X 12-Core Processor\n/);
  assert.match(a.out, /CCX1 \(CCD0\) {3}avg 4095 MHz {2}max 4100 MHz/);
  setFreq(root, 0, 4_300_000);
  const b = await cli(root, "status");
  assert.match(b.out, /CCX1 \(CCD0\) {3}avg 4128 MHz {2}max 4300 MHz/);
});

test("status --json: the full report", async (t) => {
  const { root, cleanup } = tempTree();
  t.after(cleanup);
  const r = await cli(root, "status", "--json");
  assert.equal(r.code, 0);
  const j = JSON.parse(r.out);
  assert.equal(j.driver, "amd-pstate-epp");
  assert.equal(j.boost, true);
  assert.equal(j.ccx.length, 4);
  assert.deepEqual(j.ccx[3], { name: "CCX4", index: 3, ccd: 1, cpus: [9, 10, 11, 21, 22, 23], cores: [9, 10, 11], slots: 4, avgMHz: 4245, maxMHz: 4250, fastCore: 9, temp: { label: "Tccd2", value: 44.75 } });
  assert.equal(j.coreList.length, 12);
  assert.deepEqual(j.notAvailable, ["Vcore", "package power (PPT)", "SMU overclocking mode"]);
});

test("status: nothing readable is exit 1, bad options exit 2", async (t) => {
  const { root, cleanup } = tempTree();
  t.after(cleanup);
  const none = await cli(path.join(root, "missing"), "status");
  assert.equal(none.code, 1);
  assert.match(none.out, /! Can't list the CPUs/);
  assert.equal((await cli(root, "status", "--yaml")).code, 2);
});

test("profiles: creates cpu.json with the defaults, text and JSON", async (t) => {
  const { root, cleanup } = tempTree();
  t.after(cleanup);
  const r = await cli(root, "profiles");
  assert.equal(r.code, 0);
  assert.ok(fs.existsSync(r.settingsFile));
  assert.match(r.out, /underclock {2}Underclock\n {4}values not set yet/);
  assert.match(r.out, /CCX4 4100 MHz\n {4}Vcore 1\.250 V/);
  assert.match(r.out, /Active profile: none \(stock settings, nothing applied\)\.\nApplying profiles isn't available yet\.\n$/);
  const j = JSON.parse((await cli(root, "profiles", "--json")).out);
  assert.equal(j.file, r.settingsFile);
  assert.equal(j.active, null);
  assert.equal(j.applyOnStart, true);
  assert.equal(j.applyAvailable, false);
  assert.deepEqual(j.profiles.underclock, { name: "Underclock", ccx: null, vcore: null });
  assert.deepEqual(j.profiles.overclock.ccx, [4250, 4250, 4125, 4100]);
});

test("help and unknown commands", async (t) => {
  const { root, cleanup } = tempTree();
  t.after(cleanup);
  assert.equal((await cli(root, "help")).code, 0);
  assert.equal((await cli(root)).code, 2);
  const u = await cli(root, "apply", "overclock");
  assert.equal(u.code, 2);
  assert.match(u.err, /unknown command "apply"/);
});

test("Intel: status works, profiles creates cpu.json with the Intel defaults", async (t) => {
  const { root, cleanup } = tempTree(intelHybrid());
  t.after(cleanup);
  const s = await cli(root, "status");
  assert.equal(s.code, 0);
  assert.match(s.out, /^12th Gen Intel\(R\) Core\(TM\) i9-12900K\n16 cores \/ 24 threads · intel_pstate · governor powersave · EPP balance_performance · boost on, up to 5200 MHz\n/);
  assert.match(s.out, /\nL3 group 1 {4}avg/);
  const p = await cli(root, "profiles");
  assert.equal(p.code, 0);
  assert.match(p.out, /\nunderclock  Underclock\n    PL1 \(long-term power\): 125 W\n    PL2 \(short-term power\): 188 W\n\noverclock   Overclock\n    nothing set yet \(all stock\)\n/);
  assert.equal(JSON.parse(fs.readFileSync(p.settingsFile, "utf8")).profiles.underclock.pl1W, 125);
  const j = JSON.parse((await cli(root, "profiles", "--json")).out);
  assert.deepEqual(j.profiles.underclock, { name: "Underclock", pl1W: 125, pl2W: 188 });
  assert.equal(j.active, null);
});

test("Intel: limits shows now / stock / writable; use applies and makes it active", async (t) => {
  const { root, cleanup } = tempTree(intelHybrid());
  t.after(cleanup);
  const l = await cli(root, "limits");
  assert.equal(l.code, 0);
  assert.match(l.out, /\nPL1 \(long-term power\) +241 W +241 W +yes\n/);
  assert.match(l.out, /motherapp hasn't changed anything this boot: stock = now\./);
  const u = await cli(root, "use", "underclock");
  assert.equal(u.code, 0, u.err);
  assert.equal(u.out, "PL1 (long-term power) 241 W → 125 W\nPL2 (short-term power) 241 W → 188 W\nActive profile: Underclock.\n");
  assert.equal(JSON.parse(fs.readFileSync(u.settingsFile, "utf8")).active, "underclock");
  const lj = JSON.parse((await cli(root, "limits", "--json")).out);
  assert.equal(lj.current.pl1W, 125);
  assert.equal(lj.stock.pl1W, 241);
  assert.equal(lj.stockFrom, "snapshot");
  const o = await cli(root, "use", "overclock");
  assert.equal(o.code, 1);
  assert.match(o.err, /Overclock has nothing set yet/);
  assert.equal((await cli(root, "use", "fast")).code, 2);
  const back = await cli(root, "use", "stock");
  assert.equal(back.code, 0);
  assert.match(back.out, /125 W → 241 W/);
});

test("AMD: limits and use say Intel only", async (t) => {
  const { root, cleanup } = tempTree();
  t.after(cleanup);
  const r = await cli(root, "use", "stock");
  assert.equal(r.code, 1);
  assert.match(r.err, /Intel CPUs only/);
});
