// Scheduling for monitor calls.
//
// Serial: one call at a time per monitor, in order. A call queued behind a running one is
// coalesced with a queued call of the same kind: while a write runs, newer slider values
// replace each other and only the newest is written; its callers all get that outcome.
//
// Gate: monitor calls share it; detection takes it exclusively, because a redetect
// invalidates every display handle.
import { BackendError } from "./backend.ts";

interface Waiter {
  resolve(v: unknown): void;
  reject(e: unknown): void;
}

interface Op {
  kind: string;
  task: () => Promise<unknown>;
  waiters: Waiter[];
}

export class Serial {
  private queue: Op[] = [];
  private running: Op | undefined;

  run<T>(kind: string, task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const w: Waiter = { resolve: resolve as (v: unknown) => void, reject };
      const last = this.queue.at(-1);
      if (last && last.kind === kind) {
        last.task = task;
        last.waiters.push(w);
      } else {
        this.queue.push({ kind, task, waiters: [w] });
      }
      if (!this.running) void this.pump();
    });
  }

  /** True while a call of this kind runs or waits. */
  has(kind: string): boolean {
    return this.running?.kind === kind || this.queue.some((o) => o.kind === kind);
  }

  get idle(): boolean {
    return !this.running && this.queue.length === 0;
  }

  private async pump(): Promise<void> {
    while (this.queue.length > 0) {
      const op = this.queue.shift()!;
      this.running = op;
      try {
        const v = await op.task();
        for (const w of op.waiters) w.resolve(v);
      } catch (e) {
        for (const w of op.waiters) w.reject(e);
      }
      this.running = undefined;
    }
  }
}

export class Gate {
  private sharedCount = 0;
  private exclusiveActive = false;
  private exclusiveWaiting = 0;
  private wake: (() => void)[] = [];

  private changed(): Promise<void> {
    return new Promise((r) => this.wake.push(r));
  }

  private notify(): void {
    const w = this.wake;
    this.wake = [];
    for (const f of w) f();
  }

  async shared<T>(fn: () => Promise<T>): Promise<T> {
    while (this.exclusiveActive || this.exclusiveWaiting > 0) await this.changed();
    this.sharedCount++;
    try {
      return await fn();
    } finally {
      this.sharedCount--;
      this.notify();
    }
  }

  async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    this.exclusiveWaiting++;
    while (this.exclusiveActive || this.sharedCount > 0) await this.changed();
    this.exclusiveWaiting--;
    this.exclusiveActive = true;
    try {
      return await fn();
    } finally {
      this.exclusiveActive = false;
      this.notify();
    }
  }
}

/** Rejects with `message` after `ms`; the underlying call is left to finish on its own. */
export function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new BackendError(message)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
