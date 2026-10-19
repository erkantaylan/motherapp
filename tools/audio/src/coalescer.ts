// Serializes writes per key and keeps only the newest pending one: while a `wpctl` call for an
// app is running, further slider values replace each other, and only the last is applied.
// Callers whose value was superseded get the outcome of the write that replaced it.

interface Waiter {
  resolve(): void;
  reject(e: unknown): void;
}

interface Slot {
  running: boolean;
  next?: { task: () => Promise<void>; waiters: Waiter[] };
}

export class Coalescer {
  private slots = new Map<string, Slot>();

  run(key: string, task: () => Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let slot = this.slots.get(key);
      if (!slot) {
        slot = { running: false };
        this.slots.set(key, slot);
      }
      if (slot.next) {
        slot.next.task = task;
        slot.next.waiters.push({ resolve, reject });
      } else {
        slot.next = { task, waiters: [{ resolve, reject }] };
      }
      if (!slot.running) void this.pump(key, slot);
    });
  }

  /** True while a write for `key` is running or waiting. */
  busy(key: string): boolean {
    return this.slots.has(key);
  }

  private async pump(key: string, slot: Slot): Promise<void> {
    slot.running = true;
    while (slot.next) {
      const { task, waiters } = slot.next;
      delete slot.next;
      try {
        await task();
        for (const w of waiters) w.resolve();
      } catch (e) {
        for (const w of waiters) w.reject(e);
      }
    }
    slot.running = false;
    this.slots.delete(key);
  }
}
