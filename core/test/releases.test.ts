// The latest-release check against a fake GitHub API server (newer/same/older, 304 with ETag,
// network errors, rate limits, timeouts) and the `updateCheck: false` setting.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { isNewerRelease, releaseNumber, ReleaseChecker } from "../src/releases.ts";
import { loadConfig } from "../src/config.ts";

test("releaseNumber and isNewerRelease", () => {
  assert.equal(releaseNumber("v2"), 2);
  assert.equal(releaseNumber("v10"), 10);
  for (const t of ["2", "v2.1", "v", "release-3", "v-1", "V2", ""]) assert.equal(releaseNumber(t), undefined, t);
  assert.equal(isNewerRelease("v3", "2"), true);
  assert.equal(isNewerRelease("v10", "9"), true, "numbers, not strings");
  assert.equal(isNewerRelease("v2", "2"), false);
  assert.equal(isNewerRelease("v1", "2"), false);
  assert.equal(isNewerRelease("v3", "?"), false, "unknown running version: never 'newer'");
  assert.equal(isNewerRelease(null, "2"), false);
  assert.equal(isNewerRelease("v3.1", "2"), false);
});

interface Hit {
  headers: http.IncomingHttpHeaders;
}

/** A fake api.github.com: `reply` decides each answer. */
async function fakeGitHub(t: { after: (fn: () => Promise<void> | void) => void }, reply: (req: http.IncomingMessage, res: http.ServerResponse, n: number) => void) {
  const hits: Hit[] = [];
  const server = http.createServer((req, res) => {
    hits.push({ headers: req.headers });
    reply(req, res, hits.length);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/repos/erkantaylan/motherapp/releases/latest`;
  return { url, hits };
}

const release = (tag: string, etag = '"e1"') => (_req: http.IncomingMessage, res: http.ServerResponse) => {
  res.writeHead(200, { "content-type": "application/json", etag });
  res.end(JSON.stringify({ tag_name: tag, html_url: `https://github.com/erkantaylan/motherapp/releases/tag/${tag}`, name: tag }));
};

function tmpFile(t: { after: (fn: () => void) => void }, name = "release-check.json"): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ma-release-"));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return path.join(d, name);
}

test("latest is newer, the same, or older than the running build", async (t) => {
  for (const [tag, current, newer] of [["v3", "2", true], ["v2", "2", false], ["v1", "2", false]] as const) {
    const gh = await fakeGitHub(t, release(tag));
    const c = new ReleaseChecker({ current, enabled: true, url: gh.url, now: () => Date.parse("2026-10-21T10:00:00Z") });
    const info = await c.check();
    assert.deepEqual(info, { latest: tag, latestUrl: `https://github.com/erkantaylan/motherapp/releases/tag/${tag}`, newer, checkedAt: "2026-10-21T10:00:00.000Z" }, `${tag} vs v${current}`);
    assert.equal(gh.hits.length, 1);
    assert.equal(gh.hits[0]!.headers["user-agent"], `motherapp/${current}`, "GitHub wants a User-Agent");
    assert.equal(gh.hits[0]!.headers.authorization, undefined, "unauthenticated");
    assert.match(String(gh.hits[0]!.headers.accept), /application\/vnd\.github\+json/);
  }
});

test("304: the ETag is sent back and the cached answer kept, also across a restart", async (t) => {
  const file = tmpFile(t);
  const gh = await fakeGitHub(t, (req, res, n) => {
    if (n === 1) return release("v3", '"abc"')(req, res);
    assert.equal(req.headers["if-none-match"], '"abc"');
    res.writeHead(304, { etag: '"abc"' });
    res.end();
  });
  let now = Date.parse("2026-10-21T10:00:00Z");
  const c = new ReleaseChecker({ current: "2", enabled: true, url: gh.url, cacheFile: file, now: () => now });
  assert.equal((await c.check()).latest, "v3");
  now += 60_000;
  const second = await c.check();
  assert.equal(second.latest, "v3");
  assert.equal(second.newer, true);
  assert.equal(second.checkedAt, "2026-10-21T10:01:00.000Z");
  assert.equal(second.error, undefined);
  assert.equal(gh.hits[0]!.headers["if-none-match"], undefined, "no ETag before the first answer");

  // A new core (restart) starts from the cache file and asks conditionally.
  const again = new ReleaseChecker({ current: "2", enabled: true, url: gh.url, cacheFile: file, now: () => now });
  assert.equal(again.info().latest, "v3", "known before any request");
  assert.equal(again.info().newer, true);
  await again.check();
  assert.equal(gh.hits.length, 3);
  assert.equal(gh.hits[2]!.headers["if-none-match"], '"abc"');
  // After an update to v3 the same cache says "not newer".
  assert.equal(new ReleaseChecker({ current: "3", enabled: true, url: gh.url, cacheFile: file }).info().newer, false);
});

test("a network error never throws, keeps the last answer and says why", async (t) => {
  let up = true;
  const gh = await fakeGitHub(t, (req, res) => (up ? release("v3")(req, res) : res.destroy()));
  const c = new ReleaseChecker({ current: "2", enabled: true, url: gh.url });
  await c.check();
  up = false;
  const info = await c.check();
  assert.equal(info.latest, "v3", "last good answer kept");
  assert.equal(info.newer, true);
  assert.match(info.error!, /^network error/);

  // A port nobody listens on (fetch refuses port 1 and other "bad ports" before connecting).
  const closed = http.createServer();
  await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
  const port = (closed.address() as AddressInfo).port;
  await new Promise<void>((r) => closed.close(() => r()));
  const nobody = new ReleaseChecker({ current: "2", enabled: true, url: `http://127.0.0.1:${port}/x` });
  const none = await nobody.check();
  assert.equal(none.latest, null);
  assert.equal(none.newer, false);
  assert.match(none.error!, /network error \(ECONNREFUSED\)/);
});

test("a server that doesn't answer times out", async (t) => {
  const gh = await fakeGitHub(t, () => {
    // never answers
  });
  const c = new ReleaseChecker({ current: "2", enabled: true, url: gh.url, timeoutMs: 200 });
  const started = Date.now();
  const info = await c.check();
  assert.ok(Date.now() - started < 3000);
  assert.equal(info.error, "no answer from GitHub within 0.2 s");
});

test("rate-limited 403: says until when, and doesn't ask again before then", async (t) => {
  const reset = Math.floor(Date.parse("2026-10-21T11:00:00Z") / 1000);
  const gh = await fakeGitHub(t, (_req, res) => {
    res.writeHead(403, { "content-type": "application/json", "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) });
    res.end(JSON.stringify({ message: "API rate limit exceeded" }));
  });
  let now = Date.parse("2026-10-21T10:00:00Z");
  const c = new ReleaseChecker({ current: "2", enabled: true, url: gh.url, now: () => now });
  const info = await c.check();
  assert.equal(info.error, "rate-limited by GitHub until 2026-10-21T11:00:00.000Z");
  now += 10 * 60_000;
  assert.equal((await c.check()).error, "rate-limited by GitHub until 2026-10-21T11:00:00.000Z");
  assert.equal(gh.hits.length, 1, "no request while rate-limited");
  now = Date.parse("2026-10-21T11:00:01Z");
  await c.check();
  assert.equal(gh.hits.length, 2, "asks again after the reset");
});

test("other answers: 429 with Retry-After, a plain 403, 500, 404, bad JSON, a non-v<N> tag", async (t) => {
  const answers: [number, Record<string, string>, string][] = [
    [429, { "retry-after": "120" }, "{}"],
    [403, {}, "{}"],
    [500, {}, "oops"],
    [404, {}, '{"message":"Not Found"}'],
    [200, {}, "{not json"],
    [200, {}, JSON.stringify({ tag_name: "v2.1", html_url: "https://github.com/x" })],
  ];
  const gh = await fakeGitHub(t, (_req, res, n) => {
    const [status, headers, body] = answers[n - 1]!;
    res.writeHead(status, headers);
    res.end(body);
  });
  const now = Date.parse("2026-10-21T10:00:00Z");
  const mk = () => new ReleaseChecker({ current: "2", enabled: true, url: gh.url, now: () => now });
  assert.equal((await mk().check()).error, "rate-limited by GitHub until 2026-10-21T10:02:00.000Z");
  assert.equal((await mk().check()).error, "GitHub answered HTTP 403");
  assert.equal((await mk().check()).error, "GitHub answered HTTP 500");
  const noRelease = await mk().check();
  assert.equal(noRelease.error, undefined, "404 = no release yet, not an error");
  assert.equal(noRelease.latest, null);
  assert.match((await mk().check()).error!, /isn't JSON/);
  assert.equal((await mk().check()).error, `the latest release's tag "v2.1" isn't v<N>`);
});

test("updateCheck: false in config.json: no request at all", async (t) => {
  const file = tmpFile(t, "config.json");
  fs.writeFileSync(file, JSON.stringify({ port: 7323, tools: {}, updateCheck: false }));
  const { config } = loadConfig(file);
  assert.equal(config.updateCheck, false);
  fs.writeFileSync(file, JSON.stringify({ updateCheck: "no" }));
  assert.equal(loadConfig(file).config.updateCheck, undefined, "only false turns it off");

  const gh = await fakeGitHub(t, release("v9"));
  const c = new ReleaseChecker({ current: "2", enabled: config.updateCheck !== false, url: gh.url });
  c.start();
  t.after(() => c.stop());
  const info = await c.check();
  assert.deepEqual(info, { latest: null, latestUrl: null, newer: false, checkedAt: null, disabled: true });
  assert.equal(gh.hits.length, 0);
});

test("start() checks at once and on the interval; listeners hear every check", async (t) => {
  const gh = await fakeGitHub(t, release("v3"));
  const c = new ReleaseChecker({ current: "2", enabled: true, url: gh.url, intervalMs: 50 });
  const seen: (string | null)[] = [];
  c.onChange((i) => seen.push(i.latest));
  c.start();
  t.after(() => c.stop());
  const deadline = Date.now() + 3000;
  while (seen.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  assert.ok(seen.length >= 2, `checks seen: ${seen.length}`);
  assert.equal(seen[0], "v3");
});

test("concurrent checks share one request", async (t) => {
  const gh = await fakeGitHub(t, release("v3"));
  const c = new ReleaseChecker({ current: "2", enabled: true, url: gh.url });
  const [a, b] = await Promise.all([c.check(), c.check()]);
  assert.deepEqual(a, b);
  assert.equal(gh.hits.length, 1);
});
