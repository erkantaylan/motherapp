// The dashboard's pure parts and its reading of Claude's files, against files made here. The
// shapes are the ones seen on real sessions (2.1.319): see the header of src/claude.ts.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Alerter, MIN_WORK_SECONDS, QUIET_SECONDS } from "../src/alerts.ts";
import type { Observation } from "../src/alerts.ts";
import { color256, parseAnsi } from "../src/ansi.ts";
import { ClaudeFiles, MAX_CONVERSATION, TAIL_BYTES, endsInterrupted, parseProcStat, parseStatus, scanTranscript, writesFinished } from "../src/claude.ts";
import type { ClaudeStatus } from "../src/claude.ts";
import { GitCache, NOT_REPO_TTL_MS, TTL_MS, parseStatus as parseGitStatus } from "../src/git.ts";
import { DesktopNotifier, gdbusArgs, notifyBody, notifySendArgs } from "../src/notify.ts";
import { openArgv, openEnv } from "../src/open.ts";
import type { Proc, Runner } from "../src/runner.ts";
import { claudeState, outputState, staleDays } from "../src/state.ts";
import { BUCKET_MS, Timeline } from "../src/timeline.ts";
import { formatElapsed, formatTokens, previewFontPx, summaryText, timelineBars, timelineText } from "../src/view.ts";
import { FakeProc, tick } from "./fakes.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ma-tmux-claude-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let dirs = 0;

/** A fake ~/.claude and /proc holding one Claude. */
function claudeHome(pid = 4242, stat = `${pid} (claude) S 1 ${"0 ".repeat(17)}555 0`) {
  const dir = path.join(tmp, String(++dirs));
  const proc = path.join(dir, "proc");
  fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
  fs.mkdirSync(path.join(proc, String(pid)), { recursive: true });
  fs.writeFileSync(path.join(proc, String(pid), "stat"), stat);
  return { dir, proc, files: new ClaudeFiles({ dir, proc }) };
}

const status = (d: object) => JSON.stringify({ pid: 4242, sessionId: "aaaaaaaa-1", status: "idle", ...d });

test("outputState: output within 3 s is working, then idle at a shell or agent, else quiet", () => {
  const now = 1_700_000_100_000;
  assert.equal(outputState(1_700_000_097, "make", now), "working");
  assert.equal(outputState(1_700_000_096, "bash", now), "idle");
  assert.equal(outputState(1_700_000_096, "claude", now), "idle");
  assert.equal(outputState(1_700_000_096, "make", now), "quiet");
});

test("claudeState: known statuses; anything else is no answer", () => {
  assert.deepEqual(["busy", "shell", "idle", "waiting"].map(claudeState), ["working", "working", "idle", "waiting"]);
  assert.equal(claudeState("thinking"), undefined);
});

test("parseStatus and parseProcStat survive what they don't expect", () => {
  assert.equal(parseStatus("not json", 1), undefined);
  assert.equal(parseStatus("[]", 1), undefined);
  assert.equal(parseStatus(JSON.stringify({ pid: 2, sessionId: "s", status: "idle" }), 1), undefined, "another process's file");
  assert.equal(parseStatus(JSON.stringify({ pid: 1, status: "idle" }), 1), undefined);
  assert.deepEqual(parseProcStat(`77 (a) b) c) S 12 ${"0 ".repeat(17)}900 0`), { ppid: 12, start: "900" });
  assert.equal(parseProcStat("nonsense"), undefined);
});

test("forPanes: the pane's own process, else a descendant; missing and broken files are no Claude", () => {
  const h = claudeHome();
  assert.equal(new ClaudeFiles({ dir: path.join(tmp, "nowhere"), proc: h.proc }).forPanes(new Set([4242])).size, 0);
  fs.writeFileSync(path.join(h.dir, "sessions", "4242.json"), "{ broken");
  assert.equal(h.files.forPanes(new Set([4242])).size, 0);

  fs.writeFileSync(path.join(h.dir, "sessions", "4242.json"), status({ status: "busy", procStart: "555", name: "n" }));
  assert.equal(h.files.forPanes(new Set([4242])).get(4242)?.status, "busy");
  assert.equal(h.files.forPanes(new Set([7])).size, 0);

  // Started from a shell: pane 100 → zsh 200 → claude 4242.
  fs.writeFileSync(path.join(h.proc, "4242", "stat"), `4242 (claude) S 200 ${"0 ".repeat(17)}555 0`);
  fs.mkdirSync(path.join(h.proc, "200"));
  fs.writeFileSync(path.join(h.proc, "200", "stat"), `200 (zsh) S 100 ${"0 ".repeat(17)}1 0`);
  fs.mkdirSync(path.join(h.proc, "100"));
  fs.writeFileSync(path.join(h.proc, "100", "stat"), `100 (tmux) S 1 ${"0 ".repeat(17)}1 0`);
  assert.equal(h.files.forPanes(new Set([100])).get(100)?.sessionId, "aaaaaaaa-1");

  // A reused pid: the file names another process start.
  fs.writeFileSync(path.join(h.dir, "sessions", "4242.json"), status({ procStart: "999", name: "changed" }));
  assert.equal(h.files.forPanes(new Set([4242])).size, 0);
  // A dead process left its file.
  fs.rmSync(path.join(h.proc, "4242"), { recursive: true });
  fs.writeFileSync(path.join(h.dir, "sessions", "4242.json"), status({ name: "again" }));
  assert.equal(h.files.forPanes(new Set([4242])).size, 0);
});

const rec = (r: object) => JSON.stringify(r) + "\n";
const assistant = (text: string | undefined, usage?: object, more: object = {}) =>
  rec({ type: "assistant", isSidechain: false, message: { model: "claude-x", content: text === undefined ? [{ type: "tool_use" }] : [{ type: "text", text }], usage }, ...more });
const usage = { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 50 };

test("scanTranscript: later records win; tool-only replies keep the last words; subagents don't count", () => {
  const d = scanTranscript(
    rec({ type: "ai-title", aiTitle: "old" }) +
      rec({ type: "ai-title", aiTitle: "new" }) +
      rec({ type: "last-prompt", lastPrompt: "hello" }) +
      assistant("first", usage) +
      assistant(undefined, { ...usage, input_tokens: 3 }) +
      assistant("sidechain", { ...usage, input_tokens: 999 }, { isSidechain: true }) +
      "not json\n" +
      rec({ type: "assistant", message: "odd" }),
  );
  assert.deepEqual(d, { title: "new", lastPrompt: "hello", lastMessage: "first", contextTokens: 1103, model: "claude-x" });
});

function transcript(h: ReturnType<typeof claudeHome>, sid: string, text: string): string {
  const dir = path.join(h.dir, "projects", "-some-project");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sid}.jsonl`);
  fs.writeFileSync(file, text);
  return file;
}

test("details: finds the transcript, reads only what's new, survives a replaced or missing file", () => {
  const h = claudeHome();
  const sid = "bbbbbbbb-2";
  assert.equal(h.files.details(sid), undefined);
  assert.equal(h.files.details("../../etc/passwd"), undefined);
  const file = transcript(h, sid, rec({ type: "ai-title", aiTitle: "t" }) + assistant("one", usage));
  assert.equal(h.files.details(sid)?.lastMessage, "one");

  fs.appendFileSync(file, assistant("two", usage).slice(0, 20)); // a line still being written
  assert.equal(h.files.details(sid)?.lastMessage, "one");
  fs.appendFileSync(file, assistant("two", usage).slice(20));
  assert.equal(h.files.details(sid)?.lastMessage, "two");

  fs.writeFileSync(file, rec({ type: "last-prompt", lastPrompt: "fresh" }));
  assert.equal(h.files.details(sid)?.lastPrompt, "fresh", "shorter than before: read again");
  fs.rmSync(file);
  assert.equal(h.files.details(sid), undefined);
});

test("details: a big transcript is read from the tail, reaching further back only for what's missing", () => {
  const h = claudeHome();
  const sid = "cccccccc-3";
  const filler = rec({ type: "api-request-shape", pad: "x".repeat(1000) }).repeat(Math.ceil((2 * TAIL_BYTES) / 1000));
  transcript(h, sid, rec({ type: "ai-title", aiTitle: "far back" }) + filler + rec({ type: "last-prompt", lastPrompt: "p" }) + assistant("end", usage));
  assert.deepEqual(h.files.details(sid), { lastPrompt: "p", lastMessage: "end", contextTokens: 1102, model: "claude-x", title: "far back" });
});

test("writesFinished: from 2.1.301 on; an unknown version is no", () => {
  assert.deepEqual(["2.1.300", "2.1.301", "2.1.319", "2.2.0", "3.0.0", "1.9.999", "x", undefined].map(writesFinished), [false, true, true, true, true, false, false, false]);
});

test("endsInterrupted: only when the last message record is the stop marker", () => {
  const stopped = rec({ type: "user", message: { content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] } });
  assert.equal(endsInterrupted(stopped), true);
  assert.equal(endsInterrupted(stopped + rec({ type: "api-request" })), true);
  assert.equal(endsInterrupted(stopped + assistant("back at it")), false, "continued by SendMessage");
  assert.equal(endsInterrupted(rec({ type: "user", message: { content: "go" } })), false);
  assert.equal(endsInterrupted(""), false);
});

test("agentList: only unfinished agents of this process; each way an agent ends is left out", () => {
  const h = claudeHome();
  const sid = "dddddddd-4";
  const file = transcript(h, sid, assistant("x", usage));
  const dir = path.join(file.slice(0, -6), "subagents");
  const s = (more: Partial<ClaudeStatus> = {}): ClaudeStatus => ({ pid: 4242, sessionId: sid, status: "busy", startedAt: Date.now() - 60_000, version: "2.1.319", ...more });
  const count = (x: ClaudeStatus) => h.files.agentList(x)?.length;
  assert.equal(count(s()), 0, "no subagents dir: never had one");
  fs.mkdirSync(dir, { recursive: true });
  const meta = (id: string, d: object, jsonl = "") => {
    fs.writeFileSync(path.join(dir, `agent-${id}.meta.json`), JSON.stringify({ agentType: "general-purpose", ...d }));
    fs.writeFileSync(path.join(dir, `agent-${id}.jsonl`), jsonl);
  };
  meta("running", {}, assistant("working on it"));
  meta("second", {});
  meta("done", { finished: true });
  meta("stopped", { stoppedByUser: true });
  meta("taskstop", {}, rec({ type: "user", message: { content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] } }));
  meta("killed-with-the-old-process", {});
  fs.utimesSync(path.join(dir, "agent-killed-with-the-old-process.meta.json"), new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
  fs.writeFileSync(path.join(dir, "agent-x.jsonl"), "");
  assert.equal(count(s()), 2);
  assert.equal(count(s({ status: "waiting" })), 2, "agents go on during a prompt");
  assert.equal(count(s({ status: "idle" })), 0, "idle: none, whatever the files say");
  assert.equal(count(s({ status: "shell" })), 0);

  const list = h.files.agentList(s())!;
  assert.deepEqual(list.map((a) => [a.description, a.type]).sort(), [["", "general-purpose"], ["", "general-purpose"]]);
  fs.writeFileSync(path.join(dir, "agent-running.meta.json"), JSON.stringify({ agentType: "fork", description: "Build the thing" }));
  const started = fs.statSync(path.join(dir, "agent-running.meta.json")).mtimeMs;
  assert.deepEqual(h.files.agentList(s())!.find((a) => a.type === "fork"), { description: "Build the thing", type: "fork", startedAt: started });

  // A finished agent continued by SendMessage: `finished` goes away, and it counts again.
  meta("done", {}, assistant("again"));
  assert.equal(count(s()), 3);

  assert.equal(count(s({ version: "2.1.300" })), undefined, "before `finished`: can't tell");
  assert.equal(count(s({ status: "pondering" })), undefined);
  const noStart = s();
  delete noStart.startedAt;
  assert.equal(count(noStart), undefined);
  fs.writeFileSync(path.join(dir, "agent-broken.meta.json"), "{ nope");
  assert.equal(count(s()), undefined, "a broken file: no answer rather than a wrong one");
});

const obs = (over: Partial<Observation>): Observation => ({ key: "k", name: "s", state: "idle", claude: false, activity: 0, input: 0, ...over });

test("Alerter, Claude: busy -> idle and -> waiting; a dismissed prompt and the first sight are silent", () => {
  const a = new Alerter();
  const see = (state: Observation["state"]) => a.observe([obs({ claude: true, state })], 0);
  assert.deepEqual(see("working"), [], "no alert for what was already so");
  assert.deepEqual(see("waiting"), [{ name: "s", word: "waiting" }]);
  assert.deepEqual(see("waiting"), [], "once");
  assert.deepEqual(see("idle"), [], "the prompt was dismissed, nothing finished");
  assert.deepEqual(see("working"), []);
  assert.deepEqual(see("idle"), [{ name: "s", word: "finished" }]);
});

test("Alerter, output: a long run that goes quiet alerts once; a short burst and typing don't", () => {
  const t0 = 1_000;
  const run = (a: Alerter, seconds: number, input = 0) => {
    const words: string[] = [];
    const see = (now: number, activity: number) => words.push(...a.observe([obs({ activity, input })], now * 1000).map((x) => x.word));
    see(t0, t0 - 100); // baseline
    for (let s = 1; s <= seconds; s += 2) see(t0 + s, t0 + s);
    const last = t0 + seconds;
    for (let s = 1; s <= QUIET_SECONDS + 2; s++) see(last + s, last);
    return words;
  };
  assert.deepEqual(run(new Alerter(), MIN_WORK_SECONDS + 3), ["finished"]);
  assert.deepEqual(run(new Alerter(), MIN_WORK_SECONDS - 5), [], "a resize, a short command");
  // Typing for a minute: output right up to the last key press.
  assert.deepEqual(run(new Alerter(), 60, t0 + 59), [], "echo of the user's own typing");
  // One Enter and then a build: output long after the last key.
  assert.deepEqual(run(new Alerter(), 60, t0 + 1), ["finished"]);
});

test("Alerter: changing between Claude and output is a new baseline; a gone session is forgotten", () => {
  const a = new Alerter();
  a.observe([obs({ claude: true, state: "working" })], 0);
  assert.deepEqual(a.observe([obs({ claude: false, state: "idle" })], 1000), [], "Claude exited: not finished");
  a.observe([], 2000);
  assert.deepEqual(a.observe([obs({ claude: true, state: "idle" })], 3000), [], "seen as new");
});

test("Timeline: a bucket a minute, 60 of them; busy share, waiting and gaps; forgets the old", () => {
  const t = new Timeline();
  const m = 1_000 * BUCKET_MS;
  for (let i = 0; i < 4; i++) t.add("a", i < 2 ? "working" : "idle", m + i * 1000);
  t.add("a", "waiting", m + BUCKET_MS);
  t.add("a", "idle", m + 3 * BUCKET_MS);
  const s = t.encode("a", m + 3 * BUCKET_MS);
  assert.equal(s.length, 60);
  assert.equal(s.slice(-4), "5w-0");
  assert.equal(t.encode("b", m), "-".repeat(60));
  t.add("a", "idle", m + 70 * BUCKET_MS);
  assert.equal(t.encode("a", m + 70 * BUCKET_MS), "-".repeat(59) + "0", "older than an hour is gone");
  t.keep(new Set());
  assert.equal(t.encode("a", m + 70 * BUCKET_MS), "-".repeat(60));
});

test("parseAnsi: colours of every kind, attributes, resets; other escapes vanish; no HTML meaning", () => {
  assert.deepEqual(parseAnsi("plain\n"), [[{ text: "plain" }]]);
  assert.deepEqual(parseAnsi("\x1b[31mred\x1b[39m plain"), [[{ text: "red", fg: "#cd3131" }, { text: " plain" }]]);
  assert.deepEqual(parseAnsi("\x1b[1;4;38;5;196;48;2;1;2;3mx\x1b[0my"), [[{ text: "x", fg: "#ff0000", bg: "#010203", bold: true, underline: true }, { text: "y" }]]);
  assert.deepEqual(parseAnsi("\x1b[31ma\nb\x1b[0m\nc"), [[{ text: "a", fg: "#cd3131" }], [{ text: "b", fg: "#cd3131" }], [{ text: "c" }]], "the pen carries across lines");
  assert.deepEqual(parseAnsi("\x1b[7mr\x1b[27m"), [[{ text: "r", fg: "#14161a", bg: "#d7dae0" }]]);
  assert.deepEqual(parseAnsi("\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\\x1b[2K"), [[{ text: "link" }]]);
  assert.deepEqual(parseAnsi("<b>&amp;"), [[{ text: "<b>&amp;" }]]);
  assert.deepEqual(parseAnsi("a\n\nb\n"), [[{ text: "a" }], [], [{ text: "b" }]]);
  assert.deepEqual([color256(0), color256(231), color256(232), color256(255), color256(256)], ["#000000", "#ffffff", "#080808", "#eeeeee", undefined]);
});

test("notification text: name and word only, escaped for GNOME's body markup", () => {
  assert.equal(notifyBody("a<b>&c", "finished"), "a&lt;b&gt;&amp;c: finished");
  assert.deepEqual(notifySendArgs("x: waiting").slice(-3), ["--", "tmux", "x: waiting"], "-- so a name can't be an option");
  const g = gdbusArgs("it's a \\ name: waiting");
  assert.equal(g[g.indexOf("tmux") + 1], `'it\\'s a \\\\ name: waiting'`);
});

class ScriptedRunner implements Runner {
  calls: string[] = [];
  answer: (cmd: string) => "ok" | "missing" | number = () => "ok";
  spawn(cmd: string, args: string[]): Proc {
    this.calls.push(`${cmd} ${args.join(" ")}`);
    const p = new FakeProc(cmd, args);
    const a = this.answer(cmd);
    setImmediate(() => {
      if (a === "missing") p.emit("error", Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
      else if (a === "ok") p.finish(0);
      else p.finish(a, "", "boom\n");
    });
    return p;
  }
}

test("DesktopNotifier: notify-send; gdbus when it's missing, and stays there; warns once when neither works", async () => {
  const r = new ScriptedRunner();
  const warnings: string[] = [];
  const n = new DesktopNotifier(r, { warn: (m) => warnings.push(m) });
  const settle = async () => {
    for (let i = 0; i < 8; i++) await tick();
  };
  n.send("a", "finished");
  await settle();
  assert.match(r.calls[0]!, /^notify-send .* -- tmux a: finished$/);

  r.answer = (cmd) => (cmd === "notify-send" ? "missing" : "ok");
  n.send("b", "waiting");
  await settle();
  assert.match(r.calls.at(-1)!, /^gdbus call --session .* 'b: waiting' /);
  n.send("c", "waiting");
  await settle();
  assert.equal(r.calls.filter((c) => c.startsWith("notify-send")).length, 2, "not tried again");

  r.answer = () => 1;
  n.send("d", "waiting");
  n.send("e", "waiting");
  await settle();
  assert.deepEqual(warnings, ["gdbus failed: boom"], "a failure is logged once, and never with the name");

  r.answer = () => "missing";
  n.send("f", "waiting");
  await settle();
  assert.equal(warnings.at(-1), "No notifications: neither notify-send nor gdbus could be started.");
});

test("openArgv: --no-dbus and an argv list; a scope of its own under systemd; no TMUX in the env", () => {
  const attach = ["tmux", "-u", "attach-session", "-t", "=my app; echo x"];
  assert.deepEqual(openArgv(attach, {}), ["terminator", "--no-dbus", "-x", ...attach]);
  assert.deepEqual(openArgv(attach, { INVOCATION_ID: "1" }).slice(0, 7), ["systemd-run", "--user", "--scope", "--collect", "--quiet", "--", "terminator"]);
  assert.deepEqual(openEnv({ TMUX: "x", TMUX_PANE: "%1", DISPLAY: ":0" }), { DISPLAY: ":0" });
});

test("view helpers: timeline bars and text, tokens, preview font, summary", () => {
  assert.deepEqual(timelineBars("-9w0").map((b) => [b.empty, b.waiting, b.level]), [[true, false, 0], [false, false, 1], [false, true, 1], [false, false, 0]]);
  assert.equal(timelineText("---"), "No history yet");
  assert.equal(timelineText("-90w"), "Busy in 1 of 3 min, waited on you in 1, over the last 3 min");
  assert.deepEqual([999, 1234, 12_000, 245_600, 1_200_000].map(formatTokens), ["999", "1.2k", "12k", "246k", "1.2M"]);
  assert.equal(previewFontPx(1000, 100), 14, "room to spare: capped");
  assert.equal(previewFontPx(600, 100), 10);
  assert.equal(previewFontPx(300, 200), 8, "too wide: the box scrolls");
  assert.equal(summaryText(["working", "idle", "waiting", "working"]), "4 sessions · 1 waiting on you · 2 working");
  assert.equal(summaryText(["idle"]), "1 session");
});

test("scanTranscript: the working folder is the latest main-thread one", () => {
  const d = scanTranscript(assistant("a", usage, { cwd: "/w/one" }) + assistant("b", usage, { cwd: "/w/two" }) + assistant("c", usage, { cwd: "/w/side", isSidechain: true }));
  assert.equal(d.cwd, "/w/two");
});

const user = (content: unknown, more: object = {}) => rec({ type: "user", message: { content }, ...more });

test("conversation: prompts, replies and tool names in order; wrappers, tool results and sidechains left out", () => {
  const h = claudeHome();
  const sid = "eeeeeeee-5";
  assert.equal(h.files.conversation(sid), undefined);
  assert.equal(h.files.conversation("../x"), undefined);
  transcript(
    h,
    sid,
    user("fix the bug") +
      user("<task-notification>x</task-notification>") +
      user([{ type: "tool_result", content: "SECRET OUTPUT" }]) +
      user("harness", { isMeta: true }) +
      rec({ type: "assistant", message: { content: [{ type: "text", text: "On it." }, { type: "tool_use", name: "Bash", input: { command: "rm x" } }, { type: "thinking", thinking: "hmm" }] } }) +
      assistant("side", usage, { isSidechain: true }) +
      user([{ type: "text", text: "thanks" }]) +
      rec({ type: "attachment", x: 1 }) +
      "not json\n",
  );
  const c = h.files.conversation(sid)!;
  assert.equal(c.cut, false);
  const plain = parseAnsi(c.text).map((l) => l.map((r) => r.text).join(""));
  assert.deepEqual(plain.filter(Boolean), ["❯ fix the bug", "On it.", "· Bash", "❯ thanks"]);
  assert.doesNotMatch(c.text, /SECRET|rm x|hmm|side|harness|task-notification/);
});

test("conversation: bounded, newest kept, and it says so", () => {
  const h = claudeHome();
  const sid = "ffffffff-6";
  const big = "y".repeat(10_000);
  transcript(h, sid, user("the first prompt") + assistant(big, usage).repeat(Math.ceil(MAX_CONVERSATION / 10_000) + 5) + user("the last prompt"));
  const c = h.files.conversation(sid)!;
  assert.equal(c.cut, true);
  assert.ok(c.text.length <= MAX_CONVERSATION);
  assert.match(c.text, /the last prompt/);
  assert.doesNotMatch(c.text, /the first prompt/);
});

test("staleDays: from 3 days on, only at rest", () => {
  const now = 1_700_000_000_000;
  const ago = (d: number) => now / 1000 - d * 86400;
  assert.equal(staleDays(ago(2.9), "idle", now), undefined);
  assert.equal(staleDays(ago(3), "idle", now), 3);
  assert.equal(staleDays(ago(10.2), "quiet", now), 10);
  assert.equal(staleDays(ago(10), "working", now), undefined);
  assert.equal(staleDays(ago(10), "waiting", now), undefined);
});

test("git parseStatus: branch, detached, a new repo, changes; nonsense is no answer", () => {
  assert.deepEqual(parseGitStatus("# branch.oid abcdef123456\n# branch.head main\n1 .M N... x\n? new\n"), { branch: "main", changes: 2 });
  assert.deepEqual(parseGitStatus("# branch.oid abcdef123456\n# branch.head (detached)\n"), { branch: "abcdef1", changes: 0 });
  assert.deepEqual(parseGitStatus("# branch.oid (initial)\n# branch.head main\n"), { branch: "main", changes: 0 });
  assert.equal(parseGitStatus("fatal: oops\n"), undefined);
});

class GitRunner implements Runner {
  calls: string[] = [];
  held: FakeProc[] = [];
  hold = false;
  answer: (args: string[]) => { code: number; out?: string } | "missing" = (args) => (args.includes("rev-parse") ? { code: 0, out: "/repo\n" } : { code: 0, out: "# branch.head main\n1 x\n" });
  spawn(cmd: string, args: string[]): Proc {
    this.calls.push(`${cmd} ${args.join(" ")}`);
    const p = new FakeProc(cmd, args);
    const finish = () => {
      const a = this.answer(args);
      if (a === "missing") p.emit("error", Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
      else p.finish(a.code, a.out ?? "", "");
    };
    if (this.hold) this.held.push(Object.assign(p, { go: finish }));
    else setImmediate(finish);
    return p;
  }
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await tick();
};

test("GitCache: read-only and lock-free; once per folder; one at a time; again only after the TTL", async () => {
  const r = new GitRunner();
  let now = 1_000_000;
  const g = new GitCache({ runner: r, now: () => now });
  assert.equal(g.get("/a"), undefined);
  g.refresh(["/a", "/b"]);
  await settle();
  assert.deepEqual(g.get("/a"), { root: "/repo", branch: "main", changes: 1 });
  assert.deepEqual(g.get("/b"), { root: "/repo", branch: "main", changes: 1 });
  assert.equal(r.calls.length, 4, "new folders go one after the other");
  assert.ok(r.calls.every((c) => c.startsWith("git --no-optional-locks -c core.fsmonitor=false -C /")));

  for (let i = 0; i < 10; i++) {
    g.refresh(["/a", "/b"]);
    await settle();
  }
  assert.equal(r.calls.length, 4, "nothing inside the TTL, however often it polls");

  now += TTL_MS + 1;
  g.refresh(["/a", "/b"]);
  await settle();
  assert.equal(r.calls.length, 5, "one folder a poll, status only: the root is known");
  assert.match(r.calls.at(-1)!, / status --porcelain=v2 /);
  g.refresh(["/a", "/b"]);
  await settle();
  assert.equal(r.calls.length, 6);

  g.refresh(["/b"]);
  assert.equal(g.get("/a"), undefined, "a folder no longer in use is forgotten");
});

test("GitCache: slow git doesn't pile up; not a repo, a broken repo and no git are all null", async () => {
  const r = new GitRunner();
  r.hold = true;
  let now = 1_000_000;
  const g = new GitCache({ runner: r, now: () => now });
  g.refresh(["/a"]);
  g.refresh(["/a"]);
  g.refresh(["/a"]);
  assert.equal(r.calls.length, 1, "one at a time");
  r.hold = false;
  (r.held[0] as unknown as { go(): void }).go();
  await settle();
  assert.ok(g.get("/a"));

  r.answer = () => ({ code: 128 });
  g.refresh(["/plain"]);
  await settle();
  assert.equal(g.get("/plain"), null);
  r.answer = (args) => (args.includes("rev-parse") ? { code: 0, out: "/r\n" } : { code: 128 });
  g.refresh(["/broken"]);
  await settle();
  assert.equal(g.get("/broken"), null);
  r.answer = () => "missing";
  g.refresh(["/nogit"]);
  await settle();
  assert.equal(g.get("/nogit"), null);

  r.answer = () => ({ code: 128 });
  g.refresh(["/plain"]);
  await settle();
  const calls = r.calls.length;
  now += TTL_MS + 1;
  g.refresh(["/plain"]);
  await settle();
  assert.equal(r.calls.length, calls, "not a repo is asked about less often");
  now += NOT_REPO_TTL_MS;
  g.refresh(["/plain"]);
  await settle();
  assert.equal(r.calls.length, calls + 1);
});

test("view helpers: elapsed time", () => {
  assert.deepEqual([12_000, 90_000, 3_900_000, 90_000_000].map(formatElapsed), ["12 s", "1 min", "1 h 5 min", "25 h"]);
  assert.equal(formatElapsed(-5), "0 s");
});
