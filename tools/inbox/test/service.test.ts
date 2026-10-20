// The inbox end to end inside one process: actions over the serve channel, the real HTTP
// listener on 127.0.0.1, a fake tmux and a fake cloudflared.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { BODY_CAP } from "../src/http.ts";
import { InboxService } from "../src/service.ts";
import { PEER_RULE } from "../src/skill.ts";
import { hashToken } from "../src/store.ts";
import { Store } from "../src/store.ts";
import { advanceUntil, claudePane, harness, waitFor } from "./fakes.ts";
import type { Harness } from "./fakes.ts";

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function req(url: string, method = "GET", body?: string | Buffer, headers: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = http.request(url, { method, headers, agent: false }, (res) => {
      let b = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: b }));
    });
    r.on("error", reject);
    if (body !== undefined) r.end(body);
    else r.end();
  });
}

const post = (h: Harness, token: string, msg: unknown, headers: Record<string, string> = {}) =>
  req(h.url(`/inbox/${token}`), "POST", typeof msg === "string" ? msg : JSON.stringify(msg), { "content-type": "application/json", ...headers });

async function create(h: Harness, args: Record<string, unknown> = {}) {
  const r = await h.call("create", { pane: "motherapp:0.1", label: "cloud", ...args });
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  const token = /\/inbox\/([A-Za-z0-9_-]{43})$/.exec(r.result.link)![1]!;
  return { ...r.result, token } as { id: string; link: string; message: string; token: string };
}

/** Everything the tool emitted except the one reply that carries the link. */
const exceptCreateReplies = (h: Harness) => h.out.filter((l) => !(JSON.parse(l).result?.link));

test("create: a link on the tunnel host, shown once; the token is in no state, log or file", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const r = await create(h, { hours: "2" });
  assert.match(r.link, /^https:\/\/first-tunnel-aa\.trycloudflare\.com\/inbox\/[A-Za-z0-9_-]{43}$/);
  assert.equal(r.message, `${r.link}\nGET this link first; it explains how to message me.`);
  assert.deepEqual(h.runner.cf.starts[0], ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${h.service.port}`]);
  const row = h.tool.get(`links.${r.id}`) as Record<string, unknown>;
  assert.equal(row.label, "cloud");
  assert.equal(row.pane, "motherapp:0.1");
  assert.equal(row.expires, h.timers.now() + 2 * 3600_000);
  assert.equal(row.maxUses, undefined);
  assert.equal(row.last4, r.token.slice(-4));
  assert.equal(h.tool.get("activeCount"), 1);
  const everything = JSON.stringify(h.tool.snapshot()) + exceptCreateReplies(h).join("\n");
  assert.ok(!everything.includes(r.token), "no token in state or on the channel");
  assert.ok(!everything.includes(hashToken(r.token)), "not even its hash");
  assert.ok(h.logs().some((l) => l.msg === "inbox link created" && l.fields?.link === r.id));
});

test("create: refuses a pane that isn't Claude or doesn't exist, and bad options", async (t) => {
  const h = await harness({ panes: [claudePane(1), claudePane(2, { command: "bash" })] });
  t.after(() => h.close());
  assert.match((await h.call("create", { pane: "motherapp:0.2", label: "x" })).error!.message, /runs bash, not Claude/);
  assert.match((await h.call("create", { pane: "motherapp", label: "x" })).error!.message, /no tmux pane motherapp/);
  assert.equal((await h.call("create", { pane: "%1", expires: "100d" })).error!.code, -32602);
  assert.equal((await h.call("create", {})).error!.code, -32602);
  assert.equal(h.runner.cf.starts.length, 0, "no tunnel for a refused link");
  // the pane list shows only Claude panes
  await h.service.pollPanes();
  assert.deepEqual(Object.keys(h.tool.get("panes") as object), ["1"]);
  assert.deepEqual(h.tool.get("panes.1"), { id: "%1", target: "motherapp:0.1", path: "~/Desktop/projects/motherapp", attached: "attached", command: "claude" });
});

test("create: a tunnel that never comes up fails the create and is stopped again", async (t) => {
  const h = await harness({ service: { hostTimeoutMs: 100 } });
  t.after(() => h.close());
  h.runner.cf.behaviour = "silent";
  const r = await h.call("create", { pane: "%1", label: "x" });
  assert.match(r.error!.message, /didn't come up/);
  await waitFor(() => h.runner.cf.live().length === 0, "cloudflared killed");
  assert.equal(h.tool.get("activeCount"), 0);
});

test("GET returns the skill for agents; HEAD too", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const r = await create(h);
  const g = await req(h.url(`/inbox/${r.token}`));
  assert.equal(g.status, 200);
  assert.match(g.headers["content-type"]!, /^text\/markdown/);
  assert.equal(g.headers["cache-control"], "no-store");
  for (const s of ["motherapp:0.1", "[inbox: cloud]", "POST", '"ref": "#10"', "**32 KiB** of JSON", "at most 6 per minute, or 10 are already waiting", "Never commit, log or post this URL", "SendMessage", "| `409` |", "| `429` |", PEER_RULE]) {
    assert.ok(g.body.includes(s), s);
  }
  assert.ok(!g.body.includes(r.token), "the skill doesn't repeat the token");
  assert.ok(!/more messages?|characters\*\*|used-up/.test(g.body), "no per-link message count or length");
  const head = await req(h.url(`/inbox/${r.token}`), "HEAD");
  assert.deepEqual([head.status, head.body], [200, ""]);
});

test("POST: typed as `[inbox: label] (re ref) text`, cleaned, in two tmux calls; logged", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const r = await create(h);
  const res = await post(h, r.token, { text: "CI is red\r\non main \x1b[31m\u202Enow\t", ref: "#10" }, { "cf-connecting-ip": "203.0.113.9", "user-agent": "curl/8.5" + String.fromCharCode(0xe9) + "x" });
  assert.equal(res.status, 200, res.body);
  assert.deepEqual(JSON.parse(res.body), { status: "delivered", result: "submitted" });
  const pane = h.runner.tmux.panes[0]!;
  assert.deepEqual(pane.submitted, ["[inbox: cloud] (re #10) CI is red on main now"]);
  assert.deepEqual(h.runner.tmux.sends(), [["-l", "--", "[inbox: cloud] (re #10) CI is red on main now"], ["Enter"]]);
  const log = Object.values(h.tool.get("log") as Record<string, { text: string; result: string; linkId: string }>);
  assert.deepEqual(log.map((e) => [e.linkId, e.text, e.result]), [[r.id, "[inbox: cloud] (re #10) CI is red on main now", "submitted"]]);
  // the sender as cloudflared reports it, cleaned; on the page only, not in the journal
  assert.equal((log[0] as { from?: string }).from, "ip 203.0.113.9, ua curl/8.5x");
  assert.ok(!JSON.stringify(h.logs()).includes("203.0.113.9"));
  assert.equal((h.tool.get(`links.${r.id}`) as { uses: number }).uses, 1);
  // the journal gets the outcome, never the text
  const msgLog = h.logs().find((l) => l.msg === "inbox message submitted")!;
  assert.deepEqual(msgLog.fields, { link: r.id, pane: "motherapp:0.1", chars: "[inbox: cloud] (re #10) CI is red on main now".length });
  assert.ok(!JSON.stringify(h.logs()).includes("CI is red"));
});

test("unknown, revoked and expired tokens, other paths and methods: the same 404", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const live = await create(h);
  const revoked = await create(h);
  const expiring = await create(h, { expires: "1m" });
  assert.equal((await post(h, live.token, { text: "the only one" })).status, 200);
  assert.equal((await h.call("revoke", { id: revoked.id })).error, undefined);
  h.timers.t += 61_000;
  const fake = "A".repeat(43);
  const probes: [string, string, string?][] = [
    [`/inbox/${fake}`, "GET"],
    [`/inbox/${fake}`, "POST", '{"text":"x"}'],
    [`/inbox/${revoked.token}`, "GET"],
    [`/inbox/${revoked.token}`, "POST", '{"text":"x"}'],
    [`/inbox/${expiring.token}`, "GET"],
    [`/inbox/${expiring.token}`, "POST", '{"text":"x"}'],
    [`/inbox/${live.token}`, "PUT", '{"text":"x"}'],
    [`/inbox/${live.token}`, "DELETE"],
    [`/inbox/${live.token}/x`, "GET"],
    [`/INBOX/${live.token}`, "GET"],
    [`/inbox/${live.token.slice(0, 42)}`, "GET"],
    ["/inbox/", "GET"],
    ["/", "GET"],
    ["/ws", "GET"],
    ["/tools/inbox/page.ts", "GET"],
    ["/inbox/../tools/inbox/page.ts", "GET"],
    [`/inbox/${fake}`, "POST", "x".repeat(BODY_CAP * 2)],
  ];
  const seen = new Set<string>();
  for (const [p, method, body] of probes) {
    const r = await req(h.url(p), method, body, { "x-forwarded-for": "127.0.0.1", "x-forwarded-host": "localhost" });
    assert.equal(r.status, 404, `${method} ${p}`);
    seen.add(JSON.stringify([r.status, r.body, r.headers["content-type"], r.headers["content-length"], r.headers["cache-control"], r.headers.connection]));
  }
  assert.equal(seen.size, 1, `all 404s identical: ${[...seen].join(" | ")}`);
  assert.equal((await req(h.url(`/inbox/${live.token}`))).status, 200, "the live one still works");
  assert.deepEqual(h.runner.tmux.panes[0]!.submitted, ["[inbox: cloud] the only one"], "nothing else was typed");
});

test("400 bad JSON or text, 413 only for a body over the cap, nothing typed", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const r = await create(h);
  for (const body of ["{not json", "[]", '"text"', '{"text": 5}', "{}"]) assert.equal((await post(h, r.token, body)).status, 400, body);
  assert.equal((await post(h, r.token, { text: " \r\n\x1b[0m\t " })).status, 400, "empty after cleaning");
  h.timers.t += 60_000; // every attempt counts against the 6 per minute
  assert.equal((await post(h, r.token, { text: "short" })).status, 200);
  assert.equal((await post(h, r.token, { text: "x".repeat(20_000) + "\x1b[31m\u200B" })).status, 200, "long text is fine under the body cap");
  assert.equal(h.runner.tmux.panes[0]!.submitted[1], `[inbox: cloud] ${"x".repeat(20_000)}`, "cleaned, not cut");
  assert.equal((await post(h, r.token, { text: "x", pad: "y".repeat(BODY_CAP) })).status, 413, "body cap");
  assert.equal((await post(h, r.token, "{}", { "content-length": String(BODY_CAP + 1) }).catch(() => ({ status: 413 }))).status, 413, "declared length over the cap");
  assert.equal(h.runner.tmux.panes[0]!.submitted.length, 2);
});

test("429 after 6 messages in a minute per link, with Retry-After; the next minute works", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const a = await create(h);
  const b = await create(h);
  for (let i = 0; i < 6; i++) {
    assert.equal((await post(h, a.token, { text: `m${i}` })).status, 200);
    h.timers.t += 1000;
  }
  const limited = await post(h, a.token, { text: "seventh" });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers["retry-after"], "54");
  assert.equal((await post(h, b.token, { text: "other link" })).status, 200, "per link");
  h.timers.t += 54_000;
  assert.equal((await post(h, a.token, { text: "later" })).status, 200);
  assert.ok(!h.runner.tmux.panes[0]!.submitted.some((s) => s.includes("seventh")));
});

test("409 when the pane no longer runs Claude, or is a different pane now; nothing typed", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const r = await create(h);
  const pane = h.runner.tmux.panes[0]!;
  pane.command = "bash";
  const res = await post(h, r.token, { text: "hello" });
  assert.equal(res.status, 409);
  assert.match(JSON.parse(res.body).error, /nothing was typed/);
  pane.command = "claude";
  pane.pid = 9999; // tmux restarted, a new pane got the same id
  assert.equal((await post(h, r.token, { text: "hello" })).status, 409);
  h.runner.tmux.panes = [];
  assert.equal((await post(h, r.token, { text: "hello" })).status, 409);
  assert.deepEqual(h.runner.tmux.sends(), []);
  assert.equal((h.tool.get(`links.${r.id}`) as { uses: number }).uses, 0, "a refused message is not a use");
  assert.ok(Object.values(h.tool.get("log") as Record<string, { result: string }>).every((e) => e.result.startsWith("rejected: ")));
});

test("held while the user types, Claude works, a dialog is open or copy mode is on; delivered when idle", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const r = await create(h);
  const pane = h.runner.tmux.panes[0]!;
  pane.input = "half a thought";
  const res = await post(h, r.token, { text: "first" });
  assert.equal(res.status, 202);
  assert.deepEqual(JSON.parse(res.body), { status: "queued", pending: 1, reason: "someone is typing in the pane (input not empty)" });
  assert.equal(pane.input, "half a thought", "nothing mixed into the user's line");
  assert.equal((await post(h, r.token, { text: "second" })).status, 202);
  const row = () => h.tool.get(`links.${r.id}`) as { pending: number; held: string };
  assert.deepEqual([row().pending, row().held, (row() as unknown as { check: string }).check], [2, "someone is typing in the pane (input not empty)", "input-not-empty"]);

  const WORKING = "Claude is working (busy marker \"… to interrupt\" near the box)";
  for (const [state, reason] of [
    [{ input: "", working: true }, WORKING],
    [{ working: false, dialog: true }, "Claude's input box isn't on screen (a dialog, or not Claude's prompt): no `>` prompt line found"],
    [{ dialog: false, inMode: true }, "the pane is in copy mode"],
  ] as const) {
    Object.assign(pane, state);
    await advanceUntil(h.timers, () => row().held === reason, reason);
    assert.equal(row().pending, 2);
  }
  assert.deepEqual(h.runner.tmux.sends(), [], "nothing typed while busy");

  pane.inMode = false;
  // One message per pump tick (Claude is busy after it anyway): stepping stops at the first.
  await advanceUntil(h.timers, () => pane.submitted.length === 1, "first delivered");
  await waitFor(() => row().pending === 1, "first no longer pending"); // published after the send
  assert.deepEqual(pane.submitted, ["[inbox: cloud] first"]);
  pane.working = true;
  await advanceUntil(h.timers, () => row().held === WORKING, "second held while Claude works");
  assert.equal(pane.submitted.length, 1);
  pane.working = false;
  await advanceUntil(h.timers, () => pane.submitted.length === 2, "second delivered");
  assert.deepEqual(pane.submitted, ["[inbox: cloud] first", "[inbox: cloud] second"], "in order");
  await waitFor(() => row().pending === 0, "nothing pending");
  const results = Object.values(h.tool.get("log") as Record<string, { result: string }>).map((e) => e.result);
  assert.deepEqual(results, ["queued: someone is typing in the pane (input not empty)", "queued: someone is typing in the pane (input not empty)", "submitted", "submitted"]);
});

test("the queue holds at most 10 per link; revoking drops what waits and stops the tunnel", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const r = await create(h);
  h.runner.tmux.panes[0]!.working = true;
  for (let i = 0; i < 6; i++) assert.equal((await post(h, r.token, { text: `q${i}` })).status, 202);
  h.timers.t += 60_000;
  for (let i = 6; i < 10; i++) assert.equal((await post(h, r.token, { text: `q${i}` })).status, 202);
  const full = await post(h, r.token, { text: "q10" });
  assert.equal(full.status, 429);
  assert.match(JSON.parse(full.body).error, /10 messages are already waiting/);
  assert.equal(h.runner.cf.live().length, 1);
  await h.call("revoke", { id: r.id });
  const results = Object.values(h.tool.get("log") as Record<string, { result: string }>).map((e) => e.result);
  assert.equal(results.filter((x) => x === "dropped: link revoked").length, 10);
  assert.equal(h.tool.get(`links.${r.id}`), undefined);
  assert.equal(h.tool.get("activeCount"), 0);
  await waitFor(() => h.runner.cf.live().length === 0, "tunnel stopped");
  assert.equal((await post(h, r.token, { text: "after" })).status, 404);
  assert.match((await h.call("revoke", { id: r.id })).error!.message, /no active link/);
});

test("expiry drops waiting messages with the link; a pane that stops being Claude drops them too", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const a = await create(h, { expires: "1m" });
  const b = await create(h);
  const pane = h.runner.tmux.panes[0]!;
  pane.working = true;
  await post(h, a.token, { text: "for a" });
  await post(h, b.token, { text: "for b" });
  h.timers.t += 61_000;
  await advanceUntil(h.timers, () => h.tool.get(`links.${a.id}`) === undefined, "a expired (sweep)", 15_000);
  pane.command = "bash";
  await advanceUntil(h.timers, () => (h.tool.get(`links.${b.id}`) as { pending: number }).pending === 0, "b dropped");
  const results = Object.values(h.tool.get("log") as Record<string, { result: string }>).map((e) => e.result);
  assert.ok(results.includes("dropped: link expired"));
  assert.ok(results.includes("dropped: the pane runs bash, not Claude"));
  assert.deepEqual(pane.submitted, []);
});

test("a quick tunnel restart flags links made for the old host", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const r = await create(h);
  assert.equal((h.tool.get(`links.${r.id}`) as { hostChanged: boolean }).hostChanged, false);
  h.runner.cf.procs[0]!.finish(1);
  await waitFor(() => (h.tool.get("tunnel") as { status: string }).status === "restarting", "restarting");
  h.timers.advance(1000);
  await waitFor(() => (h.tool.get("tunnel") as { host: string }).host === "second-tunnel-bb.trycloudflare.com", "new host");
  assert.equal((h.tool.get(`links.${r.id}`) as { hostChanged: boolean }).hostChanged, true);
  assert.match((h.tool.get("tunnel") as { warning: string }).warning, /changes whenever cloudflared restarts/);
});

test("on start, active links are listed and logged (ids only) and the tunnel comes up", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const r = await create(h);
  // a second serve process over the same files, as after a restart
  const h2 = await harness();
  t.after(() => h2.close());
  await h2.service.stop();
  const store = new Store(h.stateDir);
  const s2 = new InboxService({
    tool: h2.tool,
    panes: { list: async () => ({ kind: "ok", panes: [] }), capture: async () => "", sendLiteral: async () => {}, sendEnter: async () => {} },
    store,
    settings: { port: 0, sendDelayMs: 0, verifyDelayMs: 0, paneCommands: [], checkScreen: true },
    runner: h2.runner,
    stateDir: h.stateDir,
    timers: h2.timers,
  });
  await s2.start();
  t.after(() => s2.stop());
  assert.equal(h2.tool.get("activeCount"), 1);
  assert.equal((h2.tool.get(`links.${r.id}`) as { label: string }).label, "cloud");
  await waitFor(() => h2.logs().some((l) => l.msg === "1 inbox link(s) active"), "startup warning");
  assert.equal(h2.logs().find((l) => l.msg === "1 inbox link(s) active")!.fields!.ids, r.id);
  assert.equal(h2.runner.cf.starts.length, 1);
});

test("no token in any line the tool emitted, across every kind of request", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const r = await create(h);
  h.runner.tmux.panes[0]!.input = "typing";
  await post(h, r.token, { text: "queued one" });
  await post(h, r.token, "{bad");
  await post(h, r.token, { text: "x", pad: "y".repeat(40_000) });
  await req(h.url(`/inbox/${r.token}`));
  await req(h.url(`/inbox/${"B".repeat(43)}`), "POST", "{}");
  h.runner.tmux.panes[0]!.input = "";
  await advanceUntil(h.timers, () => h.runner.tmux.panes[0]!.submitted.length === 1, "delivered");
  await h.call("revoke", { id: r.id });
  const lines = exceptCreateReplies(h);
  assert.ok(lines.length > 10);
  for (const l of lines) {
    assert.ok(!l.includes(r.token), `token in: ${l}`);
    assert.ok(!l.includes(r.token.slice(0, 20)), `token prefix in: ${l}`);
    assert.ok(!l.includes(hashToken(r.token)), `hash in: ${l}`);
  }
  assert.equal(h.out.filter((l) => l.includes(r.token)).length, 1, "only the create reply carries it");
});

