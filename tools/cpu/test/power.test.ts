// Package power from the RAPL energy counter: watts between reads, wrap, reset, no access.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { NO_ENERGY_ACCESS, PowerMeter } from "../src/power.ts";
import { intelHybrid, ryzen3900x, tempTree } from "./fixtures.ts";

const E = "sys/class/powercap/intel-rapl:0/energy_uj";
const isRoot = process.getuid?.() === 0;

test("watts = µJ difference over the time between reads; first read has none; reset forgets", (t) => {
  const { root, cleanup } = tempTree(intelHybrid());
  t.after(cleanup);
  const m = new PowerMeter(root);
  assert.deepEqual(m.read(1000), {});
  fs.writeFileSync(path.join(root, E), String(1_000_000 + 125_500_000)); // 125.5 J in 1 s
  assert.deepEqual(m.read(2000), { watts: 125.5 });
  fs.writeFileSync(path.join(root, E), String(1_000_000 + 125_500_000 + 60_000_000)); // 60 J in 2 s
  assert.deepEqual(m.read(4000), { watts: 30 });
  m.reset();
  assert.deepEqual(m.read(5000), {});
});

test("the counter wrapping at max_energy_range_uj still gives the right watts", (t) => {
  const { root, cleanup } = tempTree(intelHybrid());
  t.after(cleanup);
  const m = new PowerMeter(root);
  fs.writeFileSync(path.join(root, E), String(262_143_328_850 - 50_000_000));
  m.read(0);
  fs.writeFileSync(path.join(root, E), String(50_000_000));
  assert.deepEqual(m.read(1000), { watts: 100 });
});

test("no RAPL zone, or no read access, is a problem worded for the page", (t) => {
  const amd = tempTree(ryzen3900x());
  t.after(amd.cleanup);
  assert.match(new PowerMeter(amd.root).read(0).problem ?? "", /No RAPL package zone/);
  if (isRoot) return; // root reads anything
  const { root, cleanup } = tempTree(intelHybrid());
  t.after(cleanup);
  fs.chmodSync(path.join(root, E), 0o000);
  assert.deepEqual(new PowerMeter(root).read(0), { problem: NO_ENERGY_ACCESS });
});
