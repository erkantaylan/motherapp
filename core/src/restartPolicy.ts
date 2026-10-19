// Crash handling (DESIGN.md § 4.9): backoff 1 s, 2 s, 4 s ... capped at 30 s; after 5 crashes
// within 2 minutes stop retrying. Pure logic; the caller supplies timestamps.

export interface RestartPolicyOptions {
  baseMs?: number;
  maxMs?: number;
  maxCrashes?: number;
  windowMs?: number;
  /** A run at least this long resets the backoff to `baseMs`. */
  stableMs?: number;
}

export type CrashDecision = { giveUp: false; delayMs: number } | { giveUp: true; crashesInWindow: number };

export class RestartPolicy {
  readonly baseMs: number;
  readonly maxMs: number;
  readonly maxCrashes: number;
  readonly windowMs: number;
  readonly stableMs: number;
  private crashTimes: number[] = [];
  private consecutive = 0;
  private startedAt: number | undefined;

  constructor(opts: RestartPolicyOptions = {}) {
    this.baseMs = opts.baseMs ?? 1000;
    this.maxMs = opts.maxMs ?? 30_000;
    this.maxCrashes = opts.maxCrashes ?? 5;
    this.windowMs = opts.windowMs ?? 120_000;
    this.stableMs = opts.stableMs ?? 60_000;
  }

  recordStart(now: number): void {
    this.startedAt = now;
  }

  recordCrash(now: number): CrashDecision {
    if (this.startedAt !== undefined && now - this.startedAt >= this.stableMs) this.consecutive = 0;
    this.startedAt = undefined;
    this.consecutive++;
    this.crashTimes.push(now);
    this.crashTimes = this.crashTimes.filter((t) => now - t < this.windowMs);
    if (this.crashTimes.length >= this.maxCrashes) {
      return { giveUp: true, crashesInWindow: this.crashTimes.length };
    }
    const delayMs = Math.min(this.baseMs * 2 ** (this.consecutive - 1), this.maxMs);
    return { giveUp: false, delayMs };
  }

  /** Manual restart: forget the history. */
  reset(): void {
    this.crashTimes = [];
    this.consecutive = 0;
    this.startedAt = undefined;
  }
}
