// The idle heuristic against capture-pane fixtures (test/fixtures/screens/).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { analyseScreen, idleState, inputHas } from "../src/idle.ts";
import { showsOurLine } from "../src/deliver.ts";

const dir = new URL("./fixtures/screens/", import.meta.url);
const fixtures = fs.readdirSync(dir).filter((f) => f.endsWith(".txt"));
const read = (f: string) => fs.readFileSync(new URL(f, dir), "utf8");

test("there are idle and busy fixtures", () => {
  assert.ok(fixtures.filter((f) => f.startsWith("idle-")).length >= 4);
  assert.ok(fixtures.filter((f) => f.startsWith("busy-")).length >= 8);
});

for (const f of fixtures) {
  const wantIdle = f.startsWith("idle-");
  test(`${f}: ${wantIdle ? "idle" : "busy"}`, () => {
    const screen = read(f);
    for (const variant of [screen, screen.replace(/^(\s*(?:│\s?)?>) /gm, "$1\u00A0"), screen.replace(/\n/g, "\r\n")]) {
      const r = idleState(variant, false);
      assert.equal(r.idle, wantIdle, `${f}: ${JSON.stringify(r)}`);
      // copy mode always wins
      assert.equal(idleState(variant, true).idle, false);
    }
  });
}

test("reasons a person can read", () => {
  assert.deepEqual(idleState(read("busy-typing.txt"), false), { idle: false, reason: "someone is typing in the pane" });
  assert.deepEqual(idleState(read("busy-typing-wrapped.txt"), false), { idle: false, reason: "someone is typing in the pane" });
  assert.deepEqual(idleState(read("busy-working.txt"), false), { idle: false, reason: "Claude is working" });
  assert.deepEqual(idleState(read("busy-working-ctrlc.txt"), false), { idle: false, reason: "Claude is working" });
  assert.match((idleState(read("busy-dialog.txt"), false) as { reason: string }).reason, /input box isn't on screen/);
  assert.match((idleState(read("busy-shell.txt"), false) as { reason: string }).reason, /input box isn't on screen/);
  assert.deepEqual(idleState(read("idle-empty.txt"), true), { idle: false, reason: "the pane is in copy mode" });
  assert.deepEqual(idleState("", false).idle, false);
});

test("analyseScreen: input text, wrapped lines joined, placeholder, old box style", () => {
  assert.equal(analyseScreen(read("busy-typing.txt")).input, "now let's look at the tunnel restart log");
  assert.equal(
    analyseScreen(read("busy-typing-wrapped.txt")).input,
    "and then check the second half of the log for errors that mention the quick tunnel, because the host changed",
  );
  const ph = analyseScreen(read("idle-placeholder-at-top.txt"));
  assert.deepEqual([ph.box, ph.input, ph.placeholder], [true, "", true]);
  const old = analyseScreen(read("idle-old-box.txt"));
  assert.deepEqual([old.box, old.input, old.working], [true, "", false]);
  const typedInOld = read("idle-old-box.txt").replace("│ >  ", "│ > hi");
  assert.equal(analyseScreen(typedInOld).input, "hi");
  assert.equal(idleState(typedInOld, false).idle, false);
});

test("inputHas / showsOurLine: our line in the box, wrapped or collapsed to [Pasted text]", () => {
  const rule = "─".repeat(40);
  const screen = (...input: string[]) => ["● ok", "", rule, `> ${input[0] ?? ""}`, ...input.slice(1).map((l) => `  ${l}`), rule, "  ? for shortcuts", ""].join("\n");
  assert.ok(inputHas(screen("[inbox: cloud] CI is", "red on main"), "[inbox: cloud] CI is red on main"));
  assert.ok(showsOurLine(screen("[inbox: cloud] CI is", "red on main")));
  assert.ok(showsOurLine(screen("[inbo", "x: cloud] wrapped mid-word")));
  assert.ok(showsOurLine(screen("[Pasted text #1 +0 lines]")));
  assert.ok(!showsOurLine(screen("")));
  assert.ok(!showsOurLine(screen("the user's own words")));
  assert.ok(!showsOurLine(read("busy-dialog.txt")));
});
