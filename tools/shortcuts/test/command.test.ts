// Command lines as GNOME runs them: g_shell_parse_argv, no shell, no PATH you can rely on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { commandFromArgv, commandFromLine, commandProgram, joinArgv, quoteArg, shellSplit } from "../src/command.ts";

const ctx = { binDir: "/home/u/.local/bin", home: "/home/u", bins: new Set(["audioctl", "brightctl", "tmuxctl"]) };

test("quoteArg: bare when safe, '…' with '\\'' otherwise", () => {
  const cases: [string, string][] = [
    ["app-mute", "app-mute"],
    ["+10", "+10"],
    ["/home/u/.local/bin/audioctl", "/home/u/.local/bin/audioctl"],
    ["a b", "'a b'"],
    ["it's", "'it'\\''s'"],
    ["", "''"],
    ["$HOME", "'$HOME'"],
    ["~/x", "'~/x'"],
    ["a\\b", "'a\\b'"],
    ['say "hi"', `'say "hi"'`],
    ["é", "'é'"],
  ];
  for (const [s, q] of cases) assert.equal(quoteArg(s), q, s);
});

test("shellSplit reads quotes like g_shell_parse_argv", () => {
  const cases: [string, string[]][] = [
    ["/a/b 'it'\\''s' x", ["/a/b", "it's", "x"]],
    ['"d\\$q" "a\\b" #c', ["d$q", "a\\b"]],
    ["sh -c 'a | b'", ["sh", "-c", "a | b"]],
    ["x\\ y  z", ["x y", "z"]],
    ["a#b c", ["a#b", "c"]],
    ["''", [""]],
    ["  lead  trail  ", ["lead", "trail"]],
  ];
  for (const [s, argv] of cases) assert.deepEqual(shellSplit(s).argv, argv, s);
  assert.throws(() => shellSplit("a 'b"), /without its closing '/);
  assert.throws(() => shellSplit('a "b'), /without its closing "/);
  assert.throws(() => shellSplit("   "), /empty/);
  assert.equal(shellSplit("a | b").needsShell, true);
  assert.equal(shellSplit("a '|' b").needsShell, false);
  assert.equal(shellSplit("echo $HOME").needsShell, true);
});

test("quoting round-trips through the splitter", () => {
  const nasty = ["plain", "a b", "it's", "", "$x", "`x`", "a\\b", 'q"q', "tab\there", "new\nline", "#hash", "~/x", "é 🚀"];
  assert.deepEqual(shellSplit(joinArgv(nasty)).argv, nasty);
});

test("commandFromArgv: tool commands get the wrapper's absolute path", () => {
  assert.equal(commandFromArgv(["audioctl", "app-mute", "firefox", "toggle"], ctx), "/home/u/.local/bin/audioctl app-mute firefox toggle");
  assert.equal(commandFromArgv(["brightctl", "set", "all", "+10"], ctx), "/home/u/.local/bin/brightctl set all +10");
  assert.equal(commandFromArgv(["tmuxctl", "kill", "my session"], ctx), "/home/u/.local/bin/tmuxctl kill 'my session'");
  assert.equal(commandFromArgv(["~/bin/x", "~/keep"], ctx), "/home/u/bin/x '~/keep'", "only argv[0]'s ~ is expanded");
  assert.equal(commandFromArgv(["notify-send", "it's done"], ctx), "notify-send 'it'\\''s done'");
  assert.equal(commandFromArgv(["./audioctl"], ctx), "./audioctl", "a path is left alone");
  assert.throws(() => commandFromArgv([], ctx), /empty/);
});

test("commandFromLine: argv when GNOME can run it as is, sh -c when it needs a shell", () => {
  const cases: [string, string][] = [
    ["audioctl app-mute firefox toggle", "/home/u/.local/bin/audioctl app-mute firefox toggle"],
    ["  brightctl set all -10 ", "/home/u/.local/bin/brightctl set all -10"],
    // already absolute and quoted (what the page shows when editing): unchanged
    ["/home/u/.local/bin/audioctl app-volume 'Firefox Web' +5", "/home/u/.local/bin/audioctl app-volume 'Firefox Web' +5"],
    ['tmuxctl kill "my session"', "/home/u/.local/bin/tmuxctl kill 'my session'"],
    ["~/bin/thing --flag", "/home/u/bin/thing --flag"],
    ["copyq toggle", "copyq toggle"],
    // shell syntax: wrapped, tool command first resolved, inner text quoted for sh -c
    ["audioctl app-mute firefox toggle && notify-send muted", "sh -c '/home/u/.local/bin/audioctl app-mute firefox toggle && notify-send muted'"],
    ["echo $HOME > /tmp/x", "sh -c 'echo $HOME > /tmp/x'"],
    ["notify-send \"it's $USER\" | cat", "sh -c 'notify-send \"it'\\''s $USER\" | cat'"],
    // already wrapped: kept (the | is inside quotes)
    ["sh -c 'a | b'", "sh -c 'a | b'"],
  ];
  for (const [line, want] of cases) assert.equal(commandFromLine(line, ctx), want, line);
  // idempotent: feeding the result back gives the same command
  for (const [line] of cases) {
    const once = commandFromLine(line, ctx);
    assert.equal(commandFromLine(once, ctx), once, `idempotent: ${line}`);
  }
  // what GNOME will actually exec for a wrapped one
  assert.deepEqual(shellSplit(commandFromLine("notify-send \"it's $USER\" | cat", ctx)).argv, ["sh", "-c", "notify-send \"it's $USER\" | cat"]);
  assert.throws(() => commandFromLine("echo 'oops", ctx), /closing '/);
});

test("commandProgram: argv[0], or the first word of sh -c", () => {
  assert.equal(commandProgram("/home/u/.local/bin/audioctl app-mute x toggle"), "/home/u/.local/bin/audioctl");
  assert.equal(commandProgram("sh -c '/home/u/.local/bin/brightctl set all +10 && x'"), "/home/u/.local/bin/brightctl");
  assert.equal(commandProgram("echo 'bad"), null);
});
