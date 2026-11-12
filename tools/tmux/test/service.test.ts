// Serve mode against a fake tmux: polling, deltas keyed by session id, kill, no server, errors.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createTool } from "@motherapp/tool-sdk";
import { LineDecoder } from "@motherapp/protocol";
import { HISTORY_LINES, INITIAL_STATE, MAX_HISTORY, POLL_MS, TmuxService } from "../src/service.ts";
import { Tmux } from "../src/tmux.ts";
import { FakeClaude, FakeGit, FakeTimers, FakeTmux, session, tick, waitFor } from "./fakes.ts";

type Msg = { id?: number; method?: string; params?: any; result?: any; error?: { code: number; message: string } };

function setup() {
  const input = new PassThrough();
  const output = new PassThrough();
  const tool = createTool({ id: "tmux", title: "tmux", page: "custom", initialState: INITIAL_STATE, persist: false, captureConsole: false, input, output });
  const fake = new FakeTmux();
  const timers = new FakeTimers();
  const claude = new FakeClaude();
  const git = new FakeGit();
  const launched: { argv: string[]; env: NodeJS.ProcessEnv }[] = [];
  const launcher = async (argv: string[], env: NodeJS.ProcessEnv) => void launched.push({ argv, env });
  const service = new TmuxService({ tool, tmux: new Tmux({ runner: fake, defaultSocket: fake.socket, exists: () => true }), timers, home: "/home/u", claude, git, launcher });
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
  /** The `notify` messages sent to the core so far. */
  const notified = () => received.filter((m) => m.method === "notify").map((m) => m.params);
  return { tool, fake, timers, service, claude, notified, git, launched, received, action, changes, settle, nextPoll, end };
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

test("polls always, with nobody watching: one tmux call per tick, and one loop", async () => {
  const t = setup();
  t.fake.server = { sessions: [session(0, "work"), session(1, "other")] };
  t.service.start();
  await t.settle();
  assert.equal(t.tool.watching, false);
  for (let i = 0; i < 10; i++) await t.nextPoll();
  assert.equal(t.fake.lines().length, 11, "one call per tick, however many sessions");
  assert.ok(t.fake.lines().every((l) => l.startsWith("list-panes -a -F ")));
  assert.equal(t.timers.pending(), 1, "exactly one timer");
  t.service.stop();
  assert.equal(t.timers.pending(), 0);
  await t.end();
});

/** A session whose pane has this Claude status. */
function withClaude(t: ReturnType<typeof setup>, status: string, more: object = {}) {
  t.claude.panes.set(1000, { pid: 1000, sessionId: "sid", status, ...more });
}

test("state: Claude's status when readable; output otherwise; an unknown status falls back", async () => {
  const t = setup();
  const now = () => Math.floor(t.timers.now() / 1000);
  const s = session(0, "a", { command: "claude", activity: now() - 100 });
  t.fake.server = { sessions: [s] };
  const state = () => t.tool.get("sessions.0.state");
  t.service.start();
  await t.settle();
  assert.equal(state(), "idle", "no status file: output logic, an agent at rest");
  assert.equal(t.tool.get("sessions.0.claude"), false);

  withClaude(t, "busy");
  await t.nextPoll();
  assert.equal(state(), "working");
  assert.equal(t.tool.get("sessions.0.claude"), true);
  withClaude(t, "waiting", { waitingFor: "permission prompt" });
  await t.nextPoll();
  assert.equal(state(), "waiting");
  withClaude(t, "idle");
  await t.nextPoll();
  assert.equal(state(), "idle");

  withClaude(t, "pondering");
  (t.fake.server as { sessions: typeof s[] }).sessions[0] = { ...s, activity: now() };
  await t.nextPoll();
  assert.equal(state(), "working", "a status we don't know is ignored: pane output decides");
  assert.equal(t.tool.get("sessions.0.claude"), false);

  // Output of a busy window that isn't the session's active one still counts (the max).
  t.claude.panes.clear();
  const make = { ...s.panes[0]!, command: "make" };
  (t.fake.server as { sessions: typeof s[] }).sessions[0] = { ...s, panes: [make], activity: now() - 4 };
  await t.nextPoll();
  assert.equal(state(), "quiet", "not a shell or an agent, no recent output");
  await t.end();
});

test("sub-agents: published above 0 only, and gone again at 0; a plain session never has any", async () => {
  const t = setup();
  t.fake.server = { sessions: [session(0, "a"), session(1, "plain")] };
  withClaude(t, "busy");
  const agent = { description: "AGENT-SECRET", type: "general-purpose", startedAt: 1 };
  t.claude.agents = [agent, agent];
  t.service.start();
  await t.settle();
  assert.equal(t.tool.get("sessions.0.agents"), 2);
  assert.equal(t.tool.get("sessions.1.agents"), undefined);
  t.claude.agents = undefined; // can't tell: nothing shown, not a guess
  await t.nextPoll();
  assert.equal(t.tool.get("sessions.0.agents"), undefined);
  t.claude.agents = [agent];
  await t.nextPoll();
  t.claude.agents = [];
  await t.nextPoll();
  assert.equal(t.tool.get("sessions.0.agents"), undefined);
  await t.end();
});

test("a session with two Claudes shows the one that needs you", async () => {
  const t = setup();
  const p = session(0, "a").panes[0]!;
  t.fake.server = { sessions: [session(0, "a", { panes: [p, { ...p, id: "%9", pid: 2000, active: false }] })] };
  t.claude.panes.set(1000, { pid: 1000, sessionId: "one", status: "idle" });
  t.claude.panes.set(2000, { pid: 2000, sessionId: "two", status: "waiting" });
  t.service.start();
  await t.settle();
  assert.equal(t.tool.get("sessions.0.state"), "waiting");
  await t.end();
});

test("the timeline fills in with no one watching; history stays out of the way of other deltas", async () => {
  const t = setup();
  t.fake.server = { sessions: [session(0, "a")] };
  withClaude(t, "busy");
  t.service.start();
  await t.settle();
  const line = () => t.tool.get("sessions.0.timeline") as string;
  assert.equal(line().length, 60);
  assert.equal(line().at(-1), "9");
  assert.match(line().slice(0, -1), /^-+$/);
  withClaude(t, "waiting");
  await t.nextPoll();
  assert.equal(line().at(-1), "w");
  await t.end();
});

test("notifications: Claude's transitions go to the core as notify, nothing for what was already so at start", async () => {
  const t = setup();
  t.fake.server = { sessions: [session(0, "a")] };
  withClaude(t, "busy");
  t.service.start();
  await t.settle();
  assert.deepEqual(t.notified(), [], "already busy at start: no alert");
  withClaude(t, "waiting");
  await t.nextPoll();
  assert.deepEqual(t.notified(), [{ kind: "waiting", title: "a is waiting on you" }]);
  withClaude(t, "busy");
  await t.nextPoll();
  withClaude(t, "idle");
  await t.nextPoll();
  assert.deepEqual(t.notified(), [{ kind: "waiting", title: "a is waiting on you" }, { kind: "finished", title: "a finished" }], "name and state only, no body");
  await t.end();
});

test("view: screen and Claude's text come back in the reply and never in state or a log", async () => {
  const t = setup();
  t.fake.server = { sessions: [session(0, "a"), session(1, "plain")] };
  t.fake.screen = "SCREEN-SECRET\n";
  withClaude(t, "waiting", { waitingFor: "permission prompt", name: "probe" });
  t.claude.agents = [{ description: "AGENT-SECRET", type: "fork", startedAt: 5 }];
  t.claude.transcripts.set("sid", { title: "TITLE-SECRET", lastPrompt: "PROMPT-SECRET", lastMessage: "MESSAGE-SECRET", contextTokens: 1234, model: "m" });
  t.service.start();
  await t.settle();
  const r = await t.action("view", { id: "0" });
  assert.deepEqual(r.result as unknown, {
    rows: { "0": { title: "TITLE-SECRET", contextTokens: 1234 } },
    selected: {
      id: "0",
      text: "SCREEN-SECRET\n",
      cols: 80,
      claude: { title: "TITLE-SECRET", lastPrompt: "PROMPT-SECRET", lastMessage: "MESSAGE-SECRET", contextTokens: 1234, model: "m", name: "probe", waitingFor: "permission prompt", agents: [{ description: "AGENT-SECRET", type: "fork", startedAt: 5 }] },
    },
  });
  const plain = await t.action("view", { id: "1" });
  assert.deepEqual(Object.keys((plain.result as any).selected), ["id", "text", "cols"], "no Claude section for a plain session");
  t.claude.talk = { text: "HISTORY-SECRET", cut: false };
  assert.equal(((await t.action("history", { id: "0" })).result as any).text, "HISTORY-SECRET");
  await t.nextPoll();
  const other = t.received.filter((m) => m.method !== undefined);
  assert.doesNotMatch(JSON.stringify(other), /SECRET/, "nothing but the reply carries it");
  assert.doesNotMatch(JSON.stringify(t.tool.get("")), /SECRET/);
  await t.end();
});

test("view: only the selected session is captured; none without a selection; a gone session is no error", async () => {
  const t = setup();
  t.fake.server = { sessions: [session(0, "a"), session(1, "b")] };
  t.service.start();
  await t.settle();
  await t.action("view", {});
  assert.equal(t.fake.lines().filter((l) => l.startsWith("capture-pane")).length, 0);
  await t.action("view", { id: "1" });
  assert.deepEqual(t.fake.lines().filter((l) => l.startsWith("capture-pane")), ["capture-pane -p -e -t $1:"]);
  (t.fake.server as { sessions: unknown[] }).sessions.splice(1, 1);
  const r = await t.action("view", { id: "1" });
  assert.equal(r.error, undefined);
  assert.equal((r.result as any).selected.text, undefined);
  await t.end();
});

test("rename: by id, the real name comes back, the row follows; empty and taken names say so", async () => {
  const t = setup();
  t.fake.server = { sessions: [session(0, "a"), session(1, "b")] };
  t.service.start();
  await t.settle();
  const r = await t.action("rename", { id: "0", name: "x.y:z" });
  assert.deepEqual(r.result, { name: "x_y_z" });
  assert.ok(t.fake.lines().includes("rename-session -t $0 -- x.y:z"));
  await t.settle();
  assert.equal(t.tool.get("sessions.0.name"), "x_y_z");
  assert.equal((await t.action("rename", { id: "0", name: "   " })).error?.message, "The name can't be empty.");
  assert.equal((await t.action("rename", { id: "1", name: "x.y.z" })).error?.message, "There is already a session named 'x_y_z'.");
  assert.equal((await t.action("rename", { id: "7", name: "q" })).error?.message, "That session doesn't exist anymore.");
  assert.equal((await t.action("rename", { id: "0" })).error?.code, -32602);
  await t.end();
});

test("rename: a # stays a #, not a tmux format", async () => {
  const t = setup();
  t.fake.server = { sessions: [session(0, "a")] };
  t.service.start();
  await t.settle();
  await t.action("rename", { id: "0", name: "#S #{pid}" });
  assert.ok(t.fake.lines().includes("rename-session -t $0 -- ##S ##{pid}"));
  await t.end();
});

test("open: argv list with the current name, TMUX removed; a gone session fails", async (c) => {
  const t = setup();
  c.after(() => {
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
  });
  process.env.TMUX = "/tmp/x,1,0";
  process.env.TMUX_PANE = "%1";
  t.fake.server = { sessions: [session(0, "old name")] };
  t.service.start();
  await t.settle();
  (t.fake.server as { sessions: ReturnType<typeof session>[] }).sessions[0]!.name = "my app; echo x"; // renamed since the last poll
  assert.equal((await t.action("open", { id: "0" })).error, undefined);
  const { argv, env } = t.launched[0]!;
  assert.deepEqual(argv.slice(-8), ["terminator", "--no-dbus", "-x", "tmux", "-u", "attach-session", "-t", "=my app; echo x"]);
  assert.equal(env.TMUX, undefined);
  assert.equal(env.TMUX_PANE, undefined);
  assert.equal((await t.action("open", { id: "9" })).error?.message, "That session doesn't exist anymore.");
  await t.end();
});

test("history: tmux scrollback when the pane has any; else a Claude's conversation; a plain pane gets what tmux has", async () => {
  const t = setup();
  const pane = session(0, "a").panes[0]!;
  // Started from a shell: the shell's lines still count in history_size, out of reach.
  const fromShell = { ...session(3, "shell tui").panes[0]!, history: 11, alternate: true };
  t.fake.server = { sessions: [session(0, "a", { panes: [{ ...pane, history: 40 }] }), session(1, "plain"), session(2, "tui"), session(3, "shell tui", { panes: [fromShell] })] };
  t.claude.panes.set(1002, { pid: 1002, sessionId: "sid", status: "idle" });
  t.claude.panes.set(1003, { pid: 1003, sessionId: "sid", status: "idle" });
  t.claude.talk = { text: "the talk", cut: true };
  t.service.start();
  await t.settle();
  assert.deepEqual((await t.action("history", { id: "0" })).result, { source: "tmux", text: t.fake.scrollback, cut: false, cols: 80 });
  assert.ok(t.fake.lines().includes(`capture-pane -p -e -S -${HISTORY_LINES} -t $0:`));
  assert.equal(((await t.action("history", { id: "1" })).result as any).source, "tmux");
  assert.deepEqual((await t.action("history", { id: "2" })).result, { source: "transcript", text: "the talk", cut: true, cols: 0 }, "no scrollback on the alternate screen");
  assert.equal(((await t.action("history", { id: "3" })).result as any).source, "transcript", "a shell's lines on the main screen don't count");
  t.claude.talk = undefined;
  assert.equal(((await t.action("history", { id: "2" })).result as any).source, "tmux", "no transcript: tmux, whatever it has");
  assert.equal((await t.action("history", { id: "9" })).error?.message, "That session doesn't exist anymore.");
  assert.equal(t.fake.lines().filter((l) => l.startsWith("capture-pane")).length, 3, "only when asked: polling never fetches history");
  await t.end();
});

test("history: a pane longer than the limit says so, and too many bytes keep the newest whole lines", async () => {
  const t = setup();
  const pane = session(0, "a").panes[0]!;
  t.fake.server = { sessions: [session(0, "a", { panes: [{ ...pane, history: HISTORY_LINES + 1 }] })] };
  t.service.start();
  await t.settle();
  assert.equal(((await t.action("history", { id: "0" })).result as any).cut, true);
  t.fake.server = { sessions: [session(0, "a", { panes: [{ ...pane, history: 5 }] })] };
  await t.nextPoll();
  t.fake.scrollback = `${"x".repeat(100)}\n`.repeat(Math.ceil(MAX_HISTORY / 100)) + "the end\n";
  const r = (await t.action("history", { id: "0" })).result as any;
  assert.equal(r.cut, true);
  assert.ok(r.text.length <= MAX_HISTORY);
  assert.ok(r.text.startsWith("x"), "starts on a line");
  assert.ok(r.text.endsWith("the end\n"));
  await t.end();
});

test("project: the repo Claude works in, not the folder its pane sits in; a folder when there's no repo", async () => {
  const t = setup();
  t.fake.server = { sessions: [session(0, "a", { path: "/home/u/work" }), session(1, "b", { path: "/home/u/work" }), session(2, "plain", { path: "/home/u/notes" })] };
  t.claude.panes.set(1000, { pid: 1000, sessionId: "one", status: "idle" });
  t.claude.panes.set(1001, { pid: 1001, sessionId: "two", status: "idle" });
  t.claude.transcripts.set("one", { cwd: "/home/u/work/app" });
  t.claude.transcripts.set("two", { cwd: "/home/u/work/app/src" });
  t.git.folders.set("/home/u/work/app", { root: "/home/u/work/app", branch: "main", changes: 3 });
  t.git.folders.set("/home/u/work/app/src", { root: "/home/u/work/app", branch: "main", changes: 3 });
  t.git.folders.set("/home/u/notes", null);
  t.service.start();
  await t.settle();
  const row = (id: string) => t.tool.get(`sessions.${id}`) as Record<string, unknown>;
  for (const id of ["0", "1"]) {
    assert.deepEqual([row(id).project, row(id).projectPath, row(id).branch, row(id).changes], ["app", "~/work/app", "main", 3]);
  }
  assert.deepEqual([row("2").project, row("2").projectPath, row("2").branch], ["notes", "~/notes", undefined]);
  assert.deepEqual(t.git.asked.at(-1)!.sort(), ["/home/u/notes", "/home/u/work/app", "/home/u/work/app/src"], "per folder, not per session");
  t.git.folders.set("/home/u/work/app", { root: "/home/u/work/app", branch: "fix", changes: 0 });
  await t.nextPoll();
  assert.deepEqual([row("0").branch, row("0").changes], ["fix", 0]);
  await t.end();
});

test("stale: idle for days is flagged, a working session never is", async () => {
  const t = setup();
  const now = Math.floor(t.timers.now() / 1000);
  t.fake.server = { sessions: [session(0, "old", { activity: now - 10 * 86400 }), session(1, "fresh", { activity: now - 2 * 86400 })] };
  t.service.start();
  await t.settle();
  assert.equal(t.tool.get("sessions.0.staleDays"), 10);
  assert.equal(t.tool.get("sessions.1.staleDays"), undefined);
  t.claude.panes.set(1000, { pid: 1000, sessionId: "sid", status: "busy" });
  await t.nextPoll();
  assert.equal(t.tool.get("sessions.0.staleDays"), undefined);
  await t.end();
});
