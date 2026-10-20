// Viewer counting: browser tabs say which tool's page they show while visible (`tool.watch`);
// the core sends the tool `watch` on the 0→1 edge at once and on 1→0 after a debounce.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn as nodeSpawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WebSocket } from "ws";
import { LogService } from "../src/logService.ts";
import { Manager } from "../src/manager.ts";
import { startServer } from "../src/server.ts";
import type { SpawnFn } from "../src/toolHost.ts";
import { UNWATCH_DELAY_MS } from "../src/toolHost.ts";
import { FakeClock, fixturesDir, waitFor } from "./helpers.ts";

class Tab {
  ws: WebSocket;
  msgs: Record<string, any>[] = [];
  private id = 0;
  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on("message", (d) => this.msgs.push(JSON.parse(d.toString())));
  }
  open() {
    return new Promise<void>((res, rej) => {
      this.ws.once("open", () => res());
      this.ws.once("error", rej);
    });
  }
  async watch(tool: string | null): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method: "tool.watch", params: { tool } }));
    await waitFor(() => this.msgs.some((m) => m.id === id), "tool.watch reply");
    return this.msgs.find((m) => m.id === id)!;
  }
  close() {
    return new Promise<void>((res) => {
      this.ws.once("close", () => res());
      this.ws.close();
    });
  }
}

async function setup(t: import("node:test").TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ma-watch-"));
  const configFile = path.join(dir, "config.json");
  fs.writeFileSync(configFile, JSON.stringify({ port: 0, tools: { crash: { enabled: false } } }));
  const log = new LogService({ stdout: null });
  const clock = new FakeClock();
  /** Every `watch` notification the core wrote to the ok tool's stdin. */
  const sent: boolean[] = [];
  const spawn: SpawnFn = (cmd, args, opts) => {
    const child = nodeSpawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"] });
    if (path.basename(opts.cwd) === "ok") {
      const write = child.stdin!.write.bind(child.stdin!) as (chunk: unknown, ...rest: unknown[]) => boolean;
      child.stdin!.write = ((chunk: unknown, ...rest: unknown[]) => {
        for (const line of String(chunk).split("\n").filter(Boolean)) {
          const m = JSON.parse(line) as { method?: string; params?: { watching: boolean } };
          if (m.method === "watch") sent.push(m.params!.watching);
        }
        return write(chunk, ...rest);
      }) as typeof child.stdin.write;
    }
    return child;
  };
  const manager = new Manager({ toolsDir: fixturesDir, configFile, log, clock, spawn });
  manager.init();
  const server = await startServer({ manager, log, webDir: dir, port: 0 });
  const host = manager.host("ok");
  await waitFor(() => host.status === "running", "ok running");
  const tabs: Tab[] = [];
  const tab = async () => {
    const x = new Tab(`ws://127.0.0.1:${server.port}/ws`);
    await x.open();
    tabs.push(x);
    return x;
  };
  t.after(async () => {
    for (const x of tabs) x.ws.terminate();
    await server.close();
    await manager.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  /** Lets in-flight messages land, so "nothing was sent" means something. */
  const quiet = () => new Promise((r) => setTimeout(r, 60));
  return { manager, host, clock, sent, tab, quiet };
}

test("watch edges: two tabs, a hidden tab, a closed socket, the 5 s debounce", async (t) => {
  const { host, clock, sent, tab, quiet } = await setup(t);
  assert.equal(UNWATCH_DELAY_MS, 5000);
  const a = await tab();
  const b = await tab();
  await quiet();
  assert.deepEqual(sent, [], "a tool starts unwatched; connecting alone watches nothing");

  assert.equal((await a.watch("ok")).error, undefined);
  await waitFor(() => sent.length === 1, "0→1 edge");
  assert.deepEqual(sent, [true]);
  await waitFor(() => host.state.watching === true, "the SDK saw it (tool.watching)");
  assert.equal(host.viewerCount, 1);

  await b.watch("ok"); // a second tab on the same page
  await a.watch("ok"); // repeating is a no-op
  await quiet();
  assert.equal(host.viewerCount, 2);
  assert.deepEqual(sent, [true], "1→2 sends nothing");

  await b.watch(null); // b hidden (visibilitychange) or on another page
  await quiet();
  assert.equal(host.viewerCount, 1);
  assert.deepEqual(sent, [true]);

  a.ws.terminate(); // the last viewer's socket closes: counts as leaving
  await waitFor(() => host.viewerCount === 0, "closed socket leaves");
  clock.advance(UNWATCH_DELAY_MS - 1);
  await quiet();
  assert.deepEqual(sent, [true], "not before the debounce");
  clock.advance(1);
  await waitFor(() => sent.length === 2, "1→0 edge after 5 s");
  assert.deepEqual(sent, [true, false]);
  await waitFor(() => host.state.watching === false, "the SDK saw it");

  // A quick tab switch inside the debounce sends nothing at all.
  await b.watch("ok");
  await waitFor(() => sent.length === 3, "watched again");
  await b.watch(null);
  clock.advance(3000);
  await b.watch("ok");
  clock.advance(5000);
  await quiet();
  assert.deepEqual(sent, [true, false, true], "no edge for a 3 s absence");

  // Unknown tools are refused and change nothing.
  const bad = await b.watch("nope");
  assert.equal(bad.error?.code, -32003);
  assert.equal(host.viewerCount, 1);
  const c = await tab();
  const wrong = await new Promise<Record<string, any>>((res) => {
    c.ws.send(JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tool.watch", params: { tool: 5 } }));
    const poll = setInterval(() => {
      const m = c.msgs.find((x) => x.id === 99);
      if (m) {
        clearInterval(poll);
        res(m);
      }
    }, 5);
  });
  assert.equal(wrong.error?.code, -32602);

  await b.close();
  await waitFor(() => host.viewerCount === 0, "b left");
  clock.advance(UNWATCH_DELAY_MS);
  await waitFor(() => sent.length === 4, "unwatched");
  assert.deepEqual(sent, [true, false, true, false]);
});

test("a tool restarted while watched hears watch again; one restarted unwatched hears nothing", async (t) => {
  const { host, sent, tab, quiet } = await setup(t);
  const a = await tab();
  await a.watch("ok");
  await waitFor(() => sent.length === 1, "watched");
  const first = host.pid;
  host.restart();
  await waitFor(() => host.pid !== first && host.status === "running" && sent.length === 2, "re-sent after the new handshake");
  assert.deepEqual(sent, [true, true]);
  await waitFor(() => host.state.watching === true, "the new process knows");
  await a.watch(null);
  const pid = host.pid;
  host.restart();
  await waitFor(() => host.pid !== pid && host.status === "running", "running again");
  await quiet();
  assert.deepEqual(sent, [true, true], "a new process starts unwatched; no false is needed");
  assert.equal(host.state.watching, undefined);
});
