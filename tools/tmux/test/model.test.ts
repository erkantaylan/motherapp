// Parsing, quoting, the no-server cases, the exact kill target and the row text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { diffState } from "../src/diff.ts";
import { FORMAT, Tmux, ago, attachCommand, defaultSocketPath, parseSessions, sessionRow, sessionsToState, shellQuote, tildify } from "../src/tmux.ts";
import { FakeTmux, session } from "./fakes.ts";

test("FORMAT asks for the fields in order, tab-separated, path last", () => {
  assert.equal(
    FORMAT,
    "#{session_id}\t#{session_name}\t#{session_windows}\t#{session_created}\t#{session_attached}\t#{session_activity}\t#{pane_current_command}\t#{pane_current_path}",
  );
});

test("parseSessions: names with spaces, quotes and unicode; a tab in the path; junk skipped", () => {
  const out = [
    "$0\tmy project\t3\t1700000000\t2\t1700000100\tvim\t/home/u/src",
    `$12\tit's a "test" é🚀 \\t\t1\t1700000001\t0\t1700000002\tbash\t/tmp/a\tb`,
    "$3\tback\\\\slash\t1\t1\t0\t1\t\t",
    "garbage line",
    "x1\ta\t1\t1\t0\t1\tbash\t/",
    "$4\ttoo\tfew",
    "",
  ].join("\n");
  assert.deepEqual(parseSessions(out), [
    { id: "$0", name: "my project", windows: 3, created: 1700000000, attached: 2, activity: 1700000100, command: "vim", path: "/home/u/src" },
    { id: "$12", name: `it's a "test" é🚀 \\t`, windows: 1, created: 1700000001, attached: 0, activity: 1700000002, command: "bash", path: "/tmp/a\tb" },
    { id: "$3", name: "back\\\\slash", windows: 1, created: 1, attached: 0, activity: 1, command: "", path: "" },
  ]);
  assert.deepEqual(parseSessions(""), []);
});

// Characters that break naive quoting.
const NASTY = ["'", '"', "\\", "$", "`", "!", " ", "\t", "\n", ";", "&", "|", "*", "?", "[", "]", "(", ")", "{", "}", "<", ">", "#", "~", "=", "%", "é", "🚀", "a", "-", "'\\''", "$(id)"];

function randomName(rnd: () => number): string {
  const n = 1 + Math.floor(rnd() * 12);
  let s = "";
  for (let i = 0; i < n; i++) s += NASTY[Math.floor(rnd() * NASTY.length)];
  return s;
}

function lcg(seed: number): () => number {
  let x = seed;
  return () => ((x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
}

test("shellQuote: /bin/sh reads every nasty name back unchanged (property test)", () => {
  const rnd = lcg(42);
  const names = ["", "'", "''", "it's", "a b", "--", "-t", ...NASTY, ...Array.from({ length: 300 }, () => randomName(rnd))];
  // One sh run: printf each argument followed by NUL, then compare.
  const script = `printf '%s\\0' ${names.map(shellQuote).join(" ")}`;
  const r = spawnSync("/bin/sh", ["-c", script], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.split("\0").slice(0, -1), names);
  // and nothing outside single quotes except the escaped quote itself
  for (const n of names) assert.match(shellQuote(n), /^'([^']|'\\'')*'$/);
});

test("attachCommand: exact-match target, quoted for the shell", () => {
  assert.equal(attachCommand("work"), "tmux attach -t '=work'");
  assert.equal(attachCommand("my project"), "tmux attach -t '=my project'");
  assert.equal(attachCommand("it's"), "tmux attach -t '=it'\\''s'");
  assert.equal(attachCommand("$1"), "tmux attach -t '=$1'");
  // the shell hands tmux exactly ["attach", "-t", "=<name>"]
  const rnd = lcg(7);
  for (let i = 0; i < 50; i++) {
    const name = randomName(rnd);
    const r = spawnSync("/bin/sh", ["-c", `set -- ${attachCommand(name).replace(/^tmux /, "")}; printf '%s\\0' "$@"`], { encoding: "utf8" });
    assert.deepEqual(r.stdout.split("\0").slice(0, -1), ["attach", "-t", `=${name}`]);
  }
});

test("defaultSocketPath: $TMUX_TMPDIR or /tmp, tmux-<uid>/default", () => {
  assert.equal(defaultSocketPath({}, 1000), "/tmp/tmux-1000/default");
  assert.equal(defaultSocketPath({ TMUX_TMPDIR: "/run/user/1000" }, 1000), "/run/user/1000/tmux-1000/default");
});

function tmuxWith(fake: FakeTmux, dirExists = true): Tmux {
  return new Tmux({ runner: fake, defaultSocket: fake.socket, exists: () => dirExists });
}

test("list: always -u (else tmux turns tabs and unicode into _); -S only for a given socket", async () => {
  const fake = new FakeTmux();
  fake.server = { sessions: [session(1, "a b")] };
  const r = await tmuxWith(fake).list();
  assert.deepEqual(r, { kind: "ok", sessions: [session(1, "a b")] });
  assert.deepEqual(fake.calls[0], ["-u", "list-sessions", "-F", FORMAT]);
  await new Tmux({ runner: fake, socket: "/x/sock" }).list();
  assert.deepEqual(fake.calls[1], ["-u", "-S", "/x/sock", "list-sessions", "-F", FORMAT]);
});

test("list: no server in each of its forms is an empty list with a reason, not an error", async () => {
  const fake = new FakeTmux();
  fake.server = { noServer: "stale-socket" };
  assert.deepEqual(await tmuxWith(fake).list(), { kind: "none", reason: "No tmux server running on /tmp/tmux-1000/default." });
  fake.server = { noServer: "no-socket" };
  assert.deepEqual(await tmuxWith(fake).list(), { kind: "none", reason: "No tmux server running (no socket at /tmp/tmux-1000/default)." });
  fake.server = { noServer: "no-dir" };
  assert.deepEqual(await tmuxWith(fake, false).list(), { kind: "none", reason: "No tmux server has run for this user yet (/tmp/tmux-1000 doesn't exist)." });
});

test("list: other connection errors and a missing tmux are errors", async () => {
  const fake = new FakeTmux();
  fake.server = { fail: "error connecting to /tmp/tmux-1000/default (Permission denied)" };
  await assert.rejects(tmuxWith(fake).list(), { message: "Can't connect to the tmux server at /tmp/tmux-1000/default: Permission denied" });
  fake.server = { fail: "something odd" };
  await assert.rejects(tmuxWith(fake).list(), { message: "tmux list-sessions failed: something odd" });
  fake.server = { missing: true };
  await assert.rejects(tmuxWith(fake).list(), { message: "tmux not found (is tmux installed?)" });
});

test("kill: the target is passed as given, so =foo never matches foo2", async () => {
  const fake = new FakeTmux();
  fake.server = { sessions: [session(1, "foo2"), session(2, "foo"), session(3, "foo bar")] };
  const tmux = tmuxWith(fake);
  await tmux.kill("=foo");
  assert.deepEqual(fake.calls.at(-1), ["-u", "kill-session", "-t", "=foo"]);
  assert.deepEqual("sessions" in fake.server && fake.server.sessions.map((s) => s.name), ["foo2", "foo bar"]);
  await assert.rejects(tmux.kill("=foo"), { message: "That session doesn't exist anymore." });
  await tmux.kill("$3");
  assert.deepEqual("sessions" in fake.server && fake.server.sessions.map((s) => s.name), ["foo2"]);
});

test("rows: relative times, attached text, ~ paths, kill note, attach command", () => {
  const now = 1_700_000_000_000;
  assert.equal(ago(1_700_000_000 - 30, now), "just now");
  assert.equal(ago(1_700_000_000 - 300, now), "5 min ago");
  assert.equal(ago(1_700_000_000 - 3 * 3600, now), "3 h ago");
  assert.equal(ago(1_700_000_000 - 2 * 86400, now), "2 d ago");
  assert.equal(ago(1_700_000_000 + 10, now), "just now", "clock skew");
  assert.equal(tildify("/home/u/src", "/home/u"), "~/src");
  assert.equal(tildify("/home/u", "/home/u"), "~");
  assert.equal(tildify("/home/user2", "/home/u"), "/home/user2");
  const s = session(4, "it's", { windows: 2, attached: 2, created: 1_700_000_000 - 7200, activity: 1_700_000_000 - 60, command: "vim", path: "/home/u/src" });
  assert.deepEqual(sessionRow(s, now, "/home/u"), {
    id: "$4",
    name: "it's",
    windows: 2,
    attached: 2,
    created: 1_700_000_000 - 7200,
    detail: "2 windows · attached (2 clients) · created 2 h ago · active 1 min ago · vim in ~/src",
    attachedNote: " It is attached (2 clients).",
    attachCommand: "tmux attach -t '=it'\\''s'",
  });
  const d = sessionRow(session(5, "x", { attached: 0, command: "", path: "" }), now, undefined);
  assert.equal(d.detail, "1 window · detached · created just now · active just now");
  assert.equal(d.attachedNote, "");
  assert.deepEqual(Object.keys(sessionsToState([session(7, "a"), session(10, "b")], now, undefined)), ["7", "10"]);
});

test("diffState: per-field changes, deletions, whole new rows", () => {
  const prev = { "1": { name: "a", attached: 0 }, "2": { name: "b", attached: 0 } };
  const next = { "1": { name: "renamed", attached: 1 }, "3": { name: "c", attached: 0 } };
  assert.deepEqual(diffState("sessions", prev, next), [
    { path: "sessions.2", value: null },
    { path: "sessions.1.name", value: "renamed" },
    { path: "sessions.1.attached", value: 1 },
    { path: "sessions.3", value: { name: "c", attached: 0 } },
  ]);
  assert.deepEqual(diffState("sessions", next, next), []);
});
