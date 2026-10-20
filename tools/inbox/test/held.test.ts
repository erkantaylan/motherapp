// Held messages: which idle check holds them, "Deliver now" (the page's manual override), and
// "Save screen" (capture-pane to a file, for real idle-detector fixtures).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { screenStamp } from "../src/screens.ts";
import { advanceUntil, harness, screenOf, tick, waitFor } from "./fakes.ts";
import type { Harness } from "./fakes.ts";

function post(h: Harness, token: string, msg: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request(h.url(`/inbox/${token}`), { method: "POST", headers: { "content-type": "application/json" }, agent: false }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode!, body: b }));
    });
    r.on("error", reject);
    r.end(JSON.stringify(msg));
  });
}

async function create(h: Harness) {
  const r = await h.call("create", { pane: "motherapp:0.1", label: "cloud" });
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  return { id: r.result.id as string, token: /\/inbox\/([A-Za-z0-9_-]{43})$/.exec(r.result.link)![1]! };
}

interface Row {
  pending: number;
  held: string;
  check: string;
  queued: { qid: number; received: number; text: string }[];
}

const row = (h: Harness, id: string) => h.tool.get(`links.${id}`) as unknown as Row;

test("a held message records which check failed, on the page and in the journal, never its text", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const r = await create(h);
  const pane = h.runner.tmux.panes[0]!;
  pane.dialog = true;
  assert.equal((await post(h, r.token, { text: "secret words here" })).status, 202);
  assert.equal(row(h, r.id).check, "no-prompt-line");
  assert.match(row(h, r.id).held, /no `>` prompt line found/);
  const queued = h.logs().find((l) => l.msg.startsWith("inbox message queued"))!;
  assert.equal(queued.fields!.check, "no-prompt-line");
  pane.dialog = false;
  pane.working = true;
  await advanceUntil(h.timers, () => row(h, r.id).check === "busy-marker", "check changes");
  await waitFor(() => h.logs().some((l) => l.msg.startsWith("inbox message still held") && l.fields?.check === "busy-marker"), "logged");
  assert.ok(!JSON.stringify(h.logs()).includes("secret words"), "no message text in the journal");
  assert.ok(!JSON.stringify(h.logs()).includes(r.token));
});

test("Deliver now: types a held message with the two-call send, cleaned, and takes it off the queue", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const r = await create(h);
  const pane = h.runner.tmux.panes[0]!;
  pane.working = true; // the detector says busy; the pane still takes keys
  assert.equal((await post(h, r.token, { text: "first\r\n\x1b[31mred\u202E", ref: "#11" })).status, 202);
  assert.equal((await post(h, r.token, { text: "second" })).status, 202);
  assert.deepEqual(row(h, r.id).queued.map((q) => q.text), ["[inbox: cloud] (re #11) first red", "[inbox: cloud] second"]);
  const second = row(h, r.id).queued[1]!.qid;
  const res = await h.call("deliverNow", { id: r.id, qid: second });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.deepEqual(res.result, { result: "submitted (delivered now by hand)" });
  assert.deepEqual(h.runner.tmux.sends(), [["-l", "--", "[inbox: cloud] second"], ["Enter"]], "text, then Enter in its own call");
  assert.deepEqual(pane.submitted, ["[inbox: cloud] second"]);
  assert.deepEqual(row(h, r.id).queued.map((q) => q.text), ["[inbox: cloud] (re #11) first red"]);
  assert.match((await h.call("deliverNow", { id: r.id, qid: second })).error!.message, /isn't waiting any more/);
  await h.call("deliverNow", { id: r.id, qid: row(h, r.id).queued[0]!.qid });
  assert.deepEqual(pane.submitted, ["[inbox: cloud] second", "[inbox: cloud] (re #11) first red"], "the cleaned line");
  assert.equal(row(h, r.id).pending, 0);
  // nothing left for the pump to type
  pane.working = false;
  h.timers.advance(1000);
  await tick();
  assert.equal(pane.submitted.length, 2);
  const results = Object.values(h.tool.get("log") as Record<string, { result: string }>).map((e) => e.result);
  assert.deepEqual(results.slice(-2), ["submitted (delivered now by hand)", "submitted (delivered now by hand)"]);
});

test("Deliver now: no Enter when the text didn't show up; refuses copy mode and a pane that is gone", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const r = await create(h);
  const pane = h.runner.tmux.panes[0]!;
  pane.working = true;
  for (const text of ["a", "b", "c"]) await post(h, r.token, { text });
  const qids = () => row(h, r.id).queued.map((q) => q.qid);
  pane.inMode = true;
  assert.match((await h.call("deliverNow", { id: r.id, qid: qids()[0] })).error!.message, /copy mode/);
  assert.equal(qids().length, 3, "still waiting");
  pane.inMode = false;
  pane.eatText = true;
  const eaten = await h.call("deliverNow", { id: r.id, qid: qids()[0] });
  assert.deepEqual(eaten.result, { result: "not submitted: text not seen on screen (delivered now by hand)" });
  assert.deepEqual(h.runner.tmux.sends(), [["-l", "--", "[inbox: cloud] a"]], "no Enter");
  pane.command = "bash";
  assert.match((await h.call("deliverNow", { id: r.id, qid: qids()[0] })).error!.message, /nothing typed: the pane runs bash/);
  assert.equal(row(h, r.id).pending, 0, "dropped with the pane");
});

test("saveScreen: capture-pane of the pane to screens/<timestamp>.txt (0600), with the detector's verdict", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const pane = h.runner.tmux.panes[0]!;
  pane.input = "half typed";
  const r = await h.call("saveScreen", { pane: "motherapp:0.1" });
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  const file = path.join(h.stateDir, "screens", `${screenStamp(h.timers.now())}.txt`);
  assert.equal(r.result.file, file, "outside HOME, so not shortened");
  assert.equal(fs.readFileSync(file, "utf8"), screenOf(pane));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.equal(r.result.verdict, "busy: someone is typing in the pane (input not empty)");
  assert.deepEqual(h.runner.tmux.calls.find((c) => c[0] === "capture-pane"), ["capture-pane", "-p", "-t", "%1"]);
  const again = await h.call("saveScreen", { pane: "%1" });
  assert.notEqual(again.result.file, file, "same millisecond: a second file, not overwritten");
  assert.match((await h.call("saveScreen", { pane: "nope" })).error!.message, /no tmux pane nope/);
  const logged = h.logs().find((l) => l.msg === "inbox screen saved")!;
  assert.deepEqual(logged.fields, { pane: "motherapp:0.1", file, verdict: "input-not-empty" });
  assert.ok(!JSON.stringify(h.logs()).includes("half typed"), "the screen isn't logged");
});
