import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import type { BuildInfo, CheckoutInfo, ToolInfo } from "@motherapp/protocol";
import { LogService } from "../src/logService.ts";
import type { Manager } from "../src/manager.ts";
import { startServer } from "../src/server.ts";
import { Checkout, compareVersions, formatVersion, readBuildInfo, readVersionNumber, VersionSource } from "../src/version.ts";
import type { GitRunner } from "../src/version.ts";

const HEAD_A = "abc1234" + "0".repeat(33);
const HEAD_B = "def5678" + "1".repeat(33);

function tmpDir(t: { after: (fn: () => void) => void }): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ma-version-"));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

test("formatVersion", () => {
  assert.equal(formatVersion("1", "abc1234", false), "v1-abc1234");
  assert.equal(formatVersion("12", "abc1234", true), "v12-abc1234-dirty");
});

test("readBuildInfo: a good file", (t) => {
  const f = path.join(tmpDir(t), "build-info.json");
  fs.writeFileSync(f, JSON.stringify({ version: "1", hash: "abc1234", dirty: true, builtAt: "2026-10-20T10:00:00Z" }));
  assert.deepEqual(readBuildInfo(f), { version: "1", hash: "abc1234", dirty: true, builtAt: "2026-10-20T10:00:00Z", string: "v1-abc1234-dirty" });
});

test("readBuildInfo: missing, broken or odd files give v?-unknown and never throw", (t) => {
  const d = tmpDir(t);
  const missing = readBuildInfo(path.join(d, "nope.json"));
  assert.equal(missing.string, "v?-unknown");
  assert.equal(missing.builtAt, null);
  assert.match(missing.error!, /not found/);

  const cases: [string, RegExp][] = [
    ["{not json", /build-info\.json: /],
    ["[1,2]", /not a JSON object/],
    ["null", /not a JSON object/],
    [JSON.stringify({ version: 1, hash: "ABC; rm", dirty: "yes" }), /no usable version\/hash/],
  ];
  for (const [body, err] of cases) {
    const f = path.join(d, "build-info.json");
    fs.writeFileSync(f, body);
    const b = readBuildInfo(f);
    assert.equal(b.string, "v?-unknown", body);
    assert.equal(b.dirty, false);
    assert.match(b.error!, err, body);
  }
  const dir = path.join(d, "adir");
  fs.mkdirSync(dir);
  assert.equal(readBuildInfo(dir).string, "v?-unknown");
});

test("readVersionNumber", (t) => {
  const d = tmpDir(t);
  assert.equal(readVersionNumber(d), "?");
  fs.writeFileSync(path.join(d, "VERSION"), "3\n");
  assert.equal(readVersionNumber(d), "3");
  fs.writeFileSync(path.join(d, "VERSION"), "0.1.0\n");
  assert.equal(readVersionNumber(d), "?");
});

function fakeGit(heads: string[]): GitRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const fn: GitRunner = async (args) => {
    calls.push(args);
    const h = heads[Math.min(calls.length - 1, heads.length - 1)]!;
    if (h === "fail") throw new Error("not a git repository");
    return h + "\n";
  };
  return Object.assign(fn, { calls });
}

test("Checkout caches HEAD, refreshes on demand and after the TTL, shares a run in flight", async (t) => {
  const repo = tmpDir(t);
  fs.writeFileSync(path.join(repo, "VERSION"), "1\n");
  let now = 1_000_000;
  const git = fakeGit([HEAD_A, HEAD_B, HEAD_B]);
  const c = new Checkout({ repo, git, now: () => now, ttlMs: 60_000 });

  const [a, a2] = await Promise.all([c.get(), c.get()]);
  assert.equal(git.calls.length, 1, "concurrent calls share one git run");
  assert.deepEqual(git.calls[0], ["rev-parse", "HEAD"]);
  assert.equal(a.hash, HEAD_A);
  assert.equal(a.short, "abc1234");
  assert.equal(a.string, "v1-abc1234");
  assert.equal(a2, a);

  for (let i = 0; i < 20; i++) await c.get(); // page loads
  assert.equal(git.calls.length, 1, "page loads reuse the cache");

  const b = await c.get(true);
  assert.equal(git.calls.length, 2);
  assert.equal(b.string, "v1-def5678");

  now += 59_000;
  await c.get();
  assert.equal(git.calls.length, 2);
  now += 2_000;
  await c.get();
  assert.equal(git.calls.length, 3, "re-read after the TTL");
});

test("Checkout: git failing gives null hashes, no throw", async (t) => {
  const repo = tmpDir(t);
  const c = new Checkout({ repo, git: fakeGit(["fail"]) });
  const r = await c.get();
  assert.equal(r.hash, null);
  assert.equal(r.string, null);
  assert.equal(r.version, "?");
  assert.match(r.error!, /not a git repository/);
  const garbage = await new Checkout({ repo, git: fakeGit(["fatal: something"]) }).get();
  assert.equal(garbage.hash, null);
});

test("Checkout with the real git on this repo", async () => {
  const repo = path.resolve(import.meta.dirname, "..", "..");
  const r = await new Checkout({ repo }).get();
  if (r.hash === null) return; // not a git checkout (e.g. an exported tarball)
  assert.match(r.hash, /^[0-9a-f]{40}$/);
  assert.match(r.string!, /^v[0-9?]+-[0-9a-f]{7}$/);
});

const build = (hash: string, dirty = false, version = "1"): BuildInfo => ({
  version,
  hash,
  dirty,
  builtAt: "2026-10-20T10:00:00Z",
  string: formatVersion(version, hash, dirty),
});
const checkout = (hash: string | null, version = "1"): CheckoutInfo => ({
  hash,
  short: hash ? hash.slice(0, 7) : null,
  version,
  string: hash ? formatVersion(version, hash.slice(0, 7), false) : null,
  checkedAt: "2026-10-20T10:01:00Z",
});

test("compareVersions: behind-checkout detection", () => {
  const cur = compareVersions(build("abc1234"), checkout(HEAD_A));
  assert.equal(cur.status, "current");
  assert.equal(cur.message, undefined);

  // a dirty build of the same commit is not "behind"
  assert.equal(compareVersions(build("abc1234", true), checkout(HEAD_A)).status, "current");
  // git may abbreviate with more than 7 characters
  assert.equal(compareVersions(build("abc12340"), checkout(HEAD_A)).status, "current");

  const behind = compareVersions(build("abc1234"), checkout(HEAD_B));
  assert.equal(behind.status, "behind");
  assert.equal(behind.message, "running v1-abc1234, checkout is at v1-def5678, run `motherapp install`");

  const bumped = compareVersions(build("abc1234"), checkout(HEAD_A, "2"));
  assert.equal(bumped.status, "behind");
  assert.equal(bumped.message, "running v1-abc1234, checkout is at v2-abc1234, run `motherapp install`");

  assert.equal(compareVersions(readBuildInfo("/nonexistent/build-info.json"), checkout(HEAD_B)).status, "unknown");
  assert.equal(compareVersions(build("abc1234"), checkout(null)).status, "unknown");
});

/** A Manager stand-in with just what the server touches. */
function fakeManager(tools: ToolInfo[]): Manager {
  const m = new EventEmitter() as unknown as Manager & { list: () => ToolInfo[] };
  Object.assign(m, { hosts: new Map(), list: () => tools });
  return m;
}

test("server: /api/status and version.get report the build and the checkout", async (t) => {
  const dir = tmpDir(t);
  fs.writeFileSync(path.join(dir, "VERSION"), "1\n");
  const git = fakeGit([HEAD_A, HEAD_B]);
  const version = new VersionSource(build("abc1234"), new Checkout({ repo: dir, git }));
  const tools: ToolInfo[] = [
    { id: "audio", title: "Audio", enabled: true, status: "running" },
    { id: "brightness", title: "Brightness", enabled: true, status: "failed", statusText: "5 crashes in 2 min" },
  ];
  const server = await startServer({ manager: fakeManager(tools), log: new LogService({ stdout: null }), webDir: dir, port: 0, version });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;

  const s1 = (await (await fetch(`${base}/api/status`)).json()) as any;
  assert.equal(s1.version.status, "current");
  assert.equal(s1.version.running.string, "v1-abc1234");
  assert.deepEqual(s1.tools, [
    { id: "audio", title: "Audio", enabled: true, status: "running" },
    { id: "brightness", title: "Brightness", enabled: true, status: "failed", statusText: "5 crashes in 2 min" },
  ]);
  await fetch(`${base}/api/status`);
  assert.equal(git.calls.length, 1, "cached between requests");

  const s2 = (await (await fetch(`${base}/api/status?refresh=1`)).json()) as any;
  assert.equal(git.calls.length, 2);
  assert.equal(s2.version.status, "behind");
  assert.equal(s2.version.message, "running v1-abc1234, checkout is at v1-def5678, run `motherapp install`");

  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  await new Promise((r, j) => (ws.once("open", r), ws.once("error", j)));
  const reply = new Promise<any>((r) =>
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      if (m.id === 1) r(m);
    }),
  );
  ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "version.get", params: {} }));
  const m = await reply;
  assert.equal(m.result.status, "behind");
  assert.equal(m.result.checkout.string, "v1-def5678");
  assert.equal(git.calls.length, 2, "version.get without refresh uses the cache");
  ws.close();
});
