// #29: under systemd's default KillMode a tool got SIGTERM twice (systemd's own to the whole
// cgroup, then the core's). The SDK listened with `once`, so the second signal hit the default
// action and killed the tool between writing `<id>.json.<pid>.tmp` and renaming it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createTool, sweepTmpFiles } from "@motherapp/tool-sdk";

const here = path.dirname(fileURLToPath(import.meta.url));
const sdk = path.join(here, "..", "src", "index.ts");

function tmpDir(t: { after(fn: () => void): void }): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ma-sdk-stop-"));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

// A serving tool whose state save is slowed down in the middle: the temp file is half
// written, the tool says SAVING on stderr and blocks for 500 ms, then finishes the write.
const SLOW_SAVE_TOOL = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createTool } from ${JSON.stringify(sdk)};
const orig = fs.writeFileSync;
fs.writeFileSync = function (file, data, ...rest) {
  if (String(file).endsWith(".tmp")) {
    const s = String(data);
    orig.call(fs, file, s.slice(0, s.length >> 1));
    process.stderr.write("SAVING\\n");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  return orig.call(fs, file, data, ...rest);
};
syncBuiltinESMExports();
const tool = createTool({ id: "slow", title: "Slow", stateDir: process.env.STATE_DIR, captureConsole: false });
tool.set("n", 42);
tool.set("big", "x".repeat(200000));
const serving = tool.serve();
process.stderr.write("READY\\n");
await serving;
`;

test("two SIGTERMs in a row: the tool still writes its state file completely and exits 0", async (t) => {
  const dir = tmpDir(t);
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", SLOW_SAVE_TOOL], {
    env: { ...process.env, STATE_DIR: dir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let err = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d: string) => {
    err += d;
    if (d.includes("READY")) child.kill("SIGTERM"); // systemd's
    if (d.includes("SAVING")) child.kill("SIGTERM"); // the core's, mid-save
  });
  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((r) => child.on("exit", (c, s) => r([c, s])));
  assert.match(err, /SAVING/, "the second signal was sent during the save");
  assert.deepEqual([code, signal], [0, null], err);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, "slow.json"), "utf8"));
  assert.equal(saved.state.n, 42);
  assert.equal(saved.state.big.length, 200000);
  assert.deepEqual(fs.readdirSync(dir), ["slow.json"], "no temp file left behind");
});

test("sweepTmpFiles removes only this file's temp files, and only ones older than a minute", (t) => {
  const dir = tmpDir(t);
  const old = (Date.now() - 120_000) / 1000;
  const files = ["audio.json.1234.tmp", "audio.json.99.ab12cd34.tmp", "audio.json.555.tmp", "audio.json", "other.json.1.tmp", "audio.json.x.tmp", "audio.jsonX1.tmp"];
  for (const f of files) fs.writeFileSync(path.join(dir, f), "");
  for (const f of files) if (f !== "audio.json.555.tmp") fs.utimesSync(path.join(dir, f), old, old);
  const removed = sweepTmpFiles(dir, "audio.json");
  assert.deepEqual(removed.sort(), ["audio.json.1234.tmp", "audio.json.99.ab12cd34.tmp"]);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["audio.json", "audio.json.555.tmp", "audio.json.x.tmp", "audio.jsonX1.tmp", "other.json.1.tmp"]);
  assert.deepEqual(sweepTmpFiles(path.join(dir, "missing"), "audio.json"), []);
});

test("a tool sweeps its leftover <id>.json.<pid>.tmp files on startup and still loads its state", (t) => {
  const dir = tmpDir(t);
  fs.writeFileSync(path.join(dir, "swp.json"), JSON.stringify({ version: 1, state: { n: 7 } }));
  fs.writeFileSync(path.join(dir, "swp.json.4321.tmp"), ""); // empty, as the machine had them
  const old = (Date.now() - 3_600_000) / 1000;
  fs.utimesSync(path.join(dir, "swp.json.4321.tmp"), old, old);
  const tool = createTool({ id: "swp", title: "Sweep", stateDir: dir, captureConsole: false });
  assert.equal(tool.get("n"), 7);
  assert.deepEqual(fs.readdirSync(dir), ["swp.json"]);
});
