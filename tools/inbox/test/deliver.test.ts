// Typing into a pane: text and Enter as two separate tmux calls, the one retry, and the pane list.
import { test } from "node:test";
import assert from "node:assert/strict";
import { countOnScreen, typeAndSubmit } from "../src/deliver.ts";
import { PANE_FORMAT, TmuxPanes, isClaudeCommand, parsePanes, resolvePane } from "../src/panes.ts";
import { FakeTmux, claudePane } from "./fakes.ts";

function setup(more: Parameters<typeof claudePane>[1] = {}) {
  const fake = new FakeTmux();
  fake.panes = [claudePane(1, more)];
  const panes = new TmuxPanes({ runner: fake, exists: () => true });
  const sleeps: number[] = [];
  const opts = { keys: panes, sleep: async (ms: number) => void sleeps.push(ms), delayMs: 200, verifyDelayMs: 600 };
  return { fake, panes, opts, sleeps, pane: fake.panes[0]! };
}

test("two tmux calls: `send-keys -t %1 -l -- <text>` (no newline), then exactly `Enter`", async () => {
  const { fake, opts, sleeps, pane } = setup();
  const r = await typeAndSubmit(opts, "%1", "[inbox: cloud] CI is red");
  assert.deepEqual(r, { result: "submitted", submitted: true });
  const calls = fake.calls.map((c) => c.join(" "));
  assert.deepEqual(calls, [
    "send-keys -t %1 -l -- [inbox: cloud] CI is red",
    "capture-pane -p -t %1",
    "send-keys -t %1 Enter",
    "capture-pane -p -t %1",
  ]);
  const [text, enter] = fake.calls.filter((c) => c[0] === "send-keys");
  assert.deepEqual(text, ["send-keys", "-t", "%1", "-l", "--", "[inbox: cloud] CI is red"]);
  assert.ok(!/[\r\n]/.test(text!.join("")), "no newline in the text call");
  assert.deepEqual(enter, ["send-keys", "-t", "%1", "Enter"]);
  assert.deepEqual(sleeps, [200, 600], "the delay sits between text and Enter");
  assert.deepEqual(pane.submitted, ["[inbox: cloud] CI is red"]);
  assert.ok(fake.calls.every((c) => !c.includes("-t") || /^%\d+$/.test(c[c.indexOf("-t") + 1]!)), "targets are always pane ids");
});

test("text still in the box after Enter: one more Enter, `submitted: retried`", async () => {
  const { fake, opts, pane } = setup({ swallowEnters: 1 });
  const r = await typeAndSubmit(opts, "%1", "[inbox: cloud] hi");
  assert.equal(r.result, "submitted: retried");
  assert.deepEqual(fake.sends(), [["-l", "--", "[inbox: cloud] hi"], ["Enter"], ["Enter"]]);
  assert.deepEqual(pane.submitted, ["[inbox: cloud] hi"]);
});

test("never loops: an input that never clears gets exactly two Enters", async () => {
  const { fake, opts } = setup({ swallowEnters: 99 });
  const r = await typeAndSubmit(opts, "%1", "[inbox: cloud] hi");
  assert.equal(r.result, "submitted: retried");
  assert.equal(fake.sends().filter((s) => s[0] === "Enter").length, 2);
});

test("text that didn't reach the input box: no Enter at all", async () => {
  const { fake, opts } = setup({ eatText: true });
  const r = await typeAndSubmit(opts, "%1", "[inbox: cloud] hi");
  assert.deepEqual(r, { result: "not submitted: text not seen in Claude's input box", submitted: false });
  assert.deepEqual(fake.sends(), [["-l", "--", "[inbox: cloud] hi"]]);
});

test("force (Deliver now): two calls, no box needed, Enter only once the line appears on screen", async () => {
  const { fake, opts, sleeps, pane } = setup({ working: true });
  const r = await typeAndSubmit({ ...opts, force: true }, "%1", "[inbox: cloud] now");
  assert.deepEqual(r, { result: "submitted (delivered now by hand)", submitted: true });
  assert.deepEqual(fake.calls.map((c) => c.join(" ")), ["capture-pane -p -t %1", "send-keys -t %1 -l -- [inbox: cloud] now", "capture-pane -p -t %1", "send-keys -t %1 Enter"]);
  assert.deepEqual(sleeps, [200], "the delay between text and Enter; no retry");
  assert.deepEqual(pane.submitted, ["[inbox: cloud] now"]);
  // the same line already on screen (an earlier one in the transcript) doesn't count
  const eaten = setup({ eatText: true, input: "[inbox: cloud] now" });
  const e = await typeAndSubmit({ ...eaten.opts, force: true }, "%1", "[inbox: cloud] now");
  assert.equal(e.submitted, false);
  assert.deepEqual(eaten.fake.sends(), [["-l", "--", "[inbox: cloud] now"]], "no Enter");
  assert.equal(countOnScreen("│ > [inbox: cl\n│ oud] now  │\n> [inbox: cloud] now", "[inbox: cloud] now"), 2, "wrapped and boxed lines count");
});

test("a trailing ; survives tmux's command separator rule", async () => {
  const { fake, panes, opts, pane } = setup();
  await typeAndSubmit(opts, "%1", "[inbox: x] done;");
  assert.deepEqual(fake.sends()[0], ["-l", "--", "[inbox: x] done\\;"]);
  assert.deepEqual(pane.submitted, ["[inbox: x] done;"]);
  await assert.rejects(panes.sendLiteral("%1", "a\nb"), /line break/);
  await assert.rejects(panes.sendLiteral("motherapp:0.0", "x"), /not a pane id/);
});

test("list-panes: format, parsing, path last; exact pane resolution", async () => {
  assert.equal(PANE_FORMAT.split("\t").at(-1), "#{pane_current_path}");
  const panes = parsePanes(["%3\tmotherapp\t0\t0\t4242\t0\t1\tclaude\t/home/u/a\tb", "junk", "%7\tmotherapp2\t1\t2\t5\t1\t0\tbash\t/tmp", ""].join("\n"));
  assert.deepEqual(panes[0], { id: "%3", session: "motherapp", target: "motherapp:0.0", pid: 4242, inMode: false, attached: 1, command: "claude", path: "/home/u/a\tb" });
  assert.equal(panes[1]!.inMode, true);
  assert.equal(resolvePane(panes, "motherapp:0.0")?.id, "%3");
  assert.equal(resolvePane(panes, "%7")?.target, "motherapp2:1.2");
  assert.equal(resolvePane(panes, "motherapp"), undefined, "no prefix matching");
  assert.equal(resolvePane(panes, "motherapp:0"), undefined);
  const fake = new FakeTmux();
  fake.noServer = true;
  assert.deepEqual(await new TmuxPanes({ runner: fake, exists: () => true }).list(), { kind: "none", reason: "No tmux server is running." });
  fake.noServer = false;
  fake.fail = "error connecting to /tmp/tmux-1000/default (Permission denied)";
  await assert.rejects(new TmuxPanes({ runner: fake, exists: () => true }).list(), /Permission denied/);
});

test("which commands count as Claude", () => {
  for (const c of ["claude", "2.0.31", "1.0.128", "2.1.0-beta.1"]) assert.ok(isClaudeCommand(c), c);
  for (const c of ["node", "bash", "Claude", "claude-code", "vim", "2.0", ""]) assert.ok(!isClaudeCommand(c), c);
  assert.ok(isClaudeCommand("claude-code", ["claude-code"]));
});

test("checkScreen false: text, wait, Enter; the screen is never read", async () => {
  const { fake, opts, sleeps } = setup();
  const r = await typeAndSubmit({ ...opts, checkScreen: false }, "%1", "[inbox: cloud] hi");
  assert.deepEqual(r, { result: "sent (screen not checked)", submitted: true });
  assert.deepEqual(fake.calls.map((c) => c.join(" ")), ["send-keys -t %1 -l -- [inbox: cloud] hi", "send-keys -t %1 Enter"]);
  assert.deepEqual(sleeps, [200]);
});
