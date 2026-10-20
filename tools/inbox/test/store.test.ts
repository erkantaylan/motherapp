// Hashed token storage, file modes, and the "all dead tokens look the same" rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { linkOptions, parseDuration } from "../src/limits.ts";
import { RateLimiter } from "../src/ratelimit.ts";
import { LOG_MAX, Store, TOKEN_RE, hashToken, linkStatus, newToken } from "../src/store.ts";
import { tmpDir } from "./fakes.ts";

const pane = { id: "%1", target: "motherapp:0.0", pid: 1001, path: "/home/u/p" };
const opts = { expiresMs: 24 * 3600_000, label: "cloud", pane, host: "a.trycloudflare.com" };
const mode = (p: string) => fs.statSync(p).mode & 0o777;

test("tokens: 32 random bytes, base64url, 43 characters, all different", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const t = newToken();
    assert.match(t, TOKEN_RE);
    assert.equal(Buffer.from(t, "base64url").length, 32);
    seen.add(t);
  }
  assert.equal(seen.size, 200);
});

test("only the SHA-256 is stored, in a 0700 directory and 0600 files", () => {
  const dir = path.join(tmpDir("store"), "inbox");
  const s = new Store(dir);
  const { link, token } = s.create(opts, 1000);
  const raw = fs.readFileSync(s.linksFile, "utf8");
  assert.ok(!raw.includes(token), "the token is not in the file");
  assert.ok(raw.includes(crypto.createHash("sha256").update(token).digest("hex")));
  assert.equal(link.hash, hashToken(token));
  assert.equal(link.last4, token.slice(-4));
  assert.equal(mode(dir), 0o700);
  assert.equal(mode(s.linksFile), 0o600);
  s.addDelivery({ time: 1, linkId: link.id, label: "cloud", pane: "motherapp:0.0", text: "[inbox: cloud] hi", result: "submitted" });
  assert.equal(mode(s.logFile), 0o600);
  assert.ok(!fs.readFileSync(s.logFile, "utf8").includes(token));
  // A directory that was too open is tightened on the next write.
  fs.chmodSync(dir, 0o755);
  s.create(opts, 1000);
  assert.equal(mode(dir), 0o700);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["deliveries.json", "links.json"], "no temp files left");
  // A second store reads the same links back.
  assert.equal(new Store(dir).verify(token, 2000)?.id, link.id);
});

test("verify: unknown, malformed, revoked and expired tokens all give undefined", () => {
  const s = new Store(tmpDir("verify"));
  const live = s.create(opts, 0);
  const revoked = s.create(opts, 0);
  const expired = s.create({ ...opts, expiresMs: 1000 }, 0);
  s.revoke(revoked.link.id, 10);
  s.recordUse(live.link.id);
  const now = 5000;
  assert.equal(s.verify(live.token, now)?.id, live.link.id);
  for (const t of [newToken(), revoked.token, expired.token, "", "short", live.token + "x", live.token.slice(0, -1) + "?", "../../etc/passwd"]) {
    assert.equal(s.verify(t, now), undefined, t);
  }
  assert.equal(linkStatus(s.get(revoked.link.id)!, now), "revoked");
  assert.equal(linkStatus(s.get(expired.link.id)!, now), "expired");
  assert.equal(s.get(live.link.id)!.uses, 1);
  assert.deepEqual(s.active(now).map((l) => l.id), [live.link.id]);
  assert.equal(s.revoke(revoked.link.id, now), false, "revoking twice fails");
  assert.equal(s.revoke("nope", now), false);
});

test("prune forgets links a week after they ended; the delivery log is capped", () => {
  const s = new Store(tmpDir("prune"));
  const a = s.create({ ...opts, expiresMs: 1000 }, 0);
  s.create(opts, 0);
  s.prune(8 * 86_400_000);
  assert.equal(s.get(a.link.id), undefined);
  for (let i = 0; i < LOG_MAX + 5; i++) s.addDelivery({ time: i, linkId: "x", label: "l", pane: "p", text: `t${i}`, result: "submitted" });
  const d = s.deliveries();
  assert.equal(d.length, LOG_MAX);
  assert.equal(d.at(-1)!.text, `t${LOG_MAX + 4}`);
  assert.equal(d.at(-1)!.seq, LOG_MAX + 5);
});

test("links stored with the old maxUses/maxLen fields still load; the fields are dropped", () => {
  const dir = tmpDir("old");
  const tokens = [newToken(), newToken(), newToken()];
  const old = (i: number, more: Record<string, unknown>) => ({
    id: `old${i}`,
    hash: hashToken(tokens[i]!),
    last4: tokens[i]!.slice(-4),
    label: "cloud",
    pane,
    host: "a.trycloudflare.com",
    created: 1000,
    expires: 1000 + 86_400_000,
    ...more,
  });
  const links = [old(0, { maxUses: 20, uses: 3, maxLen: 500 }), old(1, { maxUses: 2, uses: 2, maxLen: 100 }), old(2, {})];
  fs.writeFileSync(path.join(dir, "links.json"), JSON.stringify({ version: 1, links }));
  const s = new Store(dir);
  assert.deepEqual(s.problems, []);
  const a = s.verify(tokens[0]!, 5000)!;
  assert.equal(a.id, "old0");
  assert.equal(a.uses, 3);
  assert.ok(!("maxUses" in a) && !("maxLen" in a), "old limits are ignored");
  assert.equal(s.verify(tokens[1]!, 5000), undefined, "a link that had used up its messages stays ended");
  assert.equal(linkStatus(s.get("old1")!, 5000), "revoked");
  assert.equal(s.verify(tokens[2]!, 5000)?.uses, 0, "no uses field: 0");
  s.recordUse("old0");
  const saved = fs.readFileSync(s.linksFile, "utf8");
  assert.ok(!saved.includes("maxUses") && !saved.includes("maxLen"), "dropped on the next write");
});

test("an unreadable links file is reported, not fatal", () => {
  const dir = tmpDir("bad");
  fs.writeFileSync(path.join(dir, "links.json"), "{nope");
  const s = new Store(dir);
  assert.equal(s.all().length, 0);
  assert.match(s.problems[0]!, /cannot read/);
});

test("link options: only the expiry, in hours (default 24), bounds, durations", () => {
  assert.deepEqual(linkOptions({}), { expiresMs: 86_400_000 });
  assert.deepEqual(linkOptions({ hours: "1.5" }), { expiresMs: 5_400_000 });
  assert.deepEqual(linkOptions({ hours: 2 }), { expiresMs: 7_200_000 });
  assert.deepEqual(linkOptions({ expires: "90m" }), { expiresMs: 5_400_000 });
  assert.deepEqual(linkOptions({ expires: "48" }), { expiresMs: 48 * 3600_000 });
  assert.deepEqual(linkOptions({ maxUses: 3, maxLen: 100 } as never), { expiresMs: 86_400_000 }, "old options are ignored");
  assert.equal(parseDuration("1h30m"), 5_400_000);
  assert.equal(parseDuration("7d"), 604_800_000);
  for (const bad of [{ expires: "forever" }, { expires: "10s" }, { expires: "31d" }, { hours: 0 }, { hours: "-1" }, { hours: 721 }, { hours: "abc" }, { expires: true }]) {
    assert.throws(() => linkOptions(bad), JSON.stringify(bad));
  }
});

test("rate limiter: 6 per sliding minute, then the wait until the oldest drops out", () => {
  const r = new RateLimiter(6);
  for (let i = 0; i < 6; i++) assert.equal(r.hit("a", 1000 + i), 0);
  assert.equal(r.hit("a", 2000), 60_000 - 1000);
  assert.equal(r.hit("b", 2000), 0, "per key");
  assert.equal(r.hit("a", 61_000), 0, "the first hit has left the window");
  r.forget("a");
  assert.equal(r.hit("a", 61_001), 0);
});
