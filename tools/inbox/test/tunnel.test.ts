// cloudflared: URL parsing, restart with backoff (and a new quick URL), stop. Quick tunnels only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Tunnel, parseQuickHost, redactPaths } from "../src/tunnel.ts";
import type { TunnelInfo } from "../src/tunnel.ts";
import { FakeRunner, FakeTimers, QUICK_OUTPUT, tick, waitFor } from "./fakes.ts";

function setup() {
  const runner = new FakeRunner();
  const timers = new FakeTimers();
  const changes: TunnelInfo[] = [];
  const logs: string[] = [];
  const t = new Tunnel({
    runner,
    timers,
    port: 7324,
    log: { info: (m, f) => logs.push(`${m} ${JSON.stringify(f ?? {})}`), warn: (m, f) => logs.push(`${m} ${JSON.stringify(f ?? {})}`) },
    onChange: (i) => changes.push(i),
  });
  return { runner, timers, changes, logs, t };
}

test("parseQuickHost: the banner line, nothing else in cloudflared's output", () => {
  const lines = QUICK_OUTPUT("seasonal-deck-organisms-sf").split("\n");
  const hosts = lines.map(parseQuickHost).filter(Boolean);
  assert.deepEqual(hosts, ["seasonal-deck-organisms-sf.trycloudflare.com"]);
  assert.equal(parseQuickHost("INF Requesting new quick Tunnel on trycloudflare.com..."), undefined);
  assert.equal(parseQuickHost("https://api.trycloudflare.com/tunnel"), undefined);
  assert.equal(redactPaths('ERR error="x" path=/inbox/AbCdEf_-123 ok'), 'ERR error="x" path=/inbox/… ok');
});

test("quick: starts with --url to the inbox port only, running once the URL is printed", async () => {
  const { runner, t, logs } = setup();
  t.start();
  t.start(); // idempotent
  assert.equal(runner.cf.starts.length, 1);
  assert.deepEqual(runner.cf.starts[0], ["tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:7324"]);
  assert.equal(await t.waitForHost(1000), "first-tunnel-aa.trycloudflare.com");
  await waitFor(() => t.info().connected, "connected");
  assert.deepEqual(t.info(), { status: "running", host: "first-tunnel-aa.trycloudflare.com", connected: true, error: "" });
  assert.ok(logs.some((l) => l.startsWith("tunnel up")));
});

test("restart with backoff after an exit; a quick tunnel comes back with a NEW host", async () => {
  const { runner, timers, t, logs } = setup();
  t.start();
  await t.waitForHost(1000);
  runner.cf.procs[0]!.finish(1, "", "");
  await waitFor(() => t.info().status === "restarting", "restarting");
  assert.equal(t.info().host, "", "the old quick URL is dead");
  assert.match(logs.at(-1)!, /restarting in 1 s/);
  timers.advance(999);
  assert.equal(runner.cf.starts.length, 1);
  timers.advance(1);
  assert.equal(runner.cf.starts.length, 2);
  assert.equal(await t.waitForHost(1000), "second-tunnel-bb.trycloudflare.com");
  // dies again quickly: 2 s, then 4 s
  runner.cf.procs[1]!.finish(1);
  await waitFor(() => t.info().status === "restarting", "restarting 2");
  assert.match(logs.at(-1)!, /restarting in 2 s/);
  timers.advance(2000);
  runner.cf.behaviour = "die";
  await waitFor(() => runner.cf.starts.length === 3 && t.info().status === "restarting", "restarting 3");
  assert.match(logs.at(-1)!, /restarting in 4 s/);
  assert.match(t.info().error, /cloudflared exited/);
  // a long healthy run resets the backoff
  runner.cf.behaviour = "banner";
  timers.advance(4000);
  await t.waitForHost(1000);
  timers.advance(120_000);
  runner.cf.procs.at(-1)!.finish(1);
  await waitFor(() => /restarting in 1 s/.test(logs.at(-1)!), "backoff reset");
  t.stop();
});

test("backoff is capped at 30 s; stop cancels a pending restart and kills cloudflared", async () => {
  const { runner, timers, t, logs } = setup();
  runner.cf.behaviour = "die";
  t.start();
  for (let i = 0; i < 7; i++) {
    await waitFor(() => t.info().status === "restarting" && runner.cf.live().length === 0, `down ${i}`);
    timers.advance(30_000);
  }
  assert.ok(logs.some((l) => /restarting in 30 s/.test(l)));
  assert.ok(!logs.some((l) => /restarting in 64 s/.test(l)));
  const n = runner.cf.starts.length;
  t.stop();
  timers.advance(60_000);
  assert.equal(runner.cf.starts.length, n);
  assert.equal(t.info().status, "stopped");

  runner.cf.behaviour = "banner";
  t.start();
  await t.waitForHost(1000);
  t.stop();
  await tick();
  assert.equal(runner.cf.live().length, 0, "killed");
});

test("waitForHost fails after its timeout when nothing is printed", async () => {
  const { runner, t } = setup();
  runner.cf.behaviour = "silent";
  t.start();
  await assert.rejects(t.waitForHost(50), /didn't come up within/);
  t.stop();
});

test("reconfigure restarts a running tunnel on the new port, always as a quick tunnel", async () => {
  const { runner, t } = setup();
  t.start();
  await t.waitForHost(1000);
  t.reconfigure(7325);
  assert.equal(runner.cf.starts.length, 2);
  assert.deepEqual(runner.cf.starts[1], ["tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:7325"]);
  assert.equal(await t.waitForHost(1000), "second-tunnel-bb.trycloudflare.com");
  t.stop();
  t.reconfigure(7326);
  assert.equal(runner.cf.starts.length, 2, "not started when it wasn't running");
  assert.ok(runner.cf.starts.every((a) => !a.includes("run") && !a.includes("--config")), "never a named tunnel");
});
