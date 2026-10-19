import { test } from "node:test";
import assert from "node:assert/strict";
import { RestartPolicy } from "../src/restartPolicy.ts";

test("backoff doubles from 1 s and gives up at the 5th crash within 2 minutes", () => {
  const p = new RestartPolicy();
  let t = 0;
  const delays: number[] = [];
  for (let i = 0; i < 4; i++) {
    p.recordStart(t);
    const d = p.recordCrash(t + 100);
    assert.equal(d.giveUp, false);
    if (!d.giveUp) delays.push(d.delayMs);
    t += 100 + (d.giveUp ? 0 : d.delayMs);
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000]);
  p.recordStart(t);
  const last = p.recordCrash(t + 100);
  assert.deepEqual(last, { giveUp: true, crashesInWindow: 5 });
});

test("backoff is capped at 30 s when crashes are spread beyond the window", () => {
  const p = new RestartPolicy();
  let t = 0;
  const delays: number[] = [];
  for (let i = 0; i < 8; i++) {
    p.recordStart(t);
    t += 40_000; // runs 40 s (< stableMs) then crashes: only ~3 crashes per 2 minutes
    const d = p.recordCrash(t);
    assert.equal(d.giveUp, false, `crash ${i + 1} should not give up`);
    if (!d.giveUp) {
      delays.push(d.delayMs);
      t += d.delayMs;
    }
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
});

test("a stable run resets the backoff; reset() clears the history", () => {
  const p = new RestartPolicy();
  p.recordStart(0);
  p.recordCrash(10);
  p.recordStart(1010);
  p.recordCrash(1020);
  p.recordStart(3020);
  const d = p.recordCrash(3020 + 60_000); // ran a minute
  assert.deepEqual(d, { giveUp: false, delayMs: 1000 });
  for (let i = 0; i < 4; i++) p.recordCrash(70_000 + i);
  p.reset();
  assert.deepEqual(p.recordCrash(70_010), { giveUp: false, delayMs: 1000 });
});
