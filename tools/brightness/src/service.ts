// Serve mode: keeps one entry per monitor in state, answers the page's actions, and talks to
// the backend without ever making the page wait on DDC/CI:
// - the last known values come from the state file (stale) and are re-read in the background;
// - detection runs once at start, then only on demand or after a failure;
// - calls are serialized per monitor and slider writes are coalesced (newest value wins);
// - every call has a timeout, so a monitor that is off or unplugged fails with a message.
import { RpcError } from "@motherapp/tool-sdk";
import type { JsonObject, JsonValue, Logger, Tool } from "@motherapp/tool-sdk";
import { BackendError } from "./backend.ts";
import type { Backend, MonitorInfo } from "./backend.ts";
import { applySpec, clampPercent, keysFor, matchMonitor, parseValueSpec, subtitleFor, titleFor, toPercent, toRaw } from "./model.ts";
import type { MonitorEntry } from "./model.ts";
import { Gate, Serial, withTimeout } from "./queue.ts";
import type { Selected } from "./select.ts";

export const INITIAL_STATE: JsonObject = { monitors: {}, all: {} };

export interface ServiceOptions {
  tool: Tool;
  /** Creates the backend (libddcutil or the ddcutil fallback). */
  backend: () => Promise<Selected>;
  /** Timeout for one read or write. Default 7 s. */
  callTimeoutMs?: number;
  /** Timeout for a detection. Default 20 s. */
  detectTimeoutMs?: number;
  /** Re-read a monitor this long after its last write, to confirm it. Default 1.5 s. */
  confirmDelayMs?: number;
  /** Background re-read of every monitor. Default 2 min; 0 turns it off. */
  pollMs?: number;
  /** While a known monitor is missing, re-detect after this long, doubling up to 30 min. Default 60 s. */
  missingRetryMs?: number;
  /** At most one detection triggered by failures per this long. Default 5 s. */
  failureDetectGapMs?: number;
  /** Default: the tool's logger. */
  log?: Logger;
  /** Read newly found monitors right after a detection. Default true. */
  readOnDetect?: boolean;
}

interface Monitor {
  key: string;
  info: MonitorInfo;
  present: boolean;
  /** Raw maximum from the last read (100 until read). */
  max: number;
  /** Last value confirmed by a read or a successful write, in percent. */
  confirmed?: number;
  /** Newest requested value not yet written. */
  target?: number;
  /** Bumped on every write request; a read only publishes if no write came in meanwhile. */
  writeSeq: number;
  lastWriteAt: number;
  /** Read once during this run. */
  readThisRun: boolean;
  queue: Serial;
  confirmTimer?: ReturnType<typeof setTimeout>;
}

const invalid = (msg: string) => new RpcError(-32602, msg);

export class BrightnessService {
  private tool: Tool;
  private opts: ServiceOptions;
  private backend: Backend | undefined;
  private backendReady: Promise<Backend | undefined> | undefined;
  private monitors = new Map<string, Monitor>();
  private gate = new Gate();
  private detecting: Promise<void> | undefined;
  private detectedOnce = false;
  private lastFailureDetect = 0;
  private missingTimer: ReturnType<typeof setTimeout> | undefined;
  private missingDelay: number;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private handlers = new Map<string, (args: JsonObject) => Promise<JsonValue | void>>();
  private log: Logger;

  constructor(opts: ServiceOptions) {
    this.tool = opts.tool;
    this.opts = opts;
    this.log = opts.log ?? opts.tool.log;
    this.missingDelay = opts.missingRetryMs ?? 60_000;
    this.registerActions();
  }

  private get callTimeout(): number {
    return this.opts.callTimeoutMs ?? 7000;
  }

  // ---- lifecycle ----

  /** Shows the cached monitors (stale) right away, then loads the backend and detects. */
  start(): Promise<void> {
    const t = this.tool;
    const cached = t.get("monitors");
    if (typeof cached === "object" && cached !== null && !Array.isArray(cached)) {
      for (const [key, v] of Object.entries(cached as Record<string, JsonValue>)) {
        const e = v as unknown as Partial<MonitorEntry>;
        if (typeof e !== "object" || e === null || typeof e.bus !== "number") {
          t.delete(`monitors.${key}`);
          continue;
        }
        const info: MonitorInfo = { bus: e.bus, mfg: e.mfg ?? "", model: e.model ?? "", serial: e.serial ?? "" };
        if (e.connector) info.connector = e.connector;
        const m = this.newMonitor(key, info);
        if (typeof e.brightness === "number") m.confirmed = e.brightness;
        this.monitors.set(key, m);
      }
    } else {
      t.set("monitors", {});
    }
    // Loaded state is stale at the top level; narrow that down to the values a read confirms.
    t.markFresh("monitors");
    for (const m of this.monitors.values()) {
      this.publishEntry(m, undefined); // drops notes from the last run
      t.markStale(`monitors.${m.key}.brightness`);
    }
    if (t.get("all") === undefined) t.set("all", {});
    t.markFresh("all");
    for (const k of ["warning", "status", "allNote", "backend"]) if (t.get(k) !== undefined) t.delete(k);
    if (this.monitors.size === 0) t.set("status", "Looking for monitors…");
    this.updateAll();

    this.backendReady = this.opts.backend().then(
      (sel) => {
        this.backend = sel.backend;
        t.set("backend", `Talking to the monitors through ${sel.backend.description}.`);
        this.log.info(`brightness backend: ${sel.backend.description}`);
        if (sel.warning) {
          t.set("warning", `⚠️ ${sel.warning}`);
          this.log.warn(sel.warning);
        }
        return sel.backend;
      },
      (e: Error) => {
        t.set("warning", `⚠️ No way to talk to the monitors: ${e.message}`);
        this.log.error(`no brightness backend: ${e.message}`);
        return undefined;
      },
    );
    const pollMs = this.opts.pollMs ?? 120_000;
    if (pollMs > 0) {
      this.pollTimer = setInterval(() => void this.poll(), pollMs);
      this.pollTimer.unref?.();
    }
    return this.detect(false).catch(() => {});
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.missingTimer) clearTimeout(this.missingTimer);
    for (const m of this.monitors.values()) if (m.confirmTimer) clearTimeout(m.confirmTimer);
    await this.backend?.close();
  }

  private newMonitor(key: string, info: MonitorInfo): Monitor {
    return { key, info, present: false, max: 100, writeSeq: 0, lastWriteAt: 0, readThisRun: false, queue: new Serial() };
  }

  private async requireBackend(): Promise<Backend> {
    const b = this.backend ?? (await this.backendReady);
    if (!b) throw new BackendError((this.tool.get("warning") as string | undefined)?.replace(/^⚠️ /, "") ?? "no brightness backend");
    return b;
  }

  // ---- detection ----

  /**
   * Detects monitors. `explicit` (the Re-detect button, `brightctl detect`) also drops rows of
   * monitors that weren't found; automatic detections only mark them missing.
   */
  detect(explicit: boolean): Promise<void> {
    if (this.detecting) return this.detecting;
    this.detecting = this.runDetect(explicit).finally(() => (this.detecting = undefined));
    return this.detecting;
  }

  private async runDetect(explicit: boolean): Promise<void> {
    const t = this.tool;
    let backend: Backend;
    try {
      backend = await this.requireBackend();
    } catch (e) {
      if (this.monitors.size === 0) t.set("status", `Can't look for monitors: ${(e as Error).message}`);
      throw e;
    }
    let found: MonitorInfo[];
    try {
      const redetect = this.detectedOnce;
      found = await this.gate.exclusive(() =>
        withTimeout(backend.detect(redetect), this.opts.detectTimeoutMs ?? 20_000, "detecting monitors took too long"),
      );
      this.detectedOnce = true;
    } catch (e) {
      const msg = (e as Error).message;
      this.log.warn(`monitor detection failed: ${msg}`);
      if (this.monitors.size === 0) t.set("status", `Can't detect monitors: ${msg}`);
      throw e;
    }
    if (this.stopped) return;
    this.reconcile(found, explicit);
    if (this.opts.readOnDetect === false) return;
    const toRead = [...this.monitors.values()].filter((m) => m.present && !m.readThisRun);
    for (const m of toRead) void this.read(m).catch(() => {});
  }

  private reconcile(found: MonitorInfo[], explicit: boolean): void {
    const t = this.tool;
    const keys = keysFor(found);
    const seen = new Set<string>();
    found.forEach((info, i) => {
      const key = keys[i]!;
      seen.add(key);
      let m = this.monitors.get(key);
      const isNew = !m;
      if (!m) {
        m = this.newMonitor(key, info);
        this.monitors.set(key, m);
        this.log.info(`monitor found: ${titleFor(info)}`, { key, bus: info.bus, connector: info.connector ?? null });
      } else if (m.info.bus !== info.bus) {
        this.log.info(`${titleFor(info)} moved to /dev/i2c-${info.bus}`, { key });
      }
      m.info = info;
      const wasPresent = m.present;
      m.present = true;
      if (isNew || !wasPresent) m.readThisRun = false;
      this.publishEntry(m, undefined);
    });
    let missing = 0;
    for (const m of [...this.monitors.values()]) {
      if (seen.has(m.key)) continue;
      if (explicit) {
        this.log.info(`monitor gone: ${titleFor(m.info)}`, { key: m.key });
        this.monitors.delete(m.key);
        t.delete(`monitors.${m.key}`);
        continue;
      }
      if (m.present) this.log.warn(`monitor not found: ${titleFor(m.info)}`, { key: m.key });
      m.present = false;
      missing++;
      this.publishEntry(m, "not found, switched off or unplugged?");
      t.markStale(`monitors.${m.key}.brightness`);
    }
    if (this.monitors.size === 0) {
      t.set("status", "No monitors with DDC/CI found. Is the i2c-dev module loaded, and is DDC/CI switched on in the monitors' menus?");
    } else if (t.get("status") !== undefined) {
      t.delete("status");
    }
    this.updateAll();
    this.scheduleMissingRetry(missing > 0);
  }

  private scheduleMissingRetry(anyMissing: boolean): void {
    if (this.missingTimer) clearTimeout(this.missingTimer);
    this.missingTimer = undefined;
    if (!anyMissing || this.stopped) {
      this.missingDelay = this.opts.missingRetryMs ?? 60_000;
      return;
    }
    const delay = this.missingDelay;
    this.missingDelay = Math.min(delay * 2, 30 * 60_000);
    this.missingTimer = setTimeout(() => void this.detect(false).catch(() => {}), delay);
    this.missingTimer.unref?.();
  }

  /** A call failed in a way that suggests the monitor went away: re-detect (rate limited). */
  private detectAfterFailure(): void {
    const now = Date.now();
    if (now - this.lastFailureDetect < (this.opts.failureDetectGapMs ?? 5000)) return;
    this.lastFailureDetect = now;
    void this.detect(false).catch(() => {});
  }

  // ---- state ----

  private publishEntry(m: Monitor, note: string | undefined): void {
    const t = this.tool;
    const base = `monitors.${m.key}`;
    const entry: MonitorEntry = {
      title: titleFor(m.info),
      subtitle: subtitleFor(m.info, note),
      bus: m.info.bus,
      mfg: m.info.mfg,
      model: m.info.model,
      serial: m.info.serial,
      present: m.present,
    };
    if (m.info.connector) entry.connector = m.info.connector;
    if (note) entry.note = note;
    const cur = t.get(base) as Partial<MonitorEntry> | undefined;
    if (cur === undefined) {
      const full: MonitorEntry = { ...entry };
      if (m.confirmed !== undefined) full.brightness = m.confirmed;
      t.set(base, full as unknown as JsonObject);
      t.markStale(`${base}.brightness`); // until the first read
      return;
    }
    for (const [k, v] of Object.entries(entry) as [keyof MonitorEntry, JsonValue][]) {
      if (cur[k] !== v) t.set(`${base}.${k}`, v);
    }
    for (const k of ["connector", "note"] as const) {
      if (cur[k] !== undefined && entry[k] === undefined) t.delete(`${base}.${k}`);
    }
  }

  private setNote(m: Monitor, note: string | undefined): void {
    if (this.monitors.get(m.key) === m) this.publishEntry(m, note);
  }

  private publishBrightness(m: Monitor, percent: number, stale: boolean): void {
    if (this.monitors.get(m.key) !== m) return;
    const p = `monitors.${m.key}.brightness`;
    if (this.tool.get(p) !== percent || this.tool.isStale(p) !== stale) this.tool.set(p, percent, { stale });
    this.updateAll();
  }

  /** The linked slider: the common value when the monitors agree, otherwise the average. */
  private updateAll(): void {
    const t = this.tool;
    const vals: { title: string; v: number; stale: boolean }[] = [];
    for (const m of this.monitors.values()) {
      if (!m.present && this.detectedOnce) continue;
      const v = t.get(`monitors.${m.key}.brightness`);
      if (typeof v === "number") vals.push({ title: titleFor(m.info), v, stale: t.isStale(`monitors.${m.key}.brightness`) });
    }
    if (vals.length === 0) {
      if (t.get("all.brightness") !== undefined) t.delete("all.brightness");
      if (t.get("allNote") !== undefined) t.delete("allNote");
      return;
    }
    const equal = vals.every((x) => x.v === vals[0]!.v);
    const value = equal ? vals[0]!.v : Math.round(vals.reduce((s, x) => s + x.v, 0) / vals.length);
    const stale = vals.some((x) => x.stale);
    if (t.get("all.brightness") !== value || t.isStale("all.brightness") !== stale) t.set("all.brightness", value, { stale });
    const note = equal
      ? undefined
      : `The monitors differ (${vals.map((x) => `${x.title} ${x.v}%`).join(", ")}). The All monitors slider shows the average; moving it sets all of them to the same value.`;
    if (note === undefined) {
      if (t.get("allNote") !== undefined) t.delete("allNote");
    } else if (t.get("allNote") !== note) {
      t.set("allNote", note);
    }
  }

  // ---- monitor calls ----

  private fail(m: Monitor, e: unknown, what: "read" | "write"): Error {
    const msg = (e as Error).message;
    const title = titleFor(m.info);
    this.log.warn(`${title}: ${what} failed: ${msg}`, { key: m.key, bus: m.info.bus });
    if (e instanceof BackendError && e.gone) this.detectAfterFailure();
    return new Error(`${title}: ${msg}`);
  }

  /** Reads one monitor and publishes the value (unless a write came in meanwhile). */
  read(m: Monitor): Promise<number> {
    return m.queue.run("read", async () => {
      const backend = await this.requireBackend();
      const seq = m.writeSeq;
      let r;
      try {
        r = await this.gate.shared(() => withTimeout(backend.read(m.info.bus), this.callTimeout, `no answer within ${this.callTimeout / 1000} s`));
      } catch (e) {
        this.setNote(m, `last read failed: ${(e as Error).message}`);
        if (this.monitors.get(m.key) === m) this.tool.markStale(`monitors.${m.key}.brightness`);
        this.updateAll();
        throw this.fail(m, e, "read");
      }
      m.max = r.max > 0 ? r.max : 100;
      const pct = toPercent(r.current, m.max);
      m.readThisRun = true;
      if (seq === m.writeSeq && m.target === undefined) {
        m.confirmed = pct;
        this.publishBrightness(m, pct, false);
      }
      this.setNote(m, undefined);
      return pct;
    });
  }

  /** Sets one monitor; resolves when this value (or a newer one) is written. */
  write(m: Monitor, percent: number): Promise<void> {
    const pct = clampPercent(percent);
    m.target = pct;
    m.writeSeq++;
    m.lastWriteAt = Date.now();
    if (m.confirmTimer) clearTimeout(m.confirmTimer);
    // Show the new value now (unconfirmed), so the other sliders follow.
    this.publishBrightness(m, pct, true);
    return m.queue.run("write", async () => {
      const value = m.target ?? pct;
      const seq = m.writeSeq;
      try {
        const backend = await this.requireBackend();
        await this.gate.shared(() =>
          withTimeout(backend.write(m.info.bus, toRaw(value, m.max)), this.callTimeout, `no answer within ${this.callTimeout / 1000} s`),
        );
      } catch (e) {
        if (seq === m.writeSeq) {
          m.target = undefined;
          if (m.confirmed !== undefined) this.publishBrightness(m, m.confirmed, true);
          else if (this.monitors.get(m.key) === m) this.tool.markStale(`monitors.${m.key}.brightness`);
          this.setNote(m, `last change failed: ${(e as Error).message}`);
        }
        throw this.fail(m, e, "write");
      }
      m.confirmed = value;
      if (seq === m.writeSeq) {
        m.target = undefined;
        this.publishBrightness(m, value, false);
        this.setNote(m, undefined);
        this.scheduleConfirm(m);
      }
    });
  }

  private scheduleConfirm(m: Monitor): void {
    if (m.confirmTimer) clearTimeout(m.confirmTimer);
    m.confirmTimer = setTimeout(() => {
      m.confirmTimer = undefined;
      if (!this.stopped && !m.queue.has("write")) void this.read(m).catch(() => {});
    }, this.opts.confirmDelayMs ?? 1500);
    m.confirmTimer.unref?.();
  }

  private async poll(): Promise<void> {
    if (this.stopped || this.detecting) return;
    for (const m of this.monitors.values()) {
      if (!m.present || !m.queue.idle || Date.now() - m.lastWriteAt < 30_000) continue;
      void this.read(m).catch(() => {});
    }
  }

  // ---- lookups ----

  private list(): Monitor[] {
    return [...this.monitors.values()];
  }

  private matchable(m: Monitor) {
    const x = { key: m.key, title: titleFor(m.info), bus: m.info.bus, mfg: m.info.mfg, model: m.info.model, m } as {
      key: string;
      title: string;
      bus: number;
      mfg: string;
      model: string;
      connector?: string;
      m: Monitor;
    };
    if (m.info.connector) x.connector = m.info.connector;
    return x;
  }

  /** Monitors named by a command-line target ("all" or one monitor). */
  private targets(target: string): Monitor[] {
    if (target === "all") {
      const present = this.list().filter((m) => m.present);
      if (present.length === 0) throw new Error(this.monitors.size === 0 ? "no monitors found" : "none of the monitors was found on the last detect");
      return present;
    }
    return [matchMonitor(this.list().map((m) => this.matchable(m)), target).m];
  }

  private byKey(args: JsonObject): Monitor {
    const id = args.id;
    if (typeof id !== "string" || id === "") throw invalid("id must be a monitor key");
    const m = this.monitors.get(id);
    if (!m) throw new Error("That monitor is gone; reload the page.");
    return m;
  }

  /** Before writing to a monitor the last detect didn't find, look again (it may be back on). */
  private async ensurePresent(ms: Monitor[]): Promise<void> {
    if (ms.every((m) => m.present)) return;
    await this.detect(false).catch(() => {});
    const gone = ms.filter((m) => !m.present || this.monitors.get(m.key) !== m);
    if (gone.length > 0) {
      throw new Error(`${gone.map((m) => titleFor(m.info)).join(", ")}: not found, switched off or unplugged? Turn it on and press Re-detect.`);
    }
  }

  private summary(m: Monitor): JsonObject {
    const p = `monitors.${m.key}.brightness`;
    const v = this.tool.get(p);
    const out: JsonObject = { id: m.key, title: titleFor(m.info), bus: m.info.bus, present: m.present, stale: this.tool.isStale(p) };
    if (m.info.connector) out.connector = m.info.connector;
    if (typeof v === "number") out.brightness = v;
    return out;
  }

  /** Writes to several monitors at once; fails with every monitor's error if any failed. */
  private async writeMany(items: { m: Monitor; value: number }[]): Promise<void> {
    const results = await Promise.allSettled(items.map(({ m, value }) => this.write(m, value)));
    const errors = results.filter((r): r is PromiseRejectedResult => r.status === "rejected").map((r) => (r.reason as Error).message);
    if (errors.length > 0) throw new Error(errors.join("; "));
  }

  // ---- actions ----

  /** Runs an action like the core would (the CLI's direct mode uses this). */
  async call(name: string, args: JsonObject = {}): Promise<JsonValue | void> {
    const h = this.handlers.get(name);
    if (!h) throw new Error(`unknown action: ${name}`);
    return h(args);
  }

  private registerActions(): void {
    const t = this.tool;
    const reg = (name: string, fn: (args: JsonObject) => Promise<JsonValue | void>) => {
      this.handlers.set(name, fn);
      t.action(name, fn);
    };
    const percentArg = (args: JsonObject): number => {
      if (typeof args.value !== "number" || !Number.isFinite(args.value)) throw invalid("value must be a number");
      return clampPercent(args.value);
    };

    // One monitor's slider.
    reg("setBrightness", async (args) => {
      const m = this.byKey(args);
      const value = percentArg(args);
      await this.ensurePresent([m]);
      await this.write(m, value);
    });

    // The linked slider: every monitor to the same value.
    reg("setAll", async (args) => {
      const value = percentArg(args);
      const ms = this.targets("all");
      await this.writeMany(ms.map((m) => ({ m, value })));
    });

    // `brightctl set <monitor|all> <0-100|+N|-N>` through the core.
    reg("set", async (args) => {
      if (typeof args.target !== "string" || typeof args.value !== "string") throw invalid("target and value must be strings");
      let spec;
      try {
        spec = parseValueSpec(args.value);
      } catch (e) {
        throw invalid((e as Error).message);
      }
      const ms = this.targets(args.target);
      await this.ensurePresent(ms);
      const items = [];
      for (const m of ms) {
        // Relative steps build on a pending value, so quick repeated key presses add up.
        let base = m.target ?? (t.get(`monitors.${m.key}.brightness`) as number | undefined);
        if (spec.kind === "relative" && base === undefined) base = await this.read(m);
        items.push({ m, value: applySpec(spec, base) });
      }
      await this.writeMany(items);
      return ms.map((m) => this.summary(m));
    });

    // `brightctl get`: a fresh read.
    reg("read", async (args) => {
      const ms = typeof args.target === "string" ? this.targets(args.target) : this.list().filter((m) => m.present);
      const results = await Promise.allSettled(ms.map((m) => this.read(m)));
      const errors = results.filter((r): r is PromiseRejectedResult => r.status === "rejected").map((r) => (r.reason as Error).message);
      if (errors.length > 0 && errors.length === ms.length) throw new Error(errors.join("; "));
      return ms.map((m) => this.summary(m));
    });

    reg("redetect", async () => {
      await this.detect(true);
      await Promise.allSettled(this.list().filter((m) => m.present).map((m) => this.read(m)));
      return this.list().map((m) => this.summary(m));
    });
  }
}
