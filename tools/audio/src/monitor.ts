// Keeps `pw-dump --monitor` running and hands each JSON batch it prints to `onBatch`. If it
// exits it is restarted with backoff (1 s, 2 s, 4 s … 30 s; reset after a run of ≥ 30 s).
// The first batch of every run is a full dump, flagged `first` so the model can start over.
import { JsonStreamParser } from "./jsonStream.ts";
import { spawnErrorMessage, stderrSummary } from "./runner.ts";
import type { Proc, Runner } from "./runner.ts";

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
  now(): number;
}

export const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

export interface MonitorLog {
  info(msg: string, fields?: Record<string, string | number | boolean>): void;
  warn(msg: string, fields?: Record<string, string | number | boolean>): void;
}

export interface MonitorOptions {
  runner: Runner;
  log: MonitorLog;
  onBatch(batch: unknown, first: boolean): void;
  /** pw-dump stopped; `retryInMs` until the next attempt. */
  onDown(reason: string, retryInMs: number): void;
  timers?: Timers;
  command?: string;
}

export const BACKOFF_START_MS = 1000;
export const BACKOFF_MAX_MS = 30_000;
/** A run at least this long resets the backoff. */
export const HEALTHY_RUN_MS = 30_000;

export class PwMonitor {
  private opts: MonitorOptions;
  private timers: Timers;
  private proc: Proc | undefined;
  private retryTimer: unknown;
  private backoff = BACKOFF_START_MS;
  private stopped = true;
  /** Number of times pw-dump was started. */
  runs = 0;

  constructor(opts: MonitorOptions) {
    this.opts = opts;
    this.timers = opts.timers ?? realTimers;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.launch();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer !== undefined) this.timers.clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    const p = this.proc;
    this.proc = undefined;
    p?.kill("SIGTERM");
  }

  private launch(): void {
    this.retryTimer = undefined;
    if (this.stopped) return;
    const cmd = this.opts.command ?? "pw-dump";
    const startedAt = this.timers.now();
    const parser = new JsonStreamParser();
    let first = true;
    let stderr = "";
    let ended = false;
    let proc: Proc;
    this.runs++;
    const end = (reason: string) => {
      if (ended) return;
      ended = true;
      if (this.proc === proc) this.proc = undefined;
      if (this.stopped) return;
      if (this.timers.now() - startedAt >= HEALTHY_RUN_MS) this.backoff = BACKOFF_START_MS;
      const delay = this.backoff;
      this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
      this.opts.log.warn(`pw-dump --monitor stopped: ${reason}; restarting in ${delay / 1000} s`);
      this.opts.onDown(reason, delay);
      this.retryTimer = this.timers.setTimeout(() => this.launch(), delay);
    };
    try {
      proc = this.opts.runner.spawn(cmd, ["--monitor"], { env: { NO_COLOR: "1" } });
    } catch (e) {
      proc = undefined as unknown as Proc;
      end(spawnErrorMessage(cmd, e as Error));
      return;
    }
    this.proc = proc;
    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk: string) => {
      if (ended) return;
      for (const text of parser.push(chunk)) {
        let batch: unknown;
        try {
          batch = JSON.parse(text);
        } catch (e) {
          this.opts.log.warn(`ignoring unparsable pw-dump output: ${(e as Error).message}`, { bytes: text.length });
          continue;
        }
        const isFirst = first;
        first = false;
        if (isFirst && this.runs > 1) this.opts.log.info("pw-dump --monitor is running again");
        this.opts.onBatch(batch, isFirst);
      }
    });
    proc.stderr?.on("data", (c: Buffer | string) => {
      stderr = (stderr + String(c)).slice(-2000);
    });
    proc.on("error", (e) => end(spawnErrorMessage(cmd, e)));
    proc.on("exit", (code, signal) => {
      const why = signal ? `killed by ${signal}` : `exit code ${code}`;
      const detail = stderrSummary(stderr);
      end(detail ? `${why}: ${detail}` : why);
    });
    proc.stdin?.on("error", () => {});
    proc.stdin?.end();
  }
}
