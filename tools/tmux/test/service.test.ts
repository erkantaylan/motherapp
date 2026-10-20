// Serve mode against a fake tmux: polling, deltas keyed by session id, kill, no server, errors.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createTool } from "@motherapp/tool-sdk";
import { LineDecoder } from "@motherapp/protocol";
import { layout } from "../src/layout.ts";
import { INITIAL_STATE, POLL_MS, TmuxService } from "../src/service.ts";
import { Tmux } from "../src/tmux.ts";
import { FakeTimers, FakeTmux, session, tick, waitFor } from "./fakes.ts";

type Msg = { id?: number; method?: string; params?: any; error?: { code: number; message: string } };

function setup() {
  const input = new PassThrough();
  const output = new PassThrough();
  const tool = createTool({ id: "tmux", title: "tmux", layout, initialState: INITIAL_STATE, persist: false, captureConsole: false, input, output });
  const fake = new FakeTmux();
  const timers = new FakeTimers();
  const service = new TmuxService({ tool, tmux: new Tmux({ runner: fake, defaultSocket: fake.socket, exists: () => true }), timers, home: "/home/u" });
  const received: Msg[] = [];
  const dec = new LineDecoder();
  output.setEncoding("utf8");
  output.on("data", (c: string) => {
    for (const l of dec.push(c)) received.push(JSON.parse(l));
  });
  let id = 0;
  const action = async (name: string, args: unknown): Promise<Msg> => {
    const myId = ++id;
    input.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method: "action", params: { name, args } }) + "\n");
    await waitFor(() => received.some((m) => m.id === myId), `reply to ${name}`);
    return received.find((m) => m.id === myId)!;
  };
  let mark = 0;
  /** State changes notified since the last call. */
  const changes = () => {
    const out = received.slice(mark).filter((m) => m.method === "state").flatMap((m) => m.params.changes);
    mark = received.length;
    return out;
  };
  const settle = async () => {
    for (let i = 0; i < 6; i++) await tick();
  };
  /** Advances to the next poll and waits for its notifications. */
  const nextPoll = async () => {
    timers.advance(POLL_MS);
    await settle();
  };
  const done = tool.serve();
  const end = async () => {
    service.stop();
    input.end();
    await done;
  };
  return { tool, fake, timers, service, action, changes, settle, nextPoll, end };
}

test("first poll publishes the whole map fresh, then only deltas; rename keeps the row", async () => {
  const t = setup();
  t.fake.server = { sessions: [session(0, "work"), session(1, "my project", { attached: 1 })] };
  t.service.start();
  await t.settle();
  const first = t.changes().filter((c) => c.path.startsWith("sessions"));
  assert.equal(first.at(-1).path, "sessions");
  assert.equal(first.at(-1).stale, undefined, "fresh after the first poll");
  assert.deepEqual(Object.keys(first.at(-1).value), ["0", "1"]);
  assert.equal(first.at(-1).value["1"].attachCommand, "tmux attach -t '=my project'");
  assert.equal(t.fake.lines().length, 1);

  // nothing changed: a poll publishes nothing
  await t.nextPoll();
  assert.equal(t.fake.lines().length, 2);
  assert.deepEqual(t.changes(), []);

  // add
  const s = t.fake.server as { sessions: ReturnType<typeof session>[] };
  s.sessions.push(session(2, "new one"));
  await t.nextPoll();
  assert.deepEqual(t.changes().map((c) => c.path), ["sessions.2"]);

  // rename: same id, so the same row; name, attach command and nothing else
  s.sessions[0] = { ...s.sessions[0]!, name: "renamed" };
  await t.nextPoll();
  assert.deepEqual(t.changes(), [
    { path: "sessions.0.name", value: "renamed" },
    { path: "sessions.0.attachCommand", value: "tmux attach -t '=renamed'" },
  ]);

  // attach / detach
  s.sessions[0] = { ...s.sessions[0]!, attached: 2 };
  await t.nextPoll();
  const attach = t.changes();
  assert.deepEqual(attach.map((c) => c.path).sort(), ["sessions.0.attached", "sessions.0.attachedNote", "sessions.0.detail"]);
  assert.equal(attach.find((c) => c.path === "sessions.0.attachedNote").value, " It is attached (2 clients).");
  s.sessions[1] = { ...s.sessions[1]!, attached: 0 };
  await t.nextPoll();
  assert.equal(t.changes().find((c) => c.path === "sessions.1.attachedNote").value, "");

  // activity alone doesn't publish anything until the coarse text changes
  s.sessions[2] = { ...s.sessions[2]!, activity: s.sessions[2]!.activity + 1 };
  await t.nextPoll();
  assert.deepEqual(t.changes(), []);

  // close
  s.sessions.splice(2, 1);
  await t.nextPoll();
  assert.deepEqual(t.changes(), [{ path: "sessions.2", value: null }]);
  await t.end();
});

test("no server: empty list and a status line; recovers when a server starts", async () => {
  const t = setup();
  t.fake.server = { noServer: "stale-socket" };
  t.service.start();
  await t.settle();
  assert.deepEqual(t.tool.get("sessions"), {});
  assert.equal(t.tool.isStale("sessions"), false);
  assert.equal(t.tool.get("status"), "No tmux server running on /tmp/tmux-1000/default.");
  t.fake.server = { sessions: [session(0, "a")] };
  await t.nextPoll();
  assert.equal(t.tool.get("status"), undefined);
  assert.deepEqual(Object.keys(t.tool.get("sessions") as object), ["0"]);
  // server goes away: rows vanish (not stale), status explains
  t.fake.server = { noServer: "no-socket" };
  await t.nextPoll();
  assert.deepEqual(t.tool.get("sessions"), {});
  assert.match(t.tool.get("status") as string, /^No tmux server running/);
  await t.end();
});

test("errors keep the last rows, stale, with the message; polling goes on", async () => {
  const t = setup();
  t.fake.server = { sessions: [session(0, "a")] };
  t.service.start();
  await t.settle();
  t.fake.server = { fail: "error connecting to /tmp/tmux-1000/default (Permission denied)" };
  await t.nextPoll();
  assert.equal(t.tool.isStale("sessions"), true);
  assert.deepEqual(Object.keys(t.tool.get("sessions") as object), ["0"]);
  assert.equal(t.tool.get("status"), "Can't connect to the tmux server at /tmp/tmux-1000/default: Permission denied Retrying every 2 s.");
  t.fake.server = { sessions: [session(0, "a")] };
  await t.nextPoll();
  assert.equal(t.tool.isStale("sessions"), false);
  assert.equal(t.tool.get("status"), undefined);
  await t.end();
});

test("kill: by session id (exact), row gone right away; bad ids and gone sessions fail", async () => {
  const t = setup();
  t.fake.server = { sessions: [session(0, "foo"), session(1, "foo2")] };
  t.service.start();
  await t.settle();
  t.changes();
  const r = await t.action("kill", { id: "0" });
  assert.equal(r.error, undefined);
  assert.ok(t.fake.lines().includes("kill-session -t $0"));
  await t.settle();
  assert.deepEqual(t.changes(), [{ path: "sessions.0", value: null }], "removed without waiting for the next tick");
  assert.deepEqual(Object.keys(t.tool.get("sessions") as object), ["1"], "foo2 is untouched");
  const gone = await t.action("kill", { id: "0" });
  assert.equal(gone.error?.message, "That session doesn't exist anymore.");
  const bad = await t.action("kill", { id: "$1" });
  assert.equal(bad.error?.code, -32602);
  await t.end();
});

test("layout: Copy and Kill on each row; kill confirm says whether it is attached", () => {
  const list = layout.find((w) => w.type === "list");
  assert.ok(list && list.type === "list");
  assert.equal(list.bind, "sessions");
  const [copy, kill] = list.item.widgets!;
  assert.deepEqual(copy, { type: "button", label: "Copy attach command", copy: { bind: "sessions.{key}.attachCommand" } });
  assert.ok(kill?.type === "button");
  assert.equal(kill.action, "kill");
  assert.deepEqual(kill.args, { id: "{key}" });
  assert.equal(kill.confirm, "Kill tmux session '{name}'?{attachedNote}");
});
