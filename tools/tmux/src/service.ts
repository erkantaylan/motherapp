// Serve mode: while the page is watched (a visible tab shows it), polls `tmux list-sessions`
// every 2 s and publishes only what changed; unwatched it runs nothing and marks the list
// stale. Rows are keyed by session id ($3 → "3"), so a rename updates its row in place.
// Actions and `tmuxctl` always read tmux themselves.
import { RpcError } from "@motherapp/tool-sdk";
import type { JsonObject, JsonValue, Tool } from "@motherapp/tool-sdk";
import { diffState } from "./diff.ts";
import { TmuxError, sessionsToState } from "./tmux.ts";
import type { Tmux } from "./tmux.ts";

export interface Timers {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realTimers: Timers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export const POLL_MS = 2000;
export const INITIAL_STATE: JsonObject = { sessions: {} };

export interface ServiceOptions {
  tool: Tool;
  tmux: Tmux;
  timers?: Timers;
  intervalMs?: number;
  home?: string | undefined;
}

export class TmuxService {
  private tool: Tool;
  private tmux: Tmux;
  private timers: Timers;
  private intervalMs: number;
  private home: string | undefined;
  private timer: unknown;
  private inflight: Promise<void> | undefined;
  private running = false;
  /** Bumped on every watch edge, so a loop from an earlier watch period stops. */
  private loop = 0;
  private offWatch: (() => void) | undefined;
  private lastProblem = "";

  constructor(opts: ServiceOptions) {
    this.tool = opts.tool;
    this.tmux = opts.tmux;
    this.timers = opts.timers ?? realTimers;
    this.intervalMs = opts.intervalMs ?? POLL_MS;
    this.home = "home" in opts ? opts.home : process.env.HOME;
    this.registerActions();
  }

  start(): void {
    this.running = true;
    if (!this.tool.isStale("sessions")) this.tool.markStale("sessions"); // until the first poll
    this.offWatch = this.tool.onWatch((w) => this.onWatch(w));
    if (this.tool.watching) this.onWatch(true);
  }

  stop(): void {
    this.running = false;
    this.offWatch?.();
    this.offWatch = undefined;
    this.loop++;
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Watched: list now, then every 2 s. Unwatched: stop, and the list is stale until the next look. */
  private onWatch(watching: boolean): void {
    if (!this.running) return;
    const gen = ++this.loop;
    this.clearTimer();
    if (watching) {
      void this.tick(gen);
      return;
    }
    void (this.inflight ?? Promise.resolve()).then(() => {
      if (gen === this.loop && !this.tool.isStale("sessions")) this.tool.markStale("sessions");
    });
  }

  private async tick(gen: number): Promise<void> {
    await this.poll();
    if (this.running && gen === this.loop) this.timer = this.timers.setTimeout(() => void this.tick(gen), this.intervalMs);
  }

  /** One poll. A call while one is running shares it. */
  poll(): Promise<void> {
    this.inflight ??= this.pollOnce().finally(() => (this.inflight = undefined));
    return this.inflight;
  }

  private async pollOnce(): Promise<void> {
    const t = this.tool;
    try {
      const res = await this.tmux.list();
      const next = res.kind === "ok" ? sessionsToState(res.sessions, this.timers.now(), this.home) : {};
      this.publish(next as unknown as JsonValue);
      if (res.kind === "none") this.setStatus(res.reason);
      else this.setStatus(undefined);
      this.problem("");
    } catch (e) {
      const msg = e instanceof TmuxError ? e.message : `tmux list-sessions failed: ${(e as Error).message}`;
      this.problem(msg);
      if (!t.isStale("sessions")) t.markStale("sessions");
      this.setStatus(`${msg} Retrying every ${Math.round(this.intervalMs / 1000)} s.`);
    }
  }

  private publish(next: JsonValue): void {
    const t = this.tool;
    if (t.isStale("sessions")) {
      t.set("sessions", next); // one change for the whole map, and it is fresh again
      return;
    }
    for (const c of diffState("sessions", t.get("sessions"), next)) {
      if (c.value === null) t.delete(c.path);
      else t.set(c.path, c.value);
    }
  }

  private setStatus(text: string | undefined): void {
    const cur = this.tool.get("status");
    if (text === undefined) {
      if (cur !== undefined) this.tool.delete("status");
    } else if (cur !== text) {
      this.tool.set("status", text);
    }
  }

  /** Logs a listing problem once, and its recovery. */
  private problem(msg: string): void {
    if (msg === this.lastProblem) return;
    if (msg) this.tool.log.warn(msg);
    else this.tool.log.info("tmux sessions readable again");
    this.lastProblem = msg;
  }

  private registerActions(): void {
    this.tool.action("kill", async (args) => {
      const id = args.id;
      if (typeof id !== "string" || !/^\d+$/.test(id)) throw new RpcError(-32602, "id must be a tmux session id without the $");
      const name = this.tool.get(`sessions.${id}.name`);
      // By id: exact like "=<name>", and immune to a rename since the page last polled.
      await this.tmux.kill(`$${id}`);
      this.tool.log.info(`killed tmux session ${typeof name === "string" ? `'${name}'` : `$${id}`}`, { id: `$${id}` });
      await this.inflight;
      await this.poll(); // the row goes away now, not on the next tick
    });
  }
}
