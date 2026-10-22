// The import-free helpers the page and the service share (src/view.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  axisRange,
  compareProfiles,
  coreClock,
  dieLayout,
  fastestCore,
  formatDelta,
  gridGroups,
  heatFraction,
  nearestSample,
  profileSummary,
  pushEvent,
  pushSample,
  rankNumbers,
  rankOrder,
  targetFor,
} from "../src/view.ts";
import type { Sample } from "../src/view.ts";
import { RANKS } from "./fixtures.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

test("view.ts imports nothing (the browser loads it as is)", () => {
  const src = fs.readFileSync(path.join(here, "..", "src", "view.ts"), "utf8");
  assert.doesNotMatch(src, /^\s*import\s/m);
  assert.doesNotMatch(src, /^\s*export\s+[^;]*\sfrom\s/m);
});

test("coreClock: the busier thread; fastestCore: the first of the fastest", () => {
  assert.equal(coreClock([{ cpu: 0, mhz: 1728 }, { cpu: 12, mhz: 4250 }]), 4250);
  assert.equal(coreClock([{ cpu: 0 }, { cpu: 12, mhz: 3000 }]), 3000);
  assert.equal(coreClock([{ cpu: 0 }]), undefined);
  assert.deepEqual(fastestCore([{ key: 0, mhz: 4100 }, { key: 1, mhz: 4200 }, { key: 2, mhz: 4200 }]), { key: 1, mhz: 4200 });
  assert.deepEqual(fastestCore([{ key: 0 }, { key: 1, mhz: 1 }]), { key: 1, mhz: 1 });
  assert.equal(fastestCore([{ key: 0 }]), undefined);
});

test("rankOrder: highest rank first, ties in cpu order, unranked last; rankNumbers 1-based", () => {
  // the 3900X's ranks (core i = cpu i): 216 on cores 1 and 2, then 211 (core 0), 206 (core 3) …
  const cores = RANKS.map((rank, key) => ({ key, rank }));
  assert.deepEqual(rankOrder(cores), [1, 2, 0, 3, 4, 5, 7, 8, 6, 10, 9, 11]);
  const no = rankNumbers(cores);
  assert.equal(no.get(1), 1);
  assert.equal(no.get(2), 2);
  assert.equal(no.get(11), 12);
  assert.deepEqual(rankOrder([{ key: 5 }, { key: 3, rank: 1 }, { key: 1 }]), [3, 1, 5]);
  assert.equal(rankNumbers([{ key: 0 }, { key: 1 }]).size, 0);
});

test("formatDelta and heatFraction", () => {
  assert.equal(formatDelta(25), "+25");
  assert.equal(formatDelta(-150), "−150");
  assert.equal(formatDelta(0.2), "±0");
  assert.equal(heatFraction(1728, 1728, 4780), 0.06, "idle stays pale");
  assert.equal(heatFraction(4780, 1728, 4780), 1);
  assert.ok(heatFraction(4250, 1728, 4780) > 0.6, "targets are strong");
  assert.ok(heatFraction(3000, 1728, 4780) < 0.4);
  assert.equal(heatFraction(undefined, 1728, 4780), 0);
  assert.equal(heatFraction(3000, 4000, 4000), 0, "no range");
});

test("profiles: target per CCX (none for stock or unset), one-line summary", () => {
  const oc = { name: "Overclock (CTR)", ccx: [4250, 4250, 4125, 4100], vcore: 1.25, cinebenchR20: 6916, powerW: 137 };
  assert.equal(targetFor(oc, 2), 4125);
  assert.equal(targetFor(undefined, 2), undefined);
  assert.equal(targetFor({ name: "Underclock" }, 0), undefined);
  assert.equal(profileSummary("overclock", oc), "CCX1 4250 · CCX2 4250 · CCX3 4125 · CCX4 4100 MHz at 1.250 V · Cinebench R20 6916 · 137 W");
  assert.equal(profileSummary("underclock", { name: "Underclock" }), "Underclock: values not set yet.");
  assert.equal(profileSummary("stock", undefined, { driver: "amd-pstate-epp", maxMHz: 4780 }), "Stock: no profile active, amd-pstate-epp boosts each core on its own, up to 4780 MHz.");
  assert.equal(profileSummary("overclock", { name: "X", ccx: [4000] }), "CCX1 4000 MHz, Vcore not set yet");
});

test("compareProfiles: unset shows —, offsets below the best CCX highlighted, differences highlighted once both are set", () => {
  const oc = { name: "OC", ccx: [4250, 4250, 4125, 4100], vcore: 1.25, cinebenchR20: 6916, powerW: 137 };
  const rows = compareProfiles({ name: "UC" }, oc, 4);
  assert.deepEqual(
    rows.map((r) => [r.label, r.a, r.b, r.hlA, r.hlB]),
    [
      ["CCX1", "—", "4250 MHz", false, false],
      ["CCX2", "—", "4250 MHz", false, false],
      ["CCX3", "—", "4125 MHz (−125)", false, true],
      ["CCX4", "—", "4100 MHz (−150)", false, true],
      ["Vcore", "—", "1.250 V", false, false],
      ["Cinebench R20", "—", "6916", false, false],
      ["Power", "—", "137 W", false, false],
    ],
  );
  const uc = { name: "UC", ccx: [3600, 3600, 3600, 3600], vcore: 1.25 };
  const both = compareProfiles(uc, oc, 4);
  assert.deepEqual(both.map((r) => [r.label, r.hlA, r.hlB]).slice(0, 5), [
    ["CCX1", true, true],
    ["CCX2", true, true],
    ["CCX3", true, true],
    ["CCX4", true, true],
    ["Vcore", false, false],
  ]);
});

test("pushEvent caps the list, keeping the newest", () => {
  let l: { ts: number; text: string; kind: string }[] = [];
  for (let i = 0; i < 7; i++) l = pushEvent(l, { ts: i, text: `e${i}`, kind: "x" }, 5);
  assert.deepEqual(l.map((e) => e.text), ["e2", "e3", "e4", "e5", "e6"]);
});

test("samples: a 3-minute window, nearest sample within a gap, axis ranges", () => {
  const buf: Sample[] = [];
  for (let t = 0; t <= 200_000; t += 1000) pushSample(buf, { ts: t, mhz: 4000 + t / 1000 }, 180_000);
  assert.equal(buf[0]!.ts, 20_000);
  assert.equal(buf.length, 181);
  assert.equal(nearestSample(buf, 100_400, 1500)?.ts, 100_000);
  assert.equal(nearestSample(buf, 5000, 1500), undefined, "nothing that far back");
  assert.deepEqual(axisRange([], [1500, 5000], 1000, 500), [1500, 5000]);
  assert.deepEqual(axisRange([5210], [1500, 5000], 1000, 500), [1500, 5500]);
  assert.deepEqual(axisRange([55, 56], [30, 70], 20, 10), [30, 70]);
  assert.deepEqual(axisRange([88], [30, 70], 20, 10), [30, 90]);
});

test("dieLayout: drawn only for 2 CCD × 2 CCX with at most 4 slots, else undefined (grid)", () => {
  const zen2 = [0, 1, 2, 3].map((i) => ({ index: i, ccd: Math.floor(i / 2), cores: 3, slots: 4 }));
  assert.deepEqual(dieLayout(zen2), [
    { ccd: 0, ccx: [0, 1] },
    { ccd: 1, ccx: [2, 3] },
  ]);
  // a Ryzen 5 3600: one CCD with two CCXs
  assert.equal(dieLayout([0, 1].map((i) => ({ index: i, ccd: 0, cores: 3, slots: 4 }))), undefined);
  // a Zen 3 5950X: 2 CCD × 1 CCX of 8
  assert.equal(dieLayout([0, 1].map((i) => ({ index: i, ccd: i, cores: 8, slots: 8 }))), undefined);
  // Intel: no CCD
  assert.equal(dieLayout([{ index: 0, cores: 16, slots: 16 }]), undefined);
  assert.equal(dieLayout(zen2.map((c) => ({ ...c, ccd: 0 }))), undefined, "4 CCX on one CCD");
});

test("gridGroups: CCX on AMD, P/E on a hybrid, one group for a single L3", () => {
  const ccx = [
    { index: 0, name: "CCX1" },
    { index: 1, name: "CCX2" },
  ];
  const amd = [0, 1, 2, 3, 4, 5].map((k) => ({ key: k, order: k, ccx: Math.floor(k / 3) }));
  assert.deepEqual(gridGroups(amd, ccx, true), [
    { title: "CCX1", ccx: 0, keys: [0, 1, 2] },
    { title: "CCX2", ccx: 1, keys: [3, 4, 5] },
  ]);
  const hybrid = [0, 2, 16, 17].map((k, i) => ({ key: k, order: i, ccx: 0, kind: (k < 16 ? "P" : "E") as "P" | "E" }));
  assert.deepEqual(gridGroups(hybrid, [{ index: 0, name: "L3 group 1" }], false), [
    { title: "P-cores", keys: [0, 2] },
    { title: "E-cores", keys: [16, 17] },
  ]);
  const plain = [0, 1, 2].map((k) => ({ key: k, order: k, ccx: 0 }));
  assert.deepEqual(gridGroups(plain, [{ index: 0, name: "L3 group 1" }], false), [{ title: "Cores", keys: [0, 1, 2] }]);
});
