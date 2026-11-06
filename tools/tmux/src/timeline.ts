// A small busy/idle history per session: one bucket a minute for the last hour, in memory only.
// It is published as a string, one character a minute, oldest first, so a session costs 60 bytes
// and a delta only when a character changes:
//   "-" no data yet, "0".."9" the part of that minute it was busy, "w" it waited on you.
import type { SessionState } from "./state.ts";

export const BUCKET_MS = 60_000;
export const BUCKETS = 60;

interface Bucket {
  samples: number;
  busy: number;
  waiting: boolean;
}

export class Timeline {
  private sessions = new Map<string, Map<number, Bucket>>();

  add(key: string, state: SessionState, nowMs: number): void {
    let buckets = this.sessions.get(key);
    if (!buckets) this.sessions.set(key, (buckets = new Map()));
    const index = Math.floor(nowMs / BUCKET_MS);
    let b = buckets.get(index);
    if (!b) {
      buckets.set(index, (b = { samples: 0, busy: 0, waiting: false }));
      for (const old of buckets.keys()) if (old <= index - BUCKETS) buckets.delete(old);
    }
    b.samples++;
    if (state === "working") b.busy++;
    if (state === "waiting") b.waiting = true;
  }

  encode(key: string, nowMs: number): string {
    const buckets = this.sessions.get(key);
    const last = Math.floor(nowMs / BUCKET_MS);
    let out = "";
    for (let i = last - BUCKETS + 1; i <= last; i++) {
      const b = buckets?.get(i);
      if (!b) out += "-";
      else if (b.waiting) out += "w";
      else out += b.busy === 0 ? "0" : String(Math.max(1, Math.round((b.busy / b.samples) * 9)));
    }
    return out;
  }

  /** Forgets every session not in `keys`. */
  keep(keys: ReadonlySet<string>): void {
    for (const k of this.sessions.keys()) if (!keys.has(k)) this.sessions.delete(k);
  }
}
