// Serve mode. While the page is watched (a visible tab shows it) it reads sysfs every second
// and publishes only what changed; unwatched it reads nothing and marks the polled values
// stale. The saved profiles come from cpu.json, re-read whenever the page opens, so an edit
// shows up without a restart. Read-only: the only file this tool writes is a missing cpu.json.
import type { JsonObject, JsonValue, Tool } from "@motherapp/tool-sdk";
import { diffState } from "./diff.ts";
import { APPLY_NOTE, activeLine, buildReport, polledState, profilesState } from "./model.ts";
import { loadSettings } from "./settings.ts";
import type { Snapshot } from "./sysfs.ts";

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export const POLL_MS = 1000;
/** Top-level keys refreshed by the poll; stale while nobody watches. */
export const POLLED = ["cpu", "ccx", "cores", "sensors"] as const;
export const INITIAL_STATE: JsonObject = { cpu: {}, ccx: {}, cores: {}, sensors: {}, profiles: {} };

export interface ServiceOptions {
  tool: Tool;
  /** One fresh sysfs read (readSnapshot bound to a root). */
  read: () => Snapshot;
  settingsFile: string;
  timers?: Timers;
  intervalMs?: number;
}

export class CpuService {
  private tool: Tool;
  private read: () => Snapshot;
  private settingsFile: string;
  private timers: Timers;
  private intervalMs: number;
  private timer: unknown;
  private running = false;
  private offWatch: (() => void) | undefined;
  private lastProblem = "";
  private ccxCount: number | undefined;
  private watched = false;

  constructor(opts: ServiceOptions) {
    this.tool = opts.tool;
    this.read = opts.read;
    this.settingsFile = opts.settingsFile;
    this.timers = opts.timers ?? realTimers;
    this.intervalMs = opts.intervalMs ?? POLL_MS;
  }

  /**
   * One read at start, so the page has its shape (model, CCX and core rows) before anyone
   * looks, then stale until watched. Creates cpu.json with the defaults if it is missing.
   */
  start(): void {
    this.running = true;
    this.poll();
    this.loadProfiles(true);
    for (const k of POLLED) if (!this.tool.isStale(k)) this.tool.markStale(k);
    this.offWatch = this.tool.onWatch((w) => this.onWatch(w));
    if (this.tool.watching) this.onWatch(true);
  }

  stop(): void {
    this.running = false;
    this.offWatch?.();
    this.offWatch = undefined;
    this.watched = false;
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private onWatch(watching: boolean): void {
    if (!this.running) return;
    this.clearTimer();
    this.watched = watching;
    if (!watching) {
      for (const k of POLLED) if (!this.tool.isStale(k)) this.tool.markStale(k);
      return;
    }
    this.loadProfiles(false);
    this.tick();
  }

  private tick(): void {
    this.poll();
    if (this.running && this.watched) this.timer = this.timers.setTimeout(() => this.tick(), this.intervalMs);
  }

  /** One sysfs read, published as deltas (or whole, for a key that was stale). */
  poll(): void {
    let snap: Snapshot;
    try {
      snap = this.read();
    } catch (e) {
      // readSnapshot doesn't throw for missing files; this is a bug or a broken reader.
      this.problem(`Reading the CPU failed: ${(e as Error).message}`);
      return;
    }
    const report = buildReport(snap);
    this.ccxCount = report.ccx.length || undefined;
    const next = polledState(report);
    for (const k of POLLED) this.publish(k, next[k]!);
    this.problem(report.problems.join(" "));
  }

  private publish(key: string, next: JsonValue): void {
    const t = this.tool;
    if (t.isStale(key)) {
      t.set(key, next); // one change for the whole key, and it is fresh again
      return;
    }
    for (const c of diffState(key, t.get(key), next)) {
      if (c.value === null) t.delete(c.path);
      else t.set(c.path, c.value);
    }
  }

  private setText(key: string, text: string | undefined): void {
    const cur = this.tool.get(key);
    if (text === undefined || text === "") {
      if (cur !== undefined) this.tool.delete(key);
    } else if (cur !== text) {
      this.tool.set(key, text);
    }
  }

  /** Shows a reading problem on the page and logs it once, and its recovery. */
  private problem(msg: string): void {
    this.setText("status", msg);
    if (msg === this.lastProblem) return;
    if (msg) this.tool.log.warn(msg);
    else if (this.lastProblem) this.tool.log.info("CPU readable again");
    this.lastProblem = msg;
  }

  loadProfiles(create: boolean): void {
    const loaded = loadSettings(this.settingsFile, { create });
    if (loaded.created) this.tool.log.info(`created ${this.settingsFile} with the default profiles`);
    for (const p of loaded.problems) this.tool.log.warn(p);
    this.publish("profiles", profilesState(loaded.settings, this.ccxCount));
    this.setText("profilesActive", activeLine(loaded.settings));
    this.setText("profilesNote", `${APPLY_NOTE} The profiles are read from ${this.settingsFile}.`);
    this.setText("profilesStatus", loaded.problems.join(" "));
  }
}
