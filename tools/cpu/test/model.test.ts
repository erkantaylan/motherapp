// Report, page state and the CLI text, from fixture snapshots.
import { test } from "node:test";
import assert from "node:assert/strict";
import { activeLine, buildReport, formatProfiles, formatStatus, NOT_SET, polledState, profilesState, summaryLine, toolTitle, tuningSupported } from "../src/model.ts";
import { defaultSettings } from "../src/settings.ts";
import { readSnapshot } from "../src/sysfs.ts";
import { intelHybrid, intelPlain, ryzen3600, ryzen3900x, tempTree } from "./fixtures.ts";

function report(m = ryzen3900x()) {
  const { root, cleanup } = tempTree(m);
  try {
    return buildReport(readSnapshot(root));
  } finally {
    cleanup();
  }
}

test("report: per-CCX average and max, CCD temperature from Tccd1/Tccd2", () => {
  const r = report();
  assert.equal(r.cores, 12);
  assert.equal(r.threads, 24);
  assert.equal(r.maxMHz, 4780);
  assert.equal(r.cappedMHz, undefined);
  assert.deepEqual(
    r.ccx.map((c) => [c.name, c.ccd, c.avgMHz, c.maxMHz, c.temp?.label, c.temp?.value]),
    [
      ["CCX1", 0, 4095, 4100, "Tccd1", 53.75],
      ["CCX2", 0, 4145, 4150, "Tccd1", 53.75],
      ["CCX3", 1, 4195, 4200, "Tccd2", 44.75],
      ["CCX4", 1, 4245, 4250, "Tccd2", 44.75],
    ],
  );
  assert.deepEqual(r.notAvailable, ["Vcore", "package power (PPT)", "SMU overclocking mode"]);
});

test("cores: one row per physical core with both threads, ordered by CCX", () => {
  const r = report();
  assert.equal(r.coreList.length, 12);
  assert.deepEqual(r.coreList[0], {
    name: "Core 1",
    key: 0,
    ccx: "CCX1",
    ccxIndex: 0,
    threads: [
      { cpu: 0, mhz: 4100, rank: 211 },
      { cpu: 12, mhz: 4090, rank: 211 },
    ],
    mhz: 4100,
    rank: 211,
  });
  assert.deepEqual(r.coreList.map((c) => c.ccx).slice(2, 4), ["CCX1", "CCX2"]);
});

test("summary: driver, governor, EPP, boost; mixed values and a cap are spelled out", () => {
  assert.equal(summaryLine(report()), "12 cores / 24 threads · amd-pstate-epp · governor performance · EPP performance · boost on, up to 4780 MHz");
  const r = report(ryzen3900x({ boost: "0", scalingMaxKHz: 4_000_000 }));
  assert.equal(summaryLine(r), "12 cores / 24 threads · amd-pstate-epp · governor performance · EPP performance · boost off, up to 4780 MHz · capped at 4000 MHz");
  const mixed = report();
  mixed.governor = "performance / powersave";
  assert.match(summaryLine(mixed), /governor performance \/ powersave/);
});

test("page state: raw numbers for the custom page, keyed maps, no dots in keys", () => {
  const s = polledState(report()) as any;
  assert.deepEqual(s.cpu, {
    model: "AMD Ryzen 9 3900X 12-Core Processor",
    summary: summaryLine(report()),
    cores: 12,
    threads: 24,
    tuning: true,
    vendor: "AMD",
    driver: "amd-pstate-epp",
    governor: "performance",
    epp: "performance",
    boost: true,
    maxMHz: 4780,
    minMHz: 1728,
    pkgTemp: { label: "Tctl", value: 56.25 },
    hidden: ["asusec T_Sensor (reads -40 °C: nothing plugged in)"],
  });
  assert.deepEqual(s.ccx["0"], { index: 0, name: "CCX1", ccd: 0, cpus: [0, 1, 2, 12, 13, 14], cores: [0, 1, 2], slots: 4, avgMHz: 4095, maxMHz: 4100, fastCore: 0, temp: { label: "Tccd1", value: 53.75 } });
  assert.deepEqual(s.cores["3"], { order: 3, name: "Core 4", ccx: 1, threads: [{ cpu: 3, mhz: 4150 }, { cpu: 15, mhz: 4140 }], mhz: 4150, rank: 206 });
  assert.deepEqual(s.sensors["asusec-fan1"], { order: 6, chip: "asusec", label: "Chipset", name: "Chipset fan", description: "ASUS EC", kind: "fan", value: 2491, unit: "RPM" });
  assert.equal(s.sensors["k10temp-temp3"].description, "CCD0 die (k10temp)");
  assert.equal(s.sensors["asusec-temp4"], undefined, "T_Sensor at -40 °C is hidden");
});

test("CCX slots come from the core_id stride: 3 of 4 on a 3900X, the cores count without core_id", () => {
  assert.deepEqual(report().ccx.map((c) => [c.cores.length, c.slots]), [
    [3, 4],
    [3, 4],
    [3, 4],
    [3, 4],
  ]);
  assert.deepEqual(report(ryzen3900x({ coreId: undefined })).ccx.map((c) => c.slots), [3, 3, 3, 3]);
});

test("fastest core per CCX: the busier thread of each core, the fastest core of the CCX", () => {
  // CCX2 = cores 3, 4, 5; make core 5's second thread (cpu 17) the fastest of all
  const m = ryzen3900x({ freqKHz: (c) => (c === 17 ? 4_450_000 : c === 4 ? 4_300_000 : 1_728_000) });
  const r = report(m);
  assert.equal(r.coreList.find((c) => c.key === 5)!.mhz, 4450);
  assert.equal(r.ccx[1]!.fastCore, 5);
  assert.equal(r.ccx[1]!.maxMHz, 4450);
  assert.equal(r.ccx[0]!.fastCore, 0, "all equal: the first core");
});

test("profiles state: active absent for stock, unset values absent (never invented), problems", () => {
  const st = defaultSettings();
  const s = profilesState(st, "/x/cpu.json", [], 4) as any;
  assert.deepEqual(s, {
    applyOnStart: true,
    file: "/x/cpu.json",
    list: {
      underclock: { order: 0, name: "Underclock", detail: NOT_SET },
      overclock: { order: 1, name: "Overclock (CTR)", detail: "CCX1 4250 · CCX2 4250 · CCX3 4125 · CCX4 4100 MHz · Cinebench R20 6916 · 137 W", ccx: [4250, 4250, 4125, 4100], vcore: 1.25, cinebenchR20: 6916, powerW: 137 },
    },
  });
  assert.equal(activeLine(st), "Active profile: none (stock settings, nothing applied).");
  st.active = "overclock";
  st.applyOnStart = false;
  const s2 = profilesState(st, "/x/cpu.json", ["broken a", "broken b"], 2) as any;
  assert.equal(s2.active, "overclock");
  assert.equal(s2.applyOnStart, false);
  assert.equal(s2.problems, "broken a broken b");
  assert.match(s2.list.overclock.detail, /4 CCX values, this CPU has 2$/);
  assert.equal(activeLine(st), "Active profile: Overclock (CTR), not re-applied on start.");
});

test("vendor: title and tuning from vendor_id and family", () => {
  assert.equal(toolTitle("AuthenticAMD"), "CPU - AMD");
  assert.equal(toolTitle("GenuineIntel"), "CPU - Intel");
  assert.equal(toolTitle("CentaurHauls"), "CPU");
  assert.equal(toolTitle(undefined), "CPU");
  assert.equal(tuningSupported("AuthenticAMD", 0x17), true);
  assert.equal(tuningSupported("AuthenticAMD", 0x19), false, "Zen 3: one CCX per CCD, not what the profiles describe");
  assert.equal(tuningSupported("GenuineIntel", 6), false);
});

test("Intel hybrid: P-/E-cores, coretemp package and per-core temps, no_turbo, no AMD-only parts", () => {
  const r = report(intelHybrid());
  assert.equal(r.vendor, "Intel");
  assert.equal(r.tuning, false);
  assert.equal(r.cores, 16);
  assert.equal(r.threads, 24);
  assert.equal(r.boost, true, "no_turbo 0 = boost on");
  assert.equal(r.cappedMHz, undefined, "E-cores' lower max isn't a cap");
  assert.equal(r.maxMHz, 5200);
  assert.deepEqual(r.notAvailable, []);
  assert.deepEqual(r.pkgTemp, { label: "Package id 0", value: 41 });
  assert.equal(r.ccx.length, 1);
  assert.equal(r.ccx[0]!.name, "L3 group 1");
  assert.equal(r.ccx[0]!.ccd, undefined);
  const p = r.coreList.filter((c) => c.kind === "P");
  const e = r.coreList.filter((c) => c.kind === "E");
  assert.equal(p.length, 8);
  assert.equal(e.length, 8);
  assert.deepEqual(p[1]!.threads.map((t) => t.cpu), [2, 3]);
  assert.deepEqual(p[1]!.temp, { label: "Core 4", value: 35.5 });
  assert.deepEqual(e[0]!.temp, { label: "Core 32", value: 39 });
  assert.equal(e[0]!.mhz, 3700);
  const s = polledState(r) as any;
  assert.equal(s.cpu.tuning, false);
  assert.equal(s.cpu.vendor, "Intel");
  assert.equal(s.cores["16"].kind, "E");
  assert.equal(s.sensors["coretemp-temp1"].description, "CPU package (coretemp)");
  assert.equal(s.sensors["acpitz-temp1"], undefined, "only the known chips");
  const text = formatStatus(r);
  assert.match(text, /\n {2}Core 9 {3}E-core cpu 16 3700 MHz · 39 °C\n/);
  assert.match(text, /Clock caps, turbo, EPP and PL1\/PL2: `cpuctl limits`, `cpuctl profiles`, `cpuctl use <stock\|underclock\|overclock>`\.$/);
  assert.doesNotMatch(text, /Vcore/);
});

test("plain Intel: no hybrid kinds, no_turbo 1 = boost off, one group", () => {
  const r = report(intelPlain());
  assert.equal(r.boost, false);
  assert.equal(r.cores, 6);
  assert.ok(r.coreList.every((c) => c.kind === undefined));
  assert.deepEqual(r.coreList[5]!.temp, { label: "Core 5", value: 41 });
  assert.equal(r.tuning, false);
});

test("Ryzen 5 3600: one CCD with two CCXs, still tunable, no ranks", () => {
  const r = report(ryzen3600());
  assert.equal(r.tuning, true);
  assert.deepEqual(r.ccx.map((c) => [c.name, c.ccd, c.cores.length, c.slots]), [
    ["CCX1", 0, 3, 4],
    ["CCX2", 0, 3, 4],
  ]);
  assert.ok(r.coreList.every((c) => c.rank === undefined));
  assert.equal(r.ccx[1]!.temp?.label, "Tccd1");
});

test("CLI text: status and profiles", () => {
  const text = formatStatus(report());
  assert.match(text, /^AMD Ryzen 9 3900X 12-Core Processor\n12 cores \/ 24 threads/);
  assert.match(text, /\nCCX3 \(CCD1\)   avg 4195 MHz  max 4200 MHz  Tccd2 44\.8 °C  cpus 6-8, 18-20\n/);
  assert.match(text, /\n {2}Core 12  CCX4  cpu 11 4250 MHz · cpu 23 4240 MHz · rank 166\n/);
  assert.match(text, /hidden: asusec T_Sensor/);
  assert.match(text, /Not available yet: Vcore, package power \(PPT\)/);
  const p = formatProfiles("/x/cpu.json", defaultSettings(), [], 4);
  assert.match(p, /underclock {2}Underclock\n {4}values not set yet\n/);
  assert.match(p, /overclock {3}Overclock \(CTR\)\n {4}CCX1 4250 MHz {2}CCX2 4250 MHz {2}CCX3 4125 MHz {2}CCX4 4100 MHz\n {4}Vcore 1\.250 V · Cinebench R20 6916 · 137 W\n/);
  assert.match(p, /Applying profiles isn't available yet\.$/);
});
