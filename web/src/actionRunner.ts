// Drives one control's status dot (DESIGN.md § 4.7): setting while a request is out, set on
// success, failed (with message) on error. While a request is in flight, newer values are
// coalesced: only the latest is sent once the reply arrives (sliders over slow devices).
// DOM-free.
import type { ControlStatus, JsonObject } from "@motherapp/protocol";

export type StatusListener = (status: ControlStatus, error?: string) => void;

/** How long a green "set" dot stays before it fades (DESIGN.md § 3 "Control feedback"). */
export const SET_VISIBLE_MS = 2000;

/**
 * What a status dot shows over time (issue #15): `set` is shown for `SET_VISIBLE_MS`, then
 * turns `idle` (the dot fades out in CSS but keeps its space); `setting` and `failed` stay until
 * the next status. Any new status cancels a pending fade, so an old success can never hide a
 * newer state. DOM-free; `statusDot()` in renderer.ts wraps it.
 */
export class DotStatus {
  status: ControlStatus = "idle";
  error: string | undefined;
  private show: StatusListener;
  private visibleMs: number;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(show: StatusListener, visibleMs = SET_VISIBLE_MS) {
    this.show = show;
    this.visibleMs = visibleMs;
  }

  set(status: ControlStatus, error?: string): void {
    this.cancel();
    this.status = status;
    this.error = status === "failed" ? error : undefined;
    this.show(status, this.error);
    if (status === "set") {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.status = "idle";
        this.show("idle");
      }, this.visibleMs);
    }
  }

  /** Drops a pending fade (e.g. when the control goes away). */
  cancel(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

export class ActionRunner {
  status: ControlStatus = "idle";
  error: string | undefined;
  private call: (args: JsonObject) => Promise<unknown>;
  private onStatus: StatusListener;
  private inFlight = false;
  private pending: JsonObject | undefined;
  private disposed = false;

  constructor(call: (args: JsonObject) => Promise<unknown>, onStatus: StatusListener) {
    this.call = call;
    this.onStatus = onStatus;
  }

  /** True while a request is out or a newer value waits to be sent. */
  get busy(): boolean {
    return this.inFlight || this.pending !== undefined;
  }

  send(args: JsonObject): void {
    if (this.inFlight) {
      this.pending = args;
      return;
    }
    void this.run(args);
  }

  dispose(): void {
    this.disposed = true;
  }

  private set(status: ControlStatus, error?: string): void {
    this.status = status;
    this.error = error;
    if (!this.disposed) this.onStatus(status, error);
  }

  private async run(args: JsonObject): Promise<void> {
    this.inFlight = true;
    if (this.status !== "setting") this.set("setting");
    let error: string | undefined;
    try {
      await this.call(args);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    this.inFlight = false;
    const next = this.pending;
    this.pending = undefined;
    if (next !== undefined) {
      void this.run(next); // the newer value decides the final status
      return;
    }
    if (error !== undefined) this.set("failed", error);
    else this.set("set");
  }
}
