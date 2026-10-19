import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LogService, RingBuffer, RotatingFile } from "../src/logService.ts";

test("RingBuffer keeps the newest items in order", () => {
  const r = new RingBuffer<number>(3);
  assert.deepEqual(r.toArray(), []);
  for (let i = 1; i <= 5; i++) r.push(i);
  assert.equal(r.size, 3);
  assert.deepEqual(r.toArray(), [3, 4, 5]);
  assert.deepEqual(r.toArray(2), [4, 5]);
  assert.deepEqual(r.toArray(10), [3, 4, 5]);
});

test("RotatingFile rotates at the size cap and keeps N old files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ma-log-"));
  const file = path.join(dir, "log.jsonl");
  const f = new RotatingFile({ file, maxBytes: 50, keep: 2 });
  const line = "x".repeat(19); // 20 bytes with newline
  for (let i = 0; i < 8; i++) f.write(`${i}${line.slice(1)}`);
  f.close();
  const read = (p: string) => fs.readFileSync(p, "utf8").trim().split("\n").map((l) => l[0]);
  // 2 lines per file: current = 6,7; .1 = 4,5; .2 = 2,3; 0,1 dropped
  assert.deepEqual(read(file), ["6", "7"]);
  assert.deepEqual(read(`${file}.1`), ["4", "5"]);
  assert.deepEqual(read(`${file}.2`), ["2", "3"]);
  assert.equal(fs.existsSync(`${file}.3`), false);
  // reopening appends to the existing file and respects its size
  const g = new RotatingFile({ file, maxBytes: 50, keep: 2 });
  g.write("8" + line.slice(1));
  g.close();
  assert.deepEqual(read(file), ["8"]);
  assert.deepEqual(read(`${file}.1`), ["6", "7"]);
  fs.rmSync(dir, { recursive: true });
});

test("LogService writes stdout JSON lines, the file and the ring buffer, and notifies", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ma-log-"));
  const file = path.join(dir, "log.jsonl");
  const out: string[] = [];
  const log = new LogService({
    capacity: 2,
    file: new RotatingFile({ file }),
    stdout: (l) => out.push(l),
    now: () => new Date("2026-10-19T12:00:00.000Z"),
  });
  const live: string[] = [];
  const off = log.subscribe((e) => live.push(e.msg));
  log.core("info", "core up");
  log.add("demo", "tool", "warn", "hello", { a: 1 });
  log.add("demo", "stderr", "error", "boom", {});
  off();
  log.core("debug", "after unsubscribe", undefined, "demo");
  log.close();

  assert.deepEqual(live, ["core up", "hello", "boom"]);
  assert.equal(out.length, 4);
  assert.deepEqual(JSON.parse(out[1]!), { seq: 2, ts: "2026-10-19T12:00:00.000Z", level: "warn", tool: "demo", src: "tool", msg: "hello", fields: { a: 1 } });
  assert.equal("fields" in JSON.parse(out[2]!), false); // empty fields dropped
  assert.deepEqual(fs.readFileSync(file, "utf8").trim().split("\n"), out);
  assert.deepEqual(log.backlog().map((e) => e.msg), ["boom", "after unsubscribe"]);
  assert.deepEqual(log.backlog(1).map((e) => e.seq), [4]);
  assert.equal(log.backlog()[1]!.tool, "demo");
  assert.equal(log.backlog()[1]!.src, "core");
  fs.rmSync(dir, { recursive: true });
});
