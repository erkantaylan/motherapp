// readSnapshot against fixture trees (never the real /sys, except one shape-only check).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { ccxPerCcd, formatCpuList, parseCpuList, readSnapshot } from "../src/sysfs.ts";
import { intelHybrid, intelPlain, ryzen3900x, tempTree } from "./fixtures.ts";

test("cpu lists: parse the kernel's format, print with spaces", () => {
  assert.deepEqual(parseCpuList("0-2,12-14\n"), [0, 1, 2, 12, 13, 14]);
  assert.deepEqual(parseCpuList("5"), [5]);
  assert.deepEqual(parseCpuList("3,1,junk,2-2"), [1, 2, 3]);
  assert.deepEqual(parseCpuList(""), []);
  assert.equal(formatCpuList([0, 1, 2, 12, 13, 14]), "0-2, 12-14");
  assert.equal(formatCpuList([0, 1, 12, 13]), "0, 1, 12, 13");
  assert.equal(formatCpuList([7]), "7");
});

test("CCX per CCD: Zen 2 has two, Zen 3 and later one, others unknown", () => {
  assert.equal(ccxPerCcd("AuthenticAMD", 23), 2);
  assert.equal(ccxPerCcd("AuthenticAMD", 25), 1);
  assert.equal(ccxPerCcd("AuthenticAMD", 26), 1);
  assert.equal(ccxPerCcd("GenuineIntel", 6), undefined);
  assert.equal(ccxPerCcd(undefined, undefined), undefined);
});

test("3900X: four CCX from the L3 groups, CCD0 = CCX1+2, CCD1 = CCX3+4, threads and cpufreq", (t) => {
  const { root, cleanup } = tempTree();
  t.after(cleanup);
  const s = readSnapshot(root);
  assert.equal(s.model, "AMD Ryzen 9 3900X 12-Core Processor");
  assert.equal(s.family, 23);
  assert.equal(s.driver, "amd-pstate-epp");
  assert.equal(s.boost, true);
  assert.deepEqual(
    s.ccx.map((c) => [c.index, c.ccd, c.cpus.join(",")]),
    [
      [0, 0, "0,1,2,12,13,14"],
      [1, 0, "3,4,5,15,16,17"],
      [2, 1, "6,7,8,18,19,20"],
      [3, 1, "9,10,11,21,22,23"],
    ],
  );
  assert.equal(s.threads.length, 24);
  const t13 = s.threads.find((x) => x.cpu === 13)!;
  assert.deepEqual(t13, { cpu: 13, core: 1, ccx: 0, coreId: 1, curKHz: 4_090_000, minKHz: 1_727_728, maxKHz: 4_780_046, scalingMaxKHz: 4_780_046, governor: "performance", epp: "performance", rank: 216 });
  assert.deepEqual(s.problems, []);
});

test("sensors: found by hwmon name (not number), Tccd mapped to CCDs, -40 °C T_Sensor hidden", (t) => {
  const { root, cleanup } = tempTree(ryzen3900x({ hwmonOffset: 5 }));
  t.after(cleanup);
  const s = readSnapshot(root);
  assert.deepEqual(
    s.sensors.map((x) => [x.key, x.label, x.kind, x.value, x.ccd]),
    [
      ["k10temp-temp1", "Tctl", "temp", 56.25, undefined],
      ["k10temp-temp3", "Tccd1", "temp", 53.75, 0],
      ["k10temp-temp4", "Tccd2", "temp", 44.75, 1],
      ["asusec-temp1", "Chipset", "temp", 60, undefined],
      ["asusec-temp2", "CPU", "temp", 45, undefined],
      ["asusec-temp3", "Motherboard", "temp", 34, undefined],
      ["asusec-fan1", "Chipset", "fan", 2491, undefined],
    ],
  );
  assert.deepEqual(s.hidden, ["asusec T_Sensor (reads -40 °C: nothing plugged in)"]);
});

test("a plugged-in T_Sensor shows; an unreadable input is skipped", (t) => {
  const m = ryzen3900x();
  m.hwmon[2]!.files.temp4_input = "31000";
  m.hwmon[1]!.files.temp3_input = "garbage";
  const { root, cleanup } = tempTree(m);
  t.after(cleanup);
  const s = readSnapshot(root);
  assert.ok(s.sensors.some((x) => x.label === "T_Sensor" && x.value === 31));
  assert.ok(!s.sensors.some((x) => x.label === "Tccd1"));
  assert.deepEqual(s.hidden, []);
});

test("Zen 3 (family 25): one CCX per CCD; Intel: no CCD at all", (t) => {
  const zen3 = tempTree(ryzen3900x({ family: 25, ccx: [[0, 1, 2, 3, 4, 5, 6, 7, 16, 17, 18, 19, 20, 21, 22, 23], [8, 9, 10, 11, 12, 13, 14, 15, 24, 25, 26, 27, 28, 29, 30, 31]], siblings: (c) => [c % 16, (c % 16) + 16] }));
  t.after(zen3.cleanup);
  assert.deepEqual(readSnapshot(zen3.root).ccx.map((c) => c.ccd), [0, 1]);
  const intel = tempTree(ryzen3900x({ vendor: "GenuineIntel", family: 6 }));
  t.after(intel.cleanup);
  assert.deepEqual(readSnapshot(intel.root).ccx.map((c) => c.ccd), [undefined, undefined, undefined, undefined]);
});

test("no global boost file: falls back to the per-policy one; no cache info: one group", (t) => {
  const { root, cleanup } = tempTree(ryzen3900x({ boost: null }));
  t.after(cleanup);
  fs.writeFileSync(path.join(root, "sys/devices/system/cpu/cpu0/cpufreq/boost"), "0\n");
  for (let c = 0; c < 24; c++) fs.rmSync(path.join(root, `sys/devices/system/cpu/cpu${c}/cache`), { recursive: true });
  const s = readSnapshot(root);
  assert.equal(s.boost, false);
  assert.equal(s.ccx.length, 1);
  assert.equal(s.ccx[0]!.cpus.length, 24);
});

test("no cpufreq and an empty root: problems, not exceptions", (t) => {
  const noFreq = tempTree(ryzen3900x({ freqKHz: () => undefined }));
  t.after(noFreq.cleanup);
  const s = readSnapshot(noFreq.root);
  assert.equal(s.threads.length, 24);
  assert.match(s.problems[0]!, /No CPU frequencies/);
  assert.equal(s.driver, undefined);
  const empty = readSnapshot(path.join(noFreq.root, "nothing-here"));
  assert.equal(empty.threads.length, 0);
  assert.equal(empty.model, "Unknown CPU");
  assert.match(empty.problems[0]!, /Can't list the CPUs/);
});

test("the real /sys (read-only): right shape on any machine, CCX rows cover every thread", () => {
  const s = readSnapshot("/");
  assert.equal(typeof s.model, "string");
  assert.ok(Array.isArray(s.threads) && Array.isArray(s.ccx) && Array.isArray(s.sensors));
  const covered = s.ccx.flatMap((c) => c.cpus).sort((a, b) => a - b);
  assert.deepEqual(covered, s.threads.map((x) => x.cpu).sort((a, b) => a - b));
  for (const x of s.sensors) assert.ok(Number.isFinite(x.value) && !x.key.includes("."));
});

test("Intel hybrid: P-/E-cores from cpu_core/cpu_atom, coretemp sensors, boost from intel_pstate/no_turbo", () => {
  const { root, cleanup } = tempTree(intelHybrid());
  try {
    const s = readSnapshot(root);
    assert.equal(s.vendor, "GenuineIntel");
    assert.equal(s.boost, true);
    assert.deepEqual([s.threads[0]!.kind, s.threads[15]!.kind, s.threads[16]!.kind], ["P", "P", "E"]);
    assert.deepEqual(s.threads[3]!.core, 2, "siblings 2 and 3");
    const pkg = s.sensors.find((x) => x.label === "Package id 0")!;
    assert.equal(pkg.chip, "coretemp");
    assert.equal(pkg.coreId, undefined);
    assert.equal(s.sensors.find((x) => x.label === "Core 33")!.coreId, 33);
    assert.equal(s.ccx.length, 1);
    assert.equal(s.ccx[0]!.ccd, undefined);
  } finally {
    cleanup();
  }
  const plain = tempTree(intelPlain());
  try {
    const s = readSnapshot(plain.root);
    assert.equal(s.boost, false, "no_turbo 1");
    assert.ok(s.threads.every((t) => t.kind === undefined), "no PMU dirs: not hybrid");
  } finally {
    plain.cleanup();
  }
});
