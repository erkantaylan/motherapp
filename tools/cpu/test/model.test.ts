// Report, page state and the CLI text, from fixture snapshots.
import { test } from "node:test";
import assert from "node:assert/strict";
import { activeLine, buildReport, formatProfiles, formatStatus, NOT_SET, polledState, profilesState, summaryLine } from "../src/model.ts";
import { defaultSettings } from "../src/settings.ts";
import { readSnapshot } from "../src/sysfs.ts";
import { ryzen3900x, tempTree } from "./fixtures.ts";

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
    threads: [
      { cpu: 0, mhz: 4100, rank: 211 },
      { cpu: 12, mhz: 4090, rank: 211 },
    ],
    mhz: 4100,
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

test("page state: keyed maps, no dots in keys, a meter fraction against the max boost", () => {
  const s = polledState(report()) as any;
  assert.deepEqual(s.cpu, { model: "AMD Ryzen 9 3900X 12-Core Processor", summary: summaryLine(report()) });
  assert.deepEqual(s.ccx["0"], { order: 0, name: "CCX1 (CCD0)", value: "4095 MHz avg", detail: "max 4100 MHz · Tccd1 53.8 °C · cpus 0-2, 12-14", fraction: 4095 / 4780 });
  assert.deepEqual(s.cores["3"], { order: 3, name: "Core 4 · CCX2", value: "4150 MHz", detail: "cpu 3 4150 MHz · cpu 15 4140 MHz · rank 206", fraction: 4150 / 4780 });
  assert.deepEqual(s.sensors["asusec-fan1"], { order: 6, name: "Chipset fan", detail: "ASUS EC", value: "2491 RPM" });
  assert.deepEqual(s.sensors["k10temp-temp3"], { order: 1, name: "Tccd1", detail: "CCD0 die (k10temp)", value: "53.8 °C" });
  assert.equal(s.sensors["asusec-temp4"], undefined, "T_Sensor at -40 °C is hidden");
});

test("profiles: overclock from CTR, underclock not set yet, active line", () => {
  const st = defaultSettings();
  const s = profilesState(st, 4) as any;
  assert.deepEqual(s.underclock, { order: 0, name: "Underclock", value: "not set", detail: NOT_SET });
  assert.deepEqual(s.overclock, { order: 1, name: "Overclock (CTR)", value: "1.250 V", detail: "CCX1 4250 · CCX2 4250 · CCX3 4125 · CCX4 4100 MHz · Cinebench R20 6916 · 137 W" });
  assert.equal(activeLine(st), "Active profile: none (stock settings, nothing applied).");
  st.active = "overclock";
  assert.equal((profilesState(st, 4) as any).overclock.name, "Overclock (CTR) (active)");
  assert.equal(activeLine(st), "Active profile: Overclock (CTR), re-applied when the tool starts.");
  st.applyOnStart = false;
  assert.equal(activeLine(st), "Active profile: Overclock (CTR), not re-applied on start.");
  assert.match((profilesState(st, 2) as any).overclock.detail, /4 CCX values, this CPU has 2$/);
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
