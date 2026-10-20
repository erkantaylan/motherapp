// The two backends: libddcutil in a worker thread (the real library when installed, and a fake
// worker for blocking/hanging calls), and the ddcutil command (a fake ddcutil on PATH).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CliBackend } from "../src/cliBackend.ts";
import { LibBackend } from "../src/libBackend.ts";
import { selectBackend } from "../src/select.ts";
import { MACHINE_MONITORS, fakeDdcutil } from "./fakes.ts";

const fakeWorker = new URL("./fake-worker.ts", import.meta.url);
const libInstalled = ["/usr/lib/x86_64-linux-gnu/libddcutil.so.4", "/usr/lib/aarch64-linux-gnu/libddcutil.so.4", "/usr/lib/libddcutil.so.4"].some((f) => fs.existsSync(f));

test("real libddcutil.so.4 loads through koffi in the worker; no monitors here means 0 displays", { skip: !libInstalled && "libddcutil4 is not installed" }, async () => {
  const b = await LibBackend.start();
  try {
    assert.match(b.description, /^libddcutil 1\.4\.\d/);
    assert.deepEqual(await b.detect(false), []);
    assert.deepEqual(await b.detect(true), [], "redetect works too");
    await assert.rejects(b.read(1), (e: Error & { gone?: boolean }) => e.gone === true && /not reachable any more/.test(e.message));
  } finally {
    await b.close();
  }
});

test("a library that can't be loaded rejects start with the reason", async () => {
  await assert.rejects(LibBackend.start({ soname: "libddcutil-does-not-exist.so.4" }), /libddcutil-does-not-exist\.so\.4/);
  await assert.rejects(LibBackend.start({ soname: "fatal.so", workerUrl: fakeWorker }), /cannot open shared object file/);
});

test("blocking libddcutil calls run off the main thread: timers keep firing meanwhile", async () => {
  const b = await LibBackend.start({ workerUrl: fakeWorker });
  try {
    assert.equal(b.description, "libddcutil 1.4.1-fake");
    const t0 = Date.now();
    const slow = b.read(9); // blocks the worker thread for 300 ms
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    const r = await slow;
    clearInterval(timer);
    assert.deepEqual(r, { current: 9, max: 100 });
    assert.ok(Date.now() - t0 >= 280);
    assert.ok(ticks >= 10, `main thread kept running (${ticks} ticks)`);
    assert.deepEqual(await b.read(1), { current: 48, max: 100 });
    await assert.rejects(b.write(1, 10), { message: "no answer over DDC/CI, is it switched on? (DDCRC_RETRIES)" });
  } finally {
    await b.close();
  }
});

test("a stuck worker is replaced after hangMs; later calls work again", async () => {
  const b = await LibBackend.start({ workerUrl: fakeWorker, hangMs: 200 });
  try {
    const t0 = Date.now();
    await assert.rejects(b.read(8), /libddcutil stopped answering/);
    assert.ok(Date.now() - t0 < 2000);
    assert.deepEqual(await b.read(1), { current: 48, max: 100 }, "a fresh worker answers");
  } finally {
    await b.close();
  }
});

test("ddcutil CLI backend: detect, read, write, errors and timeouts against a fake ddcutil", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ma-ddc-"));
  try {
    const f = fakeDdcutil(tmp, MACHINE_MONITORS);
    const b = new CliBackend({ command: f.command });
    assert.equal(await b.probe(), undefined);
    assert.equal(b.description, "ddcutil 1.4.1 command");
    const found = await b.detect(false);
    assert.deepEqual(found.map((m) => [m.bus, m.connector, m.model, m.serial]), [
      [1, "DP-1", "MSI G274QPF", "CC2H683C00058"],
      [3, "DP-2", "Acer X34 P", "#ASM1Buw5LKnd"],
    ]);
    assert.deepEqual(await b.read(3), { current: 52, max: 100 });
    await b.write(3, 61);
    assert.equal(f.value(3), 61);
    assert.deepEqual(f.calls().slice(-3), ["detect --brief", "--bus 3 getvcp 10", "--bus 3 setvcp 10 61"]);

    f.patch(1, { off: true });
    await assert.rejects(b.read(1), (e: Error & { gone?: boolean }) => !e.gone && /is it switched on\?/.test(e.message));
    assert.deepEqual((await b.detect(true)).map((m) => m.bus), [3], "an off monitor shows up as an invalid display");
    f.unplug(3);
    await assert.rejects(b.write(3, 10), (e: Error & { gone?: boolean }) => e.gone === true);

    const slow = new CliBackend({ command: f.command, timeoutMs: 100 });
    process.env.FAKE_DDC_DELAY_MS = "1000";
    try {
      await assert.rejects(slow.read(1), /no answer: ddcutil took longer than 0.1 s/);
    } finally {
      delete process.env.FAKE_DDC_DELAY_MS;
    }

    const missing = new CliBackend({ command: path.join(tmp, "nope", "ddcutil") });
    assert.match(String(await missing.probe()), /not found \(install the ddcutil package\)/);
    await assert.rejects(missing.detect(false), /not found/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("fallback: when libddcutil can't be loaded, the ddcutil command is used, with a warning", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ma-ddc-"));
  try {
    const f = fakeDdcutil(tmp, MACHINE_MONITORS);
    const sel = await selectBackend({ ...process.env, BRIGHTCTL_LIBDDCUTIL: "libddcutil-missing.so.4", PATH: `${f.bin}:${process.env.PATH}` });
    assert.equal(sel.backend.kind, "ddcutil");
    assert.match(sel.warning!, /^libddcutil could not be loaded \(.*libddcutil-missing\.so\.4.*\), so the slower ddcutil command is used instead\. Install the libddcutil4 package/);
    assert.equal((await sel.backend.detect(false)).length, 2);

    const none = await selectBackend({ BRIGHTCTL_LIBDDCUTIL: "libddcutil-missing.so.4", BRIGHTCTL_DDCUTIL: path.join(tmp, "nope") });
    assert.match(none.warning!, /The fallback doesn't work either: .*not found/);

    const forced = await selectBackend({ BRIGHTCTL_BACKEND: "cli", BRIGHTCTL_DDCUTIL: f.command });
    assert.equal(forced.backend.kind, "ddcutil");
    assert.equal(forced.warning, undefined);
    await assert.rejects(selectBackend({ BRIGHTCTL_BACKEND: "lib", BRIGHTCTL_LIBDDCUTIL: "libddcutil-missing.so.4" }), /cannot load libddcutil-missing\.so\.4/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
