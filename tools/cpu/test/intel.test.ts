// Intel limits against fixture trees: reading, validation, writing (raw values, order, only
// what differs, no access), the stock snapshot, profiles in cpu.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  access,
  applyLimits,
  applyProfile,
  defaultIntelSettings,
  drift,
  ensureStock,
  formatIntelSettings,
  intelProfilesState,
  limitsState,
  loadIntelSettings,
  loadStock,
  parseIntelSettings,
  parseLimits,
  readLimits,
  targetOf,
  thermaldRunning,
  updateIntelSettings,
} from "../src/intel.ts";
import { intelHybrid, intelPlain, readFile, ryzen3900x, tempTree } from "./fixtures.ts";

const CPU = "sys/devices/system/cpu";
const PL1 = "sys/class/powercap/intel-rapl:0/constraint_0_power_limit_uw";
const PL2 = "sys/class/powercap/intel-rapl:0/constraint_1_power_limit_uw";
const isRoot = process.getuid?.() === 0;

function tree(t: { after: (fn: () => void) => void }, m = intelHybrid()) {
  const tr = tempTree(m);
  t.after(tr.cleanup);
  return tr.root;
}

test("readLimits: an Intel hybrid's caps per core type, turbo, governor, EPP, PL1/PL2", (t) => {
  const hw = readLimits(tree(t));
  assert.equal(hw.hybrid, true);
  assert.deepEqual(hw.current, { maxMHz: 5200, eMaxMHz: 3900, turbo: true, governor: "powersave", epp: "balance_performance", pl1W: 241, pl2W: 241 });
  assert.deepEqual(hw.range, { maxMHz: [800, 5200], eMaxMHz: [800, 3900] });
  assert.deepEqual(hw.governors, ["performance", "powersave"]);
  assert.equal(hw.files.maxMHz.length, 16);
  assert.equal(hw.files.eMaxMHz.length, 8);
  assert.deepEqual(hw.files.pl1W, [PL1], "the package zone only, not the core subzone");
  assert.deepEqual(hw.files.turbo, [`${CPU}/intel_pstate/no_turbo`]);
  assert.equal(access(hw), "full", "fixture files belong to the test user");
});

test("readLimits: a plain Intel has one cap for all cores; a Ryzen has no PL and turbo from cpufreq/boost", (t) => {
  const plain = readLimits(tree(t, intelPlain()));
  assert.equal(plain.hybrid, false);
  assert.equal(plain.current.eMaxMHz, undefined);
  assert.equal(plain.files.maxMHz.length, 6);
  assert.equal(plain.current.turbo, false, "no_turbo 1");
  const amd = readLimits(tree(t, ryzen3900x()));
  assert.equal(amd.current.turbo, true);
  assert.deepEqual(amd.files.turbo, [`${CPU}/cpufreq/boost`]);
  assert.deepEqual(amd.files.pl1W, []);
  assert.equal(amd.current.pl1W, undefined);
});

test("parseLimits: ranges, PL1 above PL2, EPP that needs powersave, null = stock", () => {
  const problems: string[] = [];
  const l = parseLimits({ maxMHz: 4500, eMaxMHz: 99, pl1W: 125, pl2W: 188, turbo: false, governor: "powersave", epp: "power", pl3: 1, epp2: null }, problems);
  assert.deepEqual(l, { maxMHz: 4500, pl1W: 125, pl2W: 188, turbo: false, governor: "powersave", epp: "power" });
  assert.deepEqual(problems, ['"eMaxMHz" must be null or whole MHz (400-7000)']);

  const p2: string[] = [];
  assert.deepEqual(parseLimits({ pl1W: 200, pl2W: 150, governor: "performance", epp: "power", turbo: "yes", maxMHz: null }, p2, '"x": '), { governor: "performance" });
  assert.deepEqual(p2, [
    '"x": "pl1W" (200 W) can\'t be above "pl2W" (150 W)',
    '"x": "turbo" must be null, true or false',
    '"x": "epp" power needs the powersave governor (the performance governor always uses EPP performance)',
  ]);
});

test("applyLimits: raw kernel units, only what differs, read back", (t) => {
  const root = tree(t);
  const r = applyLimits(root, { maxMHz: 4500, eMaxMHz: 3900, turbo: false, pl1W: 125, pl2W: 188, governor: "powersave", epp: "power" });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.changed, [
    "Turbo on → off",
    "EPP balance_performance → power",
    "P-core clock cap 5200 MHz → 4500 MHz",
    "PL1 (long-term power) 241 W → 125 W",
    "PL2 (short-term power) 241 W → 188 W",
  ]);
  assert.equal(readFile(root, `${CPU}/intel_pstate/no_turbo`), "1");
  assert.equal(readFile(root, `${CPU}/cpu0/cpufreq/scaling_max_freq`), "4500000");
  assert.equal(readFile(root, `${CPU}/cpu15/cpufreq/scaling_max_freq`), "4500000");
  assert.equal(readFile(root, `${CPU}/cpu16/cpufreq/scaling_max_freq`), "3900000", "E-cores untouched");
  assert.equal(readFile(root, PL1), "125000000");
  assert.equal(readFile(root, PL2), "188000000");
  assert.equal(readFile(root, "sys/class/powercap/intel-rapl:0:0/constraint_0_power_limit_uw"), "0", "core subzone untouched");
  assert.equal(readFile(root, "sys/class/powercap/intel-rapl:0/constraint_2_power_limit_uw"), "380000000", "peak_power untouched");
  assert.deepEqual(applyLimits(root, { pl1W: 125 }), { changed: [], problems: [] }, "already there: nothing written");
});

test("applyLimits: both package zones (MSR and MMIO) get the power limits", (t) => {
  const root = tree(t, intelHybrid({ rapl: { pl1W: 253, pl2W: 253, mmio: true } }));
  applyLimits(root, { pl1W: 150, pl2W: 200 });
  assert.equal(readFile(root, "sys/class/powercap/intel-rapl-mmio:0/constraint_0_power_limit_uw"), "150000000");
  assert.equal(readFile(root, "sys/class/powercap/intel-rapl-mmio:0/constraint_1_power_limit_uw"), "200000000");
});

test("applyLimits: EPP under the performance governor is skipped and said so", (t) => {
  const root = tree(t, intelHybrid({ governor: "performance", epp: "performance" }));
  const r = applyLimits(root, { epp: "power" });
  assert.deepEqual(r.changed, []);
  assert.deepEqual(r.problems, ["EPP power needs the powersave governor; left at performance."]);
  // switching the governor in the same step makes it possible
  const r2 = applyLimits(root, { governor: "powersave", epp: "power" });
  assert.deepEqual(r2.problems, []);
  assert.equal(readFile(root, `${CPU}/cpu3/cpufreq/scaling_governor`), "powersave");
  assert.equal(readFile(root, `${CPU}/cpu3/cpufreq/energy_performance_preference`), "power");
});

test("applyLimits: no write access is one message naming the settings, and how to get access", { skip: isRoot && "root can write anything" }, (t) => {
  const root = tree(t);
  fs.chmodSync(path.join(root, PL1), 0o444);
  fs.chmodSync(path.join(root, PL2), 0o444);
  assert.equal(access(readLimits(root)), "partial");
  const r = applyLimits(root, { pl1W: 125, pl2W: 188, turbo: false });
  assert.deepEqual(r.changed, ["Turbo on → off"]);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0]!, /^Not allowed to change PL1 \(long-term power\), PL2 \(short-term power\)\. .*`motherapp install`.*"CPU limits"/);
  assert.equal(readFile(root, PL1), "241000000");
});

test("stock: snapshotted before the first change of a boot, kept for that boot, retaken on the next", (t) => {
  const root = tree(t);
  const file = path.join(root, "state", "cpu-stock.json");
  const s = defaultIntelSettings();
  assert.equal(loadStock(file, "boot-1"), undefined);

  const a = applyProfile(root, file, s, "underclock", 1000);
  assert.equal(a.name, "Underclock");
  assert.deepEqual(a.changed, ["PL1 (long-term power) 241 W → 125 W", "PL2 (short-term power) 241 W → 188 W"]);
  assert.deepEqual(loadStock(file, "boot-1")?.values.pl1W, 241);

  // a second apply in the same boot keeps the original snapshot
  applyProfile(root, file, s, "underclock", 2000);
  assert.equal(loadStock(file, "boot-1")?.takenAt, 1000);

  const back = applyProfile(root, file, s, null);
  assert.equal(back.name, "Stock");
  assert.equal(readFile(root, PL1), "241000000");
  assert.equal(readFile(root, PL2), "241000000");

  assert.equal(loadStock(file, "boot-2"), undefined, "another boot: the old snapshot doesn't count");
  const hw = readLimits(root);
  assert.equal(ensureStock(file, "boot-2", hw, 3000).takenAt, 3000);
});

test("targetOf: stock for what a profile doesn't set; turbo off drops the stock caps; drift", (t) => {
  const root = tree(t);
  const hw = readLimits(root);
  const stock = hw.current;
  assert.deepEqual(targetOf(stock, { pl1W: 125 }, hw), { ...stock, pl1W: 125 });
  assert.deepEqual(targetOf(stock, { turbo: false }, hw), { turbo: false, governor: "powersave", epp: "balance_performance", pl1W: 241, pl2W: 241 });
  assert.deepEqual(targetOf(stock, { governor: "performance" }, hw).epp, undefined);
  fs.writeFileSync(path.join(root, PL1), "200000000");
  assert.deepEqual(drift(targetOf(stock, { pl1W: 125 }, hw), readLimits(root)), ["PL1 (long-term power) 200 W (wanted 125 W)"]);
});

test("cpu.json (Intel): defaults, parsing, problems, broken files are never written over", (t) => {
  const root = tree(t);
  const file = path.join(root, "config", "cpu.json");
  const created = loadIntelSettings(file, { create: true });
  assert.equal(created.created, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
    version: 1,
    active: null,
    applyOnStart: true,
    profiles: { underclock: { name: "Underclock", pl1W: 125, pl2W: 188 }, overclock: { name: "Overclock" } },
  });
  assert.equal(formatIntelSettings(created.settings), fs.readFileSync(file, "utf8"));

  const { settings, problems } = parseIntelSettings({ active: "turbo", profiles: { overclock: { name: " Fast ", pl1W: 4095, turbo: true }, extra: {} } });
  assert.equal(settings.active, null);
  assert.deepEqual(settings.profiles[1], { id: "overclock", name: "Fast", pl1W: 4095, turbo: true });
  assert.deepEqual(problems, ['profile "extra" ignored: only "underclock" and "overclock" exist', '"active" must be "underclock", "overclock" or null; treated as null']);

  const s = updateIntelSettings(file, (x) => (x.active = "underclock"));
  assert.equal(s.active, "underclock");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).active, "underclock");

  fs.writeFileSync(file, "{ nope");
  assert.equal(loadIntelSettings(file).broken, true);
  assert.throws(() => updateIntelSettings(file, (x) => (x.active = null)), /isn't valid JSON/);
  assert.equal(fs.readFileSync(file, "utf8"), "{ nope");
});

test("page state: limits rows (now, stock, range, writable) and the profiles", (t) => {
  const root = tree(t);
  const hw = readLimits(root);
  const st = limitsState(hw, undefined, undefined) as any;
  assert.equal(st.supported, true);
  assert.equal(st.access, "full");
  assert.equal(st.accessText, undefined);
  assert.equal(st.stockFrom, "now");
  assert.deepEqual(Object.keys(st.rows), ["maxMHz", "eMaxMHz", "turbo", "governor", "epp", "pl1W", "pl2W"]);
  assert.deepEqual(st.rows.pl1W, { order: 5, label: "PL1 (long-term power)", writable: true, now: 241, stock: 241, min: 10, max: 4095 });
  assert.deepEqual(st.rows.eMaxMHz, { order: 1, label: "E-core clock cap", writable: true, now: 3900, stock: 3900, min: 800, max: 3900 });
  const ps = intelProfilesState(defaultIntelSettings(), "/x/cpu.json", [], true) as any;
  assert.deepEqual(ps.list.underclock, { order: 0, name: "Underclock", values: { pl1W: 125, pl2W: 188 }, detail: "PL1 125 W · PL2 188 W" });
  assert.deepEqual(ps.list.overclock.values, {});
  assert.equal(ps.kind, "limits");
  assert.equal(ps.active, undefined);
});

test("thermald: found by /proc/<pid>/comm; the page state says PL1 won't stick", (t) => {
  const root = tree(t);
  assert.equal(thermaldRunning(root), false);
  fs.mkdirSync(path.join(root, "proc", "4242"), { recursive: true });
  fs.writeFileSync(path.join(root, "proc", "4242", "comm"), "thermald\n");
  assert.equal(thermaldRunning(root), true);
  const st = limitsState(readLimits(root), undefined, undefined, true) as any;
  assert.match(st.thermaldText, /^thermald is running: .* rewrites PL1/);
  assert.equal((limitsState(readLimits(root), undefined, undefined, false) as any).thermaldText, undefined);
});
