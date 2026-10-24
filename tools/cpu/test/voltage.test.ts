// Undervolt: the helper's answers (src/voltage.ts), the crash guard, the undervolt in Intel
// profiles (src/intel.ts), and the root helper script itself against fake rdmsr/wrmsr.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { applyProfile, defaultIntelSettings, limitsState, loadStock, parseLimits, readLimits, targetOf } from "../src/intel.ts";
import { NO_VOLTAGE, TRIAL_MS, Voltage, checkCrash, endTrial, loadGuard, saveGuard } from "../src/voltage.ts";
import { fakeVoltage, intelHybrid, tempTree } from "./fixtures.ts";

function tree(t: { after: (fn: () => void) => void }) {
  const tr = tempTree(intelHybrid());
  t.after(tr.cleanup);
  return tr.root;
}

test("Voltage: reads once and caches; set reads back; no helper or no sudo rule is the install hint", () => {
  const f = fakeVoltage();
  const v = new Voltage(f.run);
  assert.deepEqual(v.state(), { offsets: { core: 0, cache: 0 } });
  v.state();
  assert.equal(f.state.calls.length, 1, "cached: one sudo run");
  assert.deepEqual(v.set(-50), { offsets: { core: -50, cache: -50 } });
  assert.deepEqual(v.state().offsets, { core: -50, cache: -50 });

  assert.deepEqual(new Voltage(fakeVoltage({ setUp: false }).run).state(), { problem: NO_VOLTAGE });
  const missing = new Voltage(() => ({ status: null, stdout: "", stderr: "", error: new Error("spawnSync sudo ENOENT") }));
  assert.equal(missing.state().problem, NO_VOLTAGE);

  const prot = new Voltage(fakeVoltage({ protect: true }).run);
  const r = prot.set(-50);
  assert.deepEqual(r.offsets, { core: 0, cache: 0 });
  assert.match(r.problem!, /^Undervolt: the CPU didn't take -50 mV .*Undervolt Protection/);
});

test("parseLimits: undervoltMV is -150..0 in 5 mV steps, never positive", () => {
  const p: string[] = [];
  assert.deepEqual(parseLimits({ undervoltMV: -50 }, p), { undervoltMV: -50 });
  for (const bad of [5, -151, -52, 1.5, "x"]) {
    const problems: string[] = [];
    assert.deepEqual(parseLimits({ undervoltMV: bad }, problems), {});
    assert.match(problems[0]!, /"undervoltMV" must be null or -150 to 0 mV in steps of 5/);
  }
  assert.deepEqual(p, []);
});

test("readLimits with the helper: an undervolt row, read through it; the sysfs access ignores it", (t) => {
  const root = tree(t);
  const hw = readLimits(root, new Voltage(fakeVoltage().run));
  assert.equal(hw.current.undervoltMV, 0);
  assert.equal(hw.writable.undervoltMV, true);
  const st = limitsState(hw, undefined, undefined) as any;
  assert.deepEqual(st.rows.undervoltMV, { order: 7, label: "Undervolt (core + cache)", now: 0, stock: 0, min: -150, max: 0, writable: true });
  assert.equal(readLimits(root).files.undervoltMV.length, 0, "no helper: no undervolt");

  const none = readLimits(root, new Voltage(fakeVoltage({ setUp: false }).run));
  assert.equal(none.writable.undervoltMV, false);
  assert.equal(none.current.undervoltMV, undefined);
  const st2 = limitsState(none, undefined, targetOf({}, { undervoltMV: -50 }, none)) as any;
  assert.equal(st2.voltageText, NO_VOLTAGE);
  assert.equal(st2.access, "full", "the undervolt doesn't count as missing sysfs access");
  assert.equal(st2.drift, undefined, "an offset that can't be read isn't drift");
});

test("applyProfile: the undervolt goes last, starts a trial, and stock puts it back to 0", (t) => {
  const root = tree(t);
  const stockFile = path.join(root, "state", "cpu-stock.json");
  const guardFile = path.join(root, "state", "cpu-undervolt.json");
  const f = fakeVoltage();
  const voltage = new Voltage(f.run);
  const s = defaultIntelSettings();
  s.profiles[1] = { id: "overclock", name: "Overclock", pl2W: 253, undervoltMV: -50 };

  const r = applyProfile(root, stockFile, s, "overclock", 5000, { voltage, guardFile });
  assert.deepEqual(r.changed, ["PL2 (short-term power) 241 W → 253 W", "Undervolt (core + cache) 0 mV → -50 mV"]);
  assert.equal(r.trial, -50);
  assert.equal(f.state.core, -50);
  assert.deepEqual(loadGuard(guardFile), { trial: { mV: -50, bootId: "boot-1", at: 5000 } });
  assert.equal(loadStock(stockFile, "boot-1")?.values.undervoltMV, 0);

  const again = applyProfile(root, stockFile, s, "overclock", 6000, { voltage, guardFile });
  assert.equal(again.trial, undefined, "unchanged offset: no new trial");
  assert.equal(loadGuard(guardFile).trial?.at, 5000);

  const back = applyProfile(root, stockFile, s, null, 7000, { voltage, guardFile });
  assert.ok(back.changed.includes("Undervolt (core + cache) -50 mV → 0 mV"));
  assert.equal(f.state.core, 0);
  assert.deepEqual(loadGuard(guardFile), {}, "back at 0: nothing on trial");
  assert.equal(fs.existsSync(guardFile), false);
});

test("applyProfile: refused by the BIOS is a problem and no trial; skipUndervolt leaves it alone", (t) => {
  const root = tree(t);
  const stockFile = path.join(root, "state", "cpu-stock.json");
  const guardFile = path.join(root, "state", "cpu-undervolt.json");
  const s = defaultIntelSettings();
  s.profiles[1] = { id: "overclock", name: "Overclock", undervoltMV: -50 };

  const prot = applyProfile(root, stockFile, s, "overclock", 5000, { voltage: new Voltage(fakeVoltage({ protect: true }).run), guardFile });
  assert.deepEqual(prot.changed, []);
  assert.match(prot.problems[0]!, /Undervolt Protection/);
  assert.deepEqual(loadGuard(guardFile), {});

  const f = fakeVoltage();
  saveGuard(guardFile, { blocked: { mV: -50, at: 1 } });
  const skip = applyProfile(root, stockFile, s, "overclock", 6000, { voltage: new Voltage(f.run), guardFile, skipUndervolt: true });
  assert.deepEqual(skip.changed, []);
  assert.equal(f.state.calls.some((c) => c[0] === "set"), false);
  assert.ok(loadGuard(guardFile).blocked, "still blocked");

  applyProfile(root, stockFile, s, "overclock", 7000, { voltage: new Voltage(f.run), guardFile });
  assert.deepEqual(loadGuard(guardFile), { trial: { mV: -50, bootId: "boot-1", at: 7000 } }, "the user applied it again: a new trial, no block");
});

test("crash guard: a trial from another boot becomes blocked; one on this boot ends after TRIAL_MS", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cpu-guard-"));
  try {
    const file = path.join(dir, "g.json");
    assert.deepEqual(checkCrash(file, "b1"), { guard: {} });
    saveGuard(file, { trial: { mV: -80, bootId: "b1", at: 1000 } });
    assert.equal(checkCrash(file, "b1").crashed, undefined, "same boot: the tool restarted, not the computer");
    assert.equal(endTrial(file, "b1", 1000 + TRIAL_MS - 1), undefined);
    assert.equal(endTrial(file, "b1", 1000 + TRIAL_MS), -80);
    assert.deepEqual(loadGuard(file), {});

    saveGuard(file, { trial: { mV: -80, bootId: "b1", at: 1000 } });
    assert.deepEqual(checkCrash(file, "b2"), { guard: { blocked: { mV: -80, at: 1000 } }, crashed: -80 });
    assert.deepEqual(loadGuard(file), { blocked: { mV: -80, at: 1000 } });
    assert.equal(checkCrash(file, "b3").crashed, undefined, "blocked stays blocked, reported once");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- the root helper, with fake rdmsr/wrmsr emulating the mailbox ----

const HELPER = fileURLToPath(new URL("../../../packaging/motherapp-cpu-voltage.sh", import.meta.url));

/** Fake msr-tools: wrmsr keeps the offset per plane (unless PROTECT=1), rdmsr answers the last command. */
function fakeMsr(t: { after: (fn: () => void) => void }, vendor = "GenuineIntel") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cpu-msr-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "bin"));
  fs.mkdirSync(path.join(dir, "root", "proc"), { recursive: true });
  fs.writeFileSync(path.join(dir, "root", "proc", "cpuinfo"), `processor\t: 0\nvendor_id\t: ${vendor}\n`);
  const wr = `#!/bin/bash
# wrmsr -p 0 0x150 VALUE
v=$(( $4 )); plane=$(( (v >> 40) & 0xFF )); cmd=$(( (v >> 32) & 0xFF ))
st=${dir}/plane$plane
if (( cmd == 0x11 )) && [[ \${PROTECT:-0} != 1 ]]; then printf '%d' $(( v & (0x7FF << 21) )) > "$st"; fi
printf '0x%x' $(( $(cat "$st" 2>/dev/null || echo 0) )) > ${dir}/answer
`;
  fs.writeFileSync(path.join(dir, "bin", "wrmsr"), wr, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "bin", "rdmsr"), `#!/bin/bash\ncat ${dir}/answer\n`, { mode: 0o755 });
  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync("bash", [HELPER, ...args], {
      encoding: "utf8",
      env: { PATH: `${dir}/bin:/usr/bin:/bin`, MOTHERAPP_CPU_VOLTAGE_TEST: "1", MOTHERAPP_CPU_VOLTAGE_ROOT: path.join(dir, "root"), ...env },
    });
  return { dir, run };
}

test("helper script: read, set -5 and -150 (1/1.024 mV units, rounded back), protection, refusals", (t) => {
  const m = fakeMsr(t);
  let r = m.run(["read"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "core 0\ncache 0\n");
  r = m.run(["set", "-5"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "core -5\ncache -5\n");
  // round(-5 * 1.024) = -5 -> 11-bit 0x7FB in bits 31:21, as the probe wrote
  assert.equal(fs.readFileSync(path.join(m.dir, "plane0"), "utf8"), String(0xff600000));
  assert.equal(m.run(["set", "-150"]).stdout, "core -150\ncache -150\n");
  assert.equal(m.run(["set", "0"]).stdout, "core 0\ncache 0\n");

  r = m.run(["set", "-50"], { PROTECT: "1" });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /didn't take -50 mV \(it reads core 0 mV, cache 0 mV\): turn off "Undervolt Protection"/);

  for (const bad of [["set", "5"], ["set", "-151"], ["set", "+0"], ["set", "-05"], ["set", "-50", "x"], ["set"], ["write", "0"], []]) {
    const b = m.run(bad);
    assert.equal(b.status, 2, `${bad.join(" ")}: usage error`);
  }
  assert.equal(m.run(["read"]).stdout, "core 0\ncache 0\n", "refused commands wrote nothing");
});

test("helper script: refuses a CPU that isn't Intel, and runs only as root outside tests", (t) => {
  const amd = fakeMsr(t, "AuthenticAMD");
  const r = amd.run(["read"]);
  assert.equal(r.status, 4);
  assert.match(r.stderr, /not an Intel CPU/);
  if (process.getuid?.() !== 0) {
    const n = spawnSync("bash", [HELPER, "read"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
    assert.equal(n.status, 4);
    assert.match(n.stderr, /run as root/);
  }
});
