import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { JsonValue, LogEntry, StateChange } from "@motherapp/protocol";
import { RpcError } from "@motherapp/protocol";
import { LogService } from "../src/logService.ts";
import { Manager } from "../src/manager.ts";
import { ToolHost } from "../src/toolHost.ts";
import { FakeClock, fixturesDir, waitFor } from "./helpers.ts";

function makeHost(id: string, clock = new FakeClock()) {
  const log = new LogService({ stdout: null });
  const entries: LogEntry[] = [];
  log.subscribe((e) => entries.push(e));
  const events = { status: [] as string[], snapshots: 0, changes: [] as StateChange[][], streams: [] as [string, JsonValue][] };
  const manifest = JSON.parse(fs.readFileSync(path.join(fixturesDir, id, "manifest.json"), "utf8"));
  const host = new ToolHost({
    manifest,
    dir: path.join(fixturesDir, id),
    log,
    clock,
    events: {
      status: (h) => events.status.push(h.status),
      snapshot: () => events.snapshots++,
      changes: (_h, c) => events.changes.push(c),
      stream: (_h, n, v) => events.streams.push([n, v]),
    },
  });
  return { host, clock, entries, events };
}

test("crashing tool: backoff 1,2,4,8 s, gives up at the 5th crash, manual restart resets", async () => {
  const { host, clock, entries, events } = makeHost("crash");
  host.start();
  const expected = [1000, 2000, 4000, 8000];
  for (const delay of expected) {
    await waitFor(() => host.status === "down", "down");
    assert.deepEqual(clock.pending(), [delay]);
    assert.equal(host.restartAt, clock.now() + delay);
    clock.advance(delay - 1);
    assert.equal(host.status, "down", "must not restart early");
    clock.advance(1);
    assert.equal(host.status, "starting");
  }
  await waitFor(() => host.status === "failed", "failed");
  assert.deepEqual(clock.pending(), [], "no restart scheduled after giving up");
  assert.match(host.statusText ?? "", /gave up after 5 crashes/);

  // stderr lines are logged as errors tagged with the tool id; crashes are core entries
  assert.ok(entries.some((e) => e.src === "stderr" && e.level === "error" && e.tool === "crash" && e.msg === "dying"));
  assert.equal(entries.filter((e) => e.src === "core" && /^crashed/.test(e.msg)).length, 5);
  assert.ok(entries.some((e) => /giving up/.test(e.msg)));
  assert.ok(events.status.includes("failed"));

  host.restart();
  assert.equal(host.status, "starting");
  await waitFor(() => host.status === "down", "down after manual restart");
  assert.deepEqual(clock.pending(), [1000], "manual restart reset the backoff");
  await host.stop();
  assert.equal(host.status, "stopped");
  assert.deepEqual(clock.pending(), []);
});

test("SDK tool: handshake fills the cache, deltas apply, actions forward, crash keeps the cache", async () => {
  const { host, clock, entries, events } = makeHost("ok");
  host.start();
  await waitFor(() => host.status === "running", "running");
  assert.equal(events.snapshots, 1);
  assert.deepEqual(host.state, { n: 0, nested: { a: 1 } });
  assert.equal(host.describe?.page, "declarative");

  assert.equal(await host.action("inc", undefined), 1);
  await waitFor(() => host.state.n === 1, "delta applied to cache");
  assert.deepEqual(events.changes.at(-1), [{ path: "n", value: 1 }]);
  await waitFor(() => entries.some((e) => e.src === "tool" && e.msg === "inc"), "tool log entry");
  assert.deepEqual(entries.find((e) => e.msg === "inc")?.fields, { n: 1 });

  await assert.rejects(host.action("fail", undefined), (e: RpcError) => e.code === -32000 && e.message === "nope");
  await host.action("stderr", undefined);
  await waitFor(() => entries.some((e) => e.src === "stderr" && e.msg === "something went wrong"), "stderr captured");

  host.openStream("tick");
  host.openStream("tick"); // ref-counted: one open on the tool
  await waitFor(() => events.streams.length >= 2, "stream values");
  host.closeStream("tick");
  host.closeStream("tick");
  await new Promise((r) => setTimeout(r, 50));
  const n = events.streams.length;
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(events.streams.length, n, "no values after the last close");

  await host.action("exit", undefined);
  await waitFor(() => host.status === "down", "down after exit");
  assert.equal(host.state.n, 1, "cache survives the crash");
  await assert.rejects(host.action("inc", undefined), (e: RpcError) => e.code === -32002);
  clock.advance(1000);
  await waitFor(() => host.status === "running", "running again");
  assert.equal(host.state.n, 0, "fresh snapshot replaces the cache after restart");
  assert.equal(events.snapshots, 2);
  await host.stop();
});

test("Manager: enabled set from config and manifest defaults, info and setEnabled", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ma-mgr-"));
  const configFile = path.join(dir, "config.json");
  fs.writeFileSync(configFile, JSON.stringify({ port: 0, tools: { crash: { enabled: false } } }));
  const log = new LogService({ stdout: null });
  const m = new Manager({ toolsDir: fixturesDir, configFile, log, clock: new FakeClock() });
  m.init();
  assert.equal(m.isEnabled("ok"), true); // default
  assert.equal(m.isEnabled("crash"), false); // config
  assert.equal(m.isEnabled("custom"), false); // manifest defaultEnabled: false
  await waitFor(() => m.host("ok").status === "running", "ok running");
  assert.equal(m.host("crash").status, "stopped");
  const info = m.list().find((t) => t.id === "ok")!;
  assert.equal(info.iconUrl, "/tools/ok/ok.svg");
  assert.deepEqual(info.layout, [{ type: "text", bind: "n" }]);
  assert.throws(() => m.host("nope"), (e: RpcError) => e.code === -32003);

  await m.setEnabled("ok", false);
  assert.equal(m.host("ok").status, "stopped");
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile, "utf8")).tools.ok, { enabled: false });
  assert.throws(() => m.restart("ok"), /disabled/);
  await m.shutdown();
  fs.rmSync(dir, { recursive: true });
});
