// Sending text to a session: Enter is a second tmux call, never a line break in the text; the
// text reaches tmux and nothing else (no state, no log); only this computer may do it.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { createTool } from "@motherapp/tool-sdk";
import { LineDecoder } from "@motherapp/protocol";
import { runCli } from "../src/cli.ts";
import { COPY_MODE, ENTER_DELAY_MS, MAX_SEND_CHARS, NOTHING_TO_SEND, cleanSendText, needsPaste, sendToSession } from "../src/send.ts";
import { INITIAL_STATE, TmuxService } from "../src/service.ts";
import { CHUNK_CHARS, Tmux, chunks, tmuxLiteralArg } from "../src/tmux.ts";
import { FakeClaude, FakeGit, FakeTimers, FakeTmux, session, tick, waitFor } from "./fakes.ts";

const BS = "\\";
const SECRET = "hunter2 s3cret";

/** A fake tmux whose pause between the text and Enter is recorded among the tmux calls. */
function fakeTmux() {
  const fake = new FakeTmux();
  fake.server = { sessions: [session(0, "work"), session(1, "it's; a -name")] };
  const tmux = new Tmux({ runner: fake, defaultSocket: fake.socket, exists: () => true });
  /** tmux command lines and pauses, in order. */
  const order = (): string[] => events.map((e) => (typeof e === "number" ? fake.lines()[e]! : e));
  const events: (number | string)[] = [];
  const spawn = fake.spawn.bind(fake);
  fake.spawn = (cmd, args) => {
    events.push(fake.calls.length);
    return spawn(cmd, args);
  };
  const sleep = async (ms: number) => void events.push(`sleep ${ms}`);
  return { fake, tmux, order, sleep };
}

test("cleanSendText: line ends become \\n, control characters go, tabs stay, no line break at the end", () => {
  assert.equal(cleanSendText("a\r\nb\rc\n\n\n"), "a\nb\nc");
  assert.equal(cleanSendText("x\x1b[201~y\x00\x07\x7f\x9bz\tq"), "x[201~yz\tq");
  assert.equal(cleanSendText("  keep spaces  "), "  keep spaces  ");
  assert.equal(cleanSendText("\n\r\n"), "");
  assert.equal(cleanSendText("é🚀 -l --"), "é🚀 -l --");
});

test("needsPaste: a line break, a tab, or more than one tmux command can carry", () => {
  assert.equal(needsPaste("echo hi; ls -la"), false);
  assert.equal(needsPaste("a\nb"), true);
  assert.equal(needsPaste("a\tb"), true);
  assert.equal(needsPaste("x".repeat(CHUNK_CHARS)), false);
  assert.equal(needsPaste("x".repeat(CHUNK_CHARS + 1)), true);
});

test("tmuxLiteralArg and chunks: a trailing ; survives tmux; parts never split a surrogate pair", () => {
  assert.equal(tmuxLiteralArg("ls;"), `ls${BS};`);
  assert.equal(tmuxLiteralArg("a;b"), "a;b");
  assert.equal(tmuxLiteralArg(`find . ${BS};`), `find . ${BS}${BS};`);
  assert.deepEqual(chunks("abcdef", 4), ["abcd", "ef"]);
  assert.deepEqual(chunks("ab🚀🚀", 3), ["ab", "🚀", "🚀"]);
  assert.deepEqual(chunks(""), []);
  const long = "é;".repeat(3000);
  assert.equal(chunks(long).join(""), long);
  assert.ok(chunks(long).every((c) => Buffer.byteLength(c) < 12_000), "well under tmux's 16 KiB command limit");
});

test("send: the text as literal keys by pane id, a pause, then Enter as a second send-keys", async () => {
  const t = fakeTmux();
  const sent = await sendToSession(t.tmux, "$0", "-n echo hi", { enter: true, sleep: t.sleep });
  assert.deepEqual(t.order(), ["display-message -p -t $0: #{pane_id}\t#{pane_in_mode}", "send-keys -t %0 -l -- -n echo hi", `sleep ${ENTER_DELAY_MS}`, "send-keys -t %0 Enter"]);
  assert.deepEqual(sent, { pane: "%0", chars: 10, pasted: false, enter: true });
  // argv, not a shell line: the text is one argument after "--", and no argument holds a line break
  const textCall = t.fake.calls.find((a) => a.includes("-l"))!;
  assert.deepEqual(textCall.slice(textCall.indexOf("-l")), ["-l", "--", "-n echo hi"]);
  assert.ok(t.fake.calls.every((a) => a.every((x) => !/[\r\n]/.test(x))));
  assert.deepEqual(t.fake.typed, [
    { pane: "%0", kind: "keys", text: "-n echo hi" },
    { pane: "%0", kind: "key", text: "Enter" },
  ]);
});

test("send: a line break at the end is dropped, not sent; Enter stays its own call; a trailing ; arrives", async () => {
  const t = fakeTmux();
  await sendToSession(t.tmux, "$1", "ls;\r\n", { enter: true, sleep: t.sleep });
  assert.deepEqual(t.order().slice(1), [`send-keys -t %1 -l -- ls${BS};`, `sleep ${ENTER_DELAY_MS}`, "send-keys -t %1 Enter"]);
  assert.deepEqual(t.fake.typed[0], { pane: "%1", kind: "keys", text: "ls;" });
});

test("send without Enter: the text only, no pause, no second call", async () => {
  const t = fakeTmux();
  const sent = await sendToSession(t.tmux, "$0", "half a command", { enter: false, sleep: t.sleep });
  assert.deepEqual(t.order().slice(1), ["send-keys -t %0 -l -- half a command"]);
  assert.equal(sent.enter, false);
});

test("send: several lines go in as one bracketed paste through a buffer of their own, then Enter", async () => {
  const t = fakeTmux();
  const sent = await sendToSession(t.tmux, "$0", "line one\n\tline two;\n\n", { enter: true, sleep: t.sleep });
  const o = t.order();
  assert.match(o[1]!, /^set-buffer -b motherapp-send-\d+-1 -- line one\n\tline two\\;$/);
  assert.match(o[2]!, /^paste-buffer -p -d -b motherapp-send-\d+-1 -t %0$/);
  assert.deepEqual(o.slice(3), [`sleep ${ENTER_DELAY_MS}`, "send-keys -t %0 Enter"]);
  assert.deepEqual(t.fake.typed, [
    { pane: "%0", kind: "paste", text: "line one\n\tline two;" },
    { pane: "%0", kind: "key", text: "Enter" },
  ]);
  assert.equal(sent.pasted, true);
  assert.equal(t.fake.buffers.size, 0, "the buffer is gone with the paste");
  assert.ok(!t.fake.lines().some((l) => l.startsWith("send-keys") && l.includes("line one")), "never typed as keys");
});

test("send: long text is pasted in parts no tmux command is too long for, and arrives whole", async () => {
  const t = fakeTmux();
  const long = "word; ".repeat(1500);
  await sendToSession(t.tmux, "$0", long, { enter: true, sleep: t.sleep });
  const sets = t.fake.calls.filter((a) => a.includes("set-buffer"));
  assert.equal(sets.length, Math.ceil(long.length / CHUNK_CHARS));
  assert.ok(sets.slice(1).every((a) => a.includes("-a")) && !sets[0]!.includes("-a"));
  assert.equal(t.fake.typed[0]!.text, long);
});

test("send: copy mode, a gone session, empty and oversized text are refused before anything is typed", async () => {
  const t = fakeTmux();
  t.fake.inMode.add("%0");
  await assert.rejects(sendToSession(t.tmux, "$0", "q", { enter: true, sleep: t.sleep }), { message: COPY_MODE });
  await assert.rejects(sendToSession(t.tmux, "$9", "x", { enter: true, sleep: t.sleep }), { message: "That session doesn't exist anymore." });
  await assert.rejects(sendToSession(t.tmux, "$1", "\n\n", { enter: true, sleep: t.sleep }), { message: NOTHING_TO_SEND });
  await assert.rejects(sendToSession(t.tmux, "$1", "x".repeat(MAX_SEND_CHARS + 1), { enter: true, sleep: t.sleep }), /too long/);
  assert.deepEqual(t.fake.typed, []);
});

test("send: a pane that goes away after the text gets no Enter anywhere else, and a failed paste leaves no buffer", async () => {
  const t = fakeTmux();
  const gone = async () => void (t.fake.server as { sessions: unknown[] }).sessions.splice(0, 1);
  await assert.rejects(sendToSession(t.tmux, "$0", "typed", { enter: true, sleep: gone }), { message: "That session doesn't exist anymore." });
  assert.deepEqual(t.fake.typed, [{ pane: "%0", kind: "keys", text: "typed" }]);

  const u = fakeTmux();
  const answer = u.fake.spawn.bind(u.fake);
  u.fake.spawn = (cmd, args) => {
    if (args.includes("paste-buffer")) (u.fake.server as { sessions: unknown[] }).sessions.splice(0, 1);
    return answer(cmd, args);
  };
  await assert.rejects(sendToSession(u.tmux, "$0", "a\nb", { enter: true, sleep: u.sleep }), { message: "That session doesn't exist anymore." });
  assert.equal(u.fake.buffers.size, 0);
  assert.deepEqual(u.fake.typed, []);
});

// ---- the action ----

type Msg = { id?: number; method?: string; params?: any; result?: any; error?: { code: number; message: string } };

function service() {
  const t = fakeTmux();
  const input = new PassThrough();
  const output = new PassThrough();
  const tool = createTool({ id: "tmux", title: "tmux", page: "custom", initialState: INITIAL_STATE, persist: false, captureConsole: false, input, output });
  const svc = new TmuxService({ tool, tmux: t.tmux, timers: new FakeTimers(), home: "/home/u", claude: new FakeClaude(), git: new FakeGit(), sleep: t.sleep });
  const received: Msg[] = [];
  let raw = "";
  const dec = new LineDecoder();
  output.setEncoding("utf8");
  output.on("data", (c: string) => {
    raw += c;
    for (const l of dec.push(c)) received.push(JSON.parse(l));
  });
  let id = 0;
  const send = (args: unknown): number => {
    input.write(JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "action", params: { name: "send", args } }) + "\n");
    return id;
  };
  const reply = async (n: number): Promise<Msg> => {
    await waitFor(() => received.some((m) => m.id === n), "reply to send");
    return received.find((m) => m.id === n)!;
  };
  const done = tool.serve();
  const start = async () => {
    svc.start();
    for (let i = 0; i < 6; i++) await tick();
  };
  const end = async () => {
    svc.stop();
    input.end();
    await done;
  };
  return { ...t, tool, received, raw: () => raw, send, reply, start, end };
}

test("send action: by session id, Enter by default; the text is in no state, log or reply, only its length", async () => {
  const t = service();
  await t.start();
  const r = await t.reply(t.send({ id: "1", text: SECRET }));
  assert.deepEqual(r.result, { chars: SECRET.length, enter: true });
  assert.deepEqual(t.fake.typed, [
    { pane: "%1", kind: "keys", text: SECRET },
    { pane: "%1", kind: "key", text: "Enter" },
  ]);
  const log = t.received.filter((m) => m.method === "log").map((m) => m.params);
  assert.deepEqual(log.map((l) => [l.msg, l.fields]), [["sent text to tmux session 'it's; a -name'", { id: "$1", chars: SECRET.length, enter: true }]]);
  // nothing the tool wrote to the core holds the text: not state, not a log line, not the reply
  assert.ok(!t.raw().includes("hunter2") && !t.raw().includes("s3cret"));
  assert.ok(!JSON.stringify(t.tool.get("sessions")).includes("hunter2"));
  await t.end();
});

test("send action: enter false leaves it typed; bad arguments and a gone session are errors, with nothing typed", async () => {
  const t = service();
  await t.start();
  assert.deepEqual((await t.reply(t.send({ id: "0", text: "y", enter: false }))).result, { chars: 1, enter: false });
  assert.deepEqual(t.fake.typed, [{ pane: "%0", kind: "keys", text: "y" }]);
  assert.equal((await t.reply(t.send({ id: "0" }))).error?.code, -32602);
  assert.equal((await t.reply(t.send({ id: "0", text: 5 }))).error?.code, -32602);
  assert.equal((await t.reply(t.send({ id: "0", text: "x", enter: "yes" }))).error?.code, -32602);
  assert.equal((await t.reply(t.send({ id: "=work", text: "x" }))).error?.code, -32602);
  assert.equal((await t.reply(t.send({ id: "7", text: SECRET }))).error?.message, "That session doesn't exist anymore.");
  assert.equal((await t.reply(t.send({ id: "0", text: " \n" }))).result?.chars, 1, "spaces are text");
  assert.equal((await t.reply(t.send({ id: "0", text: "\n" }))).error?.message, NOTHING_TO_SEND);
  assert.equal(t.fake.typed.length, 3);
  assert.ok(!t.raw().includes("hunter2"), "an error doesn't repeat the text either");
  await t.end();
});

test("send action: two sends at once don't interleave; a failed one doesn't block the next", async () => {
  const t = service();
  await t.start();
  const a = t.send({ id: "0", text: "first" });
  const b = t.send({ id: "9", text: "nowhere" });
  const c = t.send({ id: "0", text: "second" });
  await Promise.all([t.reply(a), t.reply(b), t.reply(c)]);
  assert.deepEqual(t.fake.typed.map((x) => x.text), ["first", "Enter", "second", "Enter"]);
  await t.end();
});

test("send is local only: the core refuses it for a LAN client before the tool hears of it", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "manifest.json"), "utf8")) as { localActions: string[] };
  for (const name of ["send", "view", "history", "open"]) assert.ok(manifest.localActions.includes(name), name);
});

// ---- tmuxctl send ----

async function cli(...argv: string[]) {
  const t = fakeTmux();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = "";
  let err = "";
  stdout.on("data", (c) => (out += c));
  stderr.on("data", (c) => (err += c));
  const code = await runCli(argv, { tmux: { runner: t.fake, defaultSocket: t.fake.socket, exists: () => true }, stdout, stderr, sleep: t.sleep });
  return { code, out, err, order: t.order(), typed: t.fake.typed };
}

test("tmuxctl send: by exact name, words joined, Enter as its own call; the text isn't echoed", async () => {
  const r = await cli("send", "work", "echo", "hi  there;");
  assert.deepEqual([r.code, r.out, r.err], [0, "sent 15 characters to 'work' and pressed Enter\n", ""]);
  assert.deepEqual(r.order.slice(1), ["display-message -p -t $0: #{pane_id}\t#{pane_in_mode}", `send-keys -t %0 -l -- echo hi  there${BS};`, `sleep ${ENTER_DELAY_MS}`, "send-keys -t %0 Enter"]);
  const awkward = await cli("send", "it's; a -name", "x");
  assert.deepEqual([awkward.code, awkward.typed[0]], [0, { pane: "%1", kind: "keys", text: "x" }]);
});

test("tmuxctl send: --no-enter before the name; after it, a dash is text; errors and usage", async () => {
  const n = await cli("send", "--no-enter", "work", "ls");
  assert.deepEqual([n.code, n.out], [0, "sent 2 characters to 'work', Enter not pressed\n"]);
  assert.deepEqual(n.typed, [{ pane: "%0", kind: "keys", text: "ls" }]);
  const dash = await cli("send", "work", "--no-enter", "-l");
  assert.deepEqual(dash.typed.map((x) => x.text), ["--no-enter -l", "Enter"]);
  const sep = await cli("send", "-n", "--", "work", "-n");
  assert.deepEqual(sep.typed, [{ pane: "%0", kind: "keys", text: "-n" }]);
  const multi = await cli("send", "work", "a\nb");
  assert.deepEqual(multi.typed, [
    { pane: "%0", kind: "paste", text: "a\nb" },
    { pane: "%0", kind: "key", text: "Enter" },
  ]);
  const miss = await cli("send", "wor", "x");
  assert.deepEqual([miss.code, miss.err, miss.typed], [1, "tmuxctl: no session named 'wor'\n", []]);
  assert.deepEqual([(await cli("send", "work", "")).code, (await cli("send", "work", "")).err], [1, `tmuxctl: ${NOTHING_TO_SEND}\n`]);
  assert.equal((await cli("send", "work")).code, 2);
  assert.equal((await cli("send")).code, 2);
  assert.match((await cli("send", "--loud", "work", "x")).err, /unknown option "--loud"/);
});
