// Status dot timing (issue #15): set fades after 2 s, failed stays, a new action cancels a fade.
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import type { ControlStatus } from "@motherapp/protocol";
import { ActionRunner, DotStatus, SET_VISIBLE_MS } from "../src/actionRunner.ts";

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

function harness(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const shown: [ControlStatus, string | undefined][] = [];
  const dot = new DotStatus((s, e) => shown.push([s, e]));
  let fail: string | undefined;
  const runner = new ActionRunner(
    async () => {
      if (fail !== undefined) throw new Error(fail);
    },
    (s, e) => dot.set(s, e),
  );
  return { shown, dot, runner, failNext: (msg: string | undefined) => (fail = msg) };
}

test("status dot: set is shown, then hidden after 2 s", async (t) => {
  const { shown, dot, runner } = harness(t);
  assert.equal(SET_VISIBLE_MS, 2000);
  runner.send({ value: 1 });
  await flush();
  assert.deepEqual(shown, [["setting", undefined], ["set", undefined]]);
  t.mock.timers.tick(1999);
  assert.equal(dot.status, "set", "still shown just before 2 s");
  t.mock.timers.tick(1);
  assert.equal(dot.status, "idle");
  assert.deepEqual(shown.at(-1), ["idle", undefined]);
});

test("status dot: a new action during the fade goes straight to setting, with no leftover timer", async (t) => {
  const { shown, dot, runner } = harness(t);
  runner.send({ value: 1 });
  await flush();
  t.mock.timers.tick(1500); // green, about to fade
  let release!: () => void;
  const slow = new ActionRunner(() => new Promise<void>((r) => (release = r)), (s, e) => dot.set(s, e));
  slow.send({ value: 2 });
  assert.equal(dot.status, "setting");
  t.mock.timers.tick(5000); // the first success's fade must not hide "setting"
  assert.equal(dot.status, "setting");
  release();
  await flush();
  assert.equal(dot.status, "set");
  t.mock.timers.tick(2000);
  assert.equal(dot.status, "idle");
  assert.deepEqual(
    shown.map((s) => s[0]),
    ["setting", "set", "setting", "set", "idle"],
  );

  // and again after the fade has started (status idle): a new action shows setting
  runner.send({ value: 3 });
  assert.equal(dot.status, "setting");
});

test("status dot: failed doesn't fade and keeps its message until the next success", async (t) => {
  const { shown, dot, runner, failNext } = harness(t);
  failNext("monitor busy");
  runner.send({ value: 1 });
  await flush();
  assert.deepEqual(shown.at(-1), ["failed", "monitor busy"]);
  t.mock.timers.tick(60_000);
  assert.equal(dot.status, "failed");
  assert.equal(dot.error, "monitor busy");
  failNext(undefined);
  runner.send({ value: 2 });
  await flush();
  assert.equal(dot.status, "set");
  assert.equal(dot.error, undefined);
  t.mock.timers.tick(2000);
  assert.equal(dot.status, "idle");
});
