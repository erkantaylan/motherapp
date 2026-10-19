import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Clock } from "../src/toolHost.ts";

export const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "tools");

/** Manually advanced clock for restart timers. */
export class FakeClock implements Clock {
  t = 1_000_000;
  private timers: { at: number; fn: () => void; id: number }[] = [];
  private nextId = 1;

  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.push({ at: this.t + ms, fn, id });
    return id;
  }
  clearTimeout(h: unknown): void {
    this.timers = this.timers.filter((x) => x.id !== h);
  }
  /** Delays of the timers currently scheduled, relative to now. */
  pending(): number[] {
    return this.timers.map((x) => x.at - this.t);
  }
  advance(ms: number): void {
    this.t += ms;
    const due = this.timers.filter((x) => x.at <= this.t);
    this.timers = this.timers.filter((x) => x.at > this.t);
    for (const d of due) d.fn();
  }
}

export async function waitFor(pred: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
