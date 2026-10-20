// Pure pieces: keys, titles, value specs, matching, ddcutil output parsing, sysfs connector
// lookup, libddcutil status mapping, and the scheduling primitives.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cliError, parseDetect, parseGetvcp } from "../src/cliBackend.ts";
import { toBackendError } from "../src/libBackend.ts";
import { applySpec, keyFor, keysFor, matchMonitor, parseValueSpec, subtitleFor, titleFor, toPercent, toRaw } from "../src/model.ts";
import { Gate, Serial, withTimeout } from "../src/queue.ts";
import { connectorForBus } from "../src/sysfs.ts";
import { ACER, ACER_KEY, MSI, MSI_KEY, fixtures, sleep } from "./fakes.ts";

test("keys: stable from EDID identity, no dots, unique per detection", () => {
  assert.equal(keyFor(MSI), MSI_KEY);
  assert.equal(keyFor(ACER), ACER_KEY);
  assert.equal(keyFor({ ...MSI, bus: 7 }), MSI_KEY, "a bus change keeps the key when there is a serial");
  assert.equal(keyFor({ bus: 4, mfg: "DEL", model: "U2720Q", serial: "" }), "DEL-U2720Q-i2c4");
  assert.equal(keyFor({ bus: 5, mfg: "", model: "", serial: "" }), "i2c5");
  assert.ok(!keyFor({ bus: 1, mfg: "A.B", model: "x.y z", serial: "1.2" }).includes("."));
  const twins = [
    { bus: 1, mfg: "DEL", model: "P2419H", serial: "SAME" },
    { bus: 2, mfg: "DEL", model: "P2419H", serial: "SAME" },
  ];
  assert.deepEqual(keysFor(twins), ["DEL-P2419H-SAME-i2c1", "DEL-P2419H-SAME-i2c2"]);
});

test("titles by model, connector as subtitle", () => {
  assert.equal(titleFor(MSI), "MSI G274QPF");
  assert.equal(titleFor({ bus: 2, mfg: "DEL", model: "", serial: "" }), "DEL monitor");
  assert.equal(titleFor({ bus: 2, mfg: "", model: "", serial: "" }), "Monitor on i2c-2");
  assert.equal(subtitleFor(ACER), "DP-2");
  assert.equal(subtitleFor({ bus: 9 }, "not found"), "/dev/i2c-9 · not found");
});

test("percent <-> raw", () => {
  assert.equal(toPercent(48, 100), 48);
  assert.equal(toPercent(50, 200), 25);
  assert.equal(toPercent(120, 100), 100);
  assert.equal(toPercent(30, 0), 30);
  assert.equal(toRaw(40, 200), 80);
  assert.equal(toRaw(33, 100), 33);
});

test("value specs", () => {
  assert.deepEqual(parseValueSpec("50"), { kind: "absolute", value: 50 });
  assert.deepEqual(parseValueSpec("70%"), { kind: "absolute", value: 70 });
  assert.deepEqual(parseValueSpec("+10"), { kind: "relative", delta: 10 });
  assert.deepEqual(parseValueSpec("-5%"), { kind: "relative", delta: -5 });
  assert.throws(() => parseValueSpec("101"), /0-100/);
  assert.throws(() => parseValueSpec("ten"), /0-100, \+N or -N/);
  assert.throws(() => parseValueSpec("1.5"));
  assert.equal(applySpec({ kind: "relative", delta: 10 }, 95), 100);
  assert.equal(applySpec({ kind: "relative", delta: -10 }, 5), 0);
  assert.equal(applySpec({ kind: "absolute", value: 3 }, 90), 3);
});

test("matching a monitor from a word", () => {
  const list = [
    { key: MSI_KEY, title: "MSI G274QPF", bus: 1, connector: "DP-1", mfg: "MSI", model: "MSI G274QPF" },
    { key: ACER_KEY, title: "Acer X34 P", bus: 3, connector: "DP-2", mfg: "ACR", model: "Acer X34 P" },
  ];
  for (const w of ["DP-2", "dp-2", "3", "i2c-3", "/dev/i2c-3", "acer", "ACR", "x34", ACER_KEY]) assert.equal(matchMonitor(list, w).key, ACER_KEY, w);
  for (const w of ["DP-1", "1", "msi", "g274"]) assert.equal(matchMonitor(list, w).key, MSI_KEY, w);
  assert.throws(() => matchMonitor(list, "dell"), /no monitor matches "dell" \(monitors: MSI G274QPF \(DP-1\), Acer X34 P \(DP-2\)\)/);
  assert.throws(() => matchMonitor(list, "p"), /matches more than one monitor/);
});

test("parses ddcutil 1.4.1 detect --brief output captured on the machine", () => {
  const found = parseDetect(fs.readFileSync(path.join(fixtures, "detect-brief.txt"), "utf8"));
  assert.deepEqual(found, [MSI, ACER]);
  const withInvalid = "Invalid display\n   I2C bus:          /dev/i2c-5\n   DDC communication failed\n\n" + fs.readFileSync(path.join(fixtures, "detect-brief.txt"), "utf8");
  assert.deepEqual(parseDetect(withInvalid).map((m) => m.bus), [1, 3]);
  assert.deepEqual(parseDetect("No displays found.\n"), []);
});

test("parses getvcp output and classifies ddcutil errors", () => {
  assert.deepEqual(parseGetvcp("VCP code 0x10 (Brightness                    ): current value =    48, max value =   100\n"), { current: 48, max: 100 });
  assert.deepEqual(parseGetvcp("VCP 10 C 52 100\n"), { current: 52, max: 100 });
  assert.equal(parseGetvcp("garbage"), undefined);
  const gone = cliError("No monitor detected on bus /dev/i2c-3\n", 1);
  assert.equal(gone.gone, true);
  assert.match(gone.message, /^not reachable any more.*No monitor detected on bus \/dev\/i2c-3/);
  const off = cliError("DDC communication failed for monitor on bus /dev/i2c-1\n", 1);
  assert.equal(off.gone, false);
  assert.match(off.message, /^no answer over DDC\/CI, is it switched on\?/);
  assert.equal(cliError("", 3).message, "ddcutil failed: exit code 3");
});

test("libddcutil status codes become messages for the failed dot", () => {
  assert.equal(toBackendError({ message: "x", status: -3007, rcName: "DDCRC_RETRIES" }).message, "no answer over DDC/CI, is it switched on? (DDCRC_RETRIES)");
  const gone = toBackendError({ message: "x", status: -3020, rcName: "DDCRC_INVALID_DISPLAY" });
  assert.equal(gone.gone, true);
  assert.equal(toBackendError({ message: "x", status: -19, rcName: "ENODEV" }).gone, true);
  assert.match(toBackendError({ message: "x", status: -3025 }).message, /^busy/);
  assert.match(toBackendError({ message: "x", status: -3005, rcName: "DDCRC_REPORTED_UNSUPPORTED" }).message, /doesn't support brightness/);
  assert.equal(toBackendError({ message: "ddca_open_display2: DDCRC_OTHER" }).message, "ddca_open_display2: DDCRC_OTHER");
});

test("connector from sysfs: ddc symlink or DisplayPort AUX i2c-N subdirectory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ma-drm-"));
  try {
    fs.mkdirSync(path.join(root, "card1-DP-1", "i2c-1"), { recursive: true });
    fs.mkdirSync(path.join(root, "card1-DP-2", "i2c-3"), { recursive: true });
    fs.mkdirSync(path.join(root, "devices", "i2c-6"), { recursive: true });
    fs.mkdirSync(path.join(root, "card0-HDMI-A-1"));
    fs.symlinkSync(path.join(root, "devices", "i2c-6"), path.join(root, "card0-HDMI-A-1", "ddc"));
    fs.mkdirSync(path.join(root, "card1"));
    assert.equal(connectorForBus(1, root), "DP-1");
    assert.equal(connectorForBus(3, root), "DP-2");
    assert.equal(connectorForBus(6, root), "HDMI-A-1");
    assert.equal(connectorForBus(9, root), undefined);
    assert.equal(connectorForBus(1, path.join(root, "missing")), undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Serial: one at a time, queued calls of the same kind coalesce to the newest", async () => {
  const s = new Serial();
  const ran: string[] = [];
  const job = (name: string, ms = 10) => async () => {
    ran.push(name);
    await sleep(ms);
    return name;
  };
  const results = await Promise.all([s.run("w", job("w1")), s.run("w", job("w2")), s.run("w", job("w3")), s.run("r", job("r1")), s.run("w", job("w4"))]);
  assert.deepEqual(ran, ["w1", "w3", "r1", "w4"]);
  assert.deepEqual(results, ["w1", "w3", "w3", "r1", "w4"]);
  assert.ok(s.idle);
  const failing = s.run("w", async () => {
    throw new Error("boom");
  });
  await assert.rejects(failing, /boom/);
  assert.equal(await s.run("w", async () => "after"), "after");
});

test("Gate: exclusive waits for shared calls and blocks new ones", async () => {
  const g = new Gate();
  const log: string[] = [];
  const shared = (n: string, ms: number) => g.shared(async () => (log.push(`${n}+`), await sleep(ms), log.push(`${n}-`)));
  const a = shared("a", 30);
  await sleep(1);
  const x = g.exclusive(async () => (log.push("x+"), await sleep(20), log.push("x-")));
  await sleep(1);
  const b = shared("b", 5);
  await Promise.all([a, x, b]);
  assert.deepEqual(log, ["a+", "a-", "x+", "x-", "b+", "b-"]);
});

test("withTimeout rejects on time and otherwise passes through", async () => {
  await assert.rejects(withTimeout(new Promise(() => {}), 20, "no answer within 0.02 s"), /no answer within 0.02 s/);
  assert.equal(await withTimeout(Promise.resolve(3), 20, "x"), 3);
  await assert.rejects(withTimeout(Promise.reject(new Error("inner")), 20, "x"), /inner/);
});
