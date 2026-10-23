// Serve mode. While the page is watched (a visible tab shows it) it reads sysfs and cpu.json
// every second and publishes only what changed; unwatched it reads nothing and marks the
// polled values stale. It also keeps a short, capped `events` list of real things that
// happened (the tool started, cpu.json changed, boost / governor / EPP changed) for the page's
// event log. On AMD family 0x17 (tuningSupported) it is read-only: the only file it writes is
// a missing cpu.json. On Intel (src/intel.ts) it also publishes `limits` (clock caps, turbo,
// governor, EPP, PL1/PL2: now, stock, writable) and has the actions useProfile, saveProfile,
// setApplyOnStart and reapply, which write sysfs and cpu.json; the active profile is applied
// when the tool starts if applyOnStart is on. On other CPUs cpu.json is neither read nor
// created and `profiles` stays empty.
import { RpcError } from "@motherapp/tool-sdk";
import type { JsonObject, JsonValue, Tool } from "@motherapp/tool-sdk";
import {
  applyProfile,
  bootId,
  describeLimits,
  hasValues,
  intelProfilesState,
  limitsState,
  loadIntelSettings,
  loadStock,
  parseLimits,
  readLimits,
  targetOf,
  updateIntelSettings,
} from "./intel.ts";
import type { IntelSettings, Limits } from "./intel.ts";
import { diffState } from "./diff.ts";
import { buildReport, polledState, profilesState } from "./model.ts";
import type { Report } from "./model.ts";
import { loadSettings } from "./settings.ts";
import { PROFILE_IDS } from "./settings.ts";
import type { Profile, ProfileId, Settings } from "./settings.ts";
import type { Snapshot } from "./sysfs.ts";
import { EVENTS_CAP, pushEvent } from "./view.ts";
import type { CpuEvent } from "./view.ts";

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
/** Also polled, on Intel only. */
export const LIMITS = "limits";
const STALE_KEYS = [...POLLED, LIMITS];
export const INITIAL_STATE: JsonObject = { cpu: {}, ccx: {}, cores: {}, sensors: {}, limits: {}, profiles: {}, events: [] };

export interface ServiceOptions {
  tool: Tool;
  /** One fresh sysfs read (readSnapshot bound to a root). */
  read: () => Snapshot;
  settingsFile: string;
  timers?: Timers;
  intervalMs?: number;
  /** Clock for event timestamps (ms since the epoch). */
  now?: () => number;
  /** Intel limits: the sysfs root to write under and the stock snapshot file. Without it, Intel is read-only too. */
  limits?: { root: string; stockFile: string };
}

/** What the event log compares between reads. */
interface Watched {
  boost?: boolean;
  governor?: string;
  epp?: string;
}

const STOCK = "Stock";

function profileName(s: Settings, id: string | null): string {
  return id === null ? STOCK : (s.profiles.find((p) => p.id === id)?.name ?? id);
}

/** Which fields of a profile differ, worded for the log ("CCX clocks, Vcore"). */
function profileChanges(a: Profile, b: Profile): string[] {
  const out: string[] = [];
  if (a.name !== b.name) out.push("name");
  if (JSON.stringify(a.ccx) !== JSON.stringify(b.ccx)) out.push("CCX clocks");
  if (a.vcore !== b.vcore) out.push("Vcore");
  if (a.cinebenchR20 !== b.cinebenchR20) out.push("Cinebench R20");
  if (a.powerW !== b.powerW) out.push("power");
  return out;
}

/** Log lines for what changed in cpu.json between two good reads. */
export function settingsEvents(prev: Settings, next: Settings): string[] {
  const out: string[] = [];
  if (prev.active !== next.active) out.push(`cpu.json: active profile now ${profileName(next, next.active)} (was ${profileName(prev, prev.active)}).`);
  if (prev.applyOnStart !== next.applyOnStart) out.push(`cpu.json: apply at login turned ${next.applyOnStart ? "on" : "off"}.`);
  for (const p of next.profiles) {
    const old = prev.profiles.find((x) => x.id === p.id);
    if (!old) continue;
    const ch = profileChanges(old, p);
    if (ch.length) out.push(`cpu.json: ${p.name} changed (${ch.join(", ")}).`);
  }
  return out;
}

/** Log lines for boost / governor / EPP changes between two reads. */
export function cpufreqEvents(prev: Watched, next: Watched): { kind: string; text: string }[] {
  const out: { kind: string; text: string }[] = [];
  const onOff = (b: boolean) => (b ? "on" : "off");
  if (prev.boost !== undefined && next.boost !== undefined && prev.boost !== next.boost) {
    out.push({ kind: "boost", text: `Boost now ${onOff(next.boost)} (was ${onOff(prev.boost)}).` });
  }
  if (prev.governor && next.governor && prev.governor !== next.governor) out.push({ kind: "cpufreq", text: `Governor now ${next.governor} (was ${prev.governor}).` });
  if (prev.epp && next.epp && prev.epp !== next.epp) out.push({ kind: "cpufreq", text: `EPP now ${next.epp} (was ${prev.epp}).` });
  return out;
}

export class CpuService {
  private tool: Tool;
  private read: () => Snapshot;
  private settingsFile: string;
  private timers: Timers;
  private intervalMs: number;
  private now: () => number;
  private timer: unknown;
  private running = false;
  private offWatch: (() => void) | undefined;
  private lastProblem = "";
  private ccxCount: number | undefined;
  private watched = false;
  private seen: Watched | undefined;
  private settings: Settings | undefined;
  /** JSON of the last loaded settings + problems, to skip unchanged re-reads. */
  private settingsKey = "";
  private settingsProblems = "";
  private events: CpuEvent[] = [];
  /** Profiles apply to this CPU (set by the first read). */
  tuning = false;
  /** Intel limits apply (set by the first read). */
  intel = false;
  private limits: { root: string; stockFile: string } | undefined;
  private intelSettings: IntelSettings | undefined;
  private hybrid = false;

  constructor(opts: ServiceOptions) {
    this.tool = opts.tool;
    this.read = opts.read;
    this.settingsFile = opts.settingsFile;
    this.timers = opts.timers ?? realTimers;
    this.intervalMs = opts.intervalMs ?? POLL_MS;
    this.now = opts.now ?? Date.now;
    this.limits = opts.limits;
    this.registerActions();
  }

  /**
   * One read at start, so the page has its shape (model, CCX and core rows) before anyone
   * looks, then stale until watched. Creates cpu.json with the defaults if it is missing.
   */
  start(): void {
    this.running = true;
    this.poll();
    if (this.intel) this.startIntel();
    else if (!this.tuning) this.addEvent("start", "CPU tool started.");
    else this.startProfiles();
    for (const k of STALE_KEYS) if (!this.tool.isStale(k)) this.tool.markStale(k);
    this.offWatch = this.tool.onWatch((w) => this.onWatch(w));
    if (this.tool.watching) this.onWatch(true);
  }

  private startProfiles(): void {
    const created = this.loadProfiles(true);
    const s = this.settings!;
    const active = s.active === null ? "no profile active (stock)" : `${profileName(s, s.active)} active (nothing applied yet)`;
    this.addEvent("start", `CPU tool started: ${active}, apply at login ${s.applyOnStart ? "on" : "off"}.`);
    if (created) this.addEvent("config", "Created cpu.json with the default profiles.");
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
      for (const k of STALE_KEYS) if (!this.tool.isStale(k)) this.tool.markStale(k);
      return;
    }
    this.tick();
  }

  /** One sysfs read and one cpu.json read (a few hundred bytes), then the next in a second. */
  private tick(): void {
    this.poll();
    if (this.tuning) this.loadProfiles(false);
    if (this.intel) this.loadIntel(false);
    if (this.running && this.watched) this.timer = this.timers.setTimeout(() => this.tick(), this.intervalMs);
  }

  private addEvent(kind: string, text: string): void {
    this.events = pushEvent(this.events, { ts: this.now(), text, kind }, EVENTS_CAP);
    this.tool.set("events", this.events as unknown as JsonValue);
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
    this.tuning = report.tuning;
    this.intel = report.vendor === "Intel" && this.limits !== undefined;
    this.ccxCount = report.ccx.length || undefined;
    const next = polledState(report);
    for (const k of POLLED) this.publish(k, next[k]!);
    this.problem(report.problems.join(" "));
    this.noteCpufreq(report);
    if (this.intel) this.pollLimits();
  }

  private noteCpufreq(r: Report): void {
    const now: Watched = {};
    if (r.boost !== undefined) now.boost = r.boost;
    if (r.governor) now.governor = r.governor;
    if (r.epp) now.epp = r.epp;
    if (this.seen) for (const e of cpufreqEvents(this.seen, now)) this.addEvent(e.kind, e.text);
    this.seen = now;
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

  /**
   * Reads cpu.json; publishes, logs and records events only when it changed since the last
   * read. Returns whether the file was just created.
   */
  loadProfiles(create: boolean): boolean {
    const loaded = loadSettings(this.settingsFile, { create });
    const key = JSON.stringify([loaded.settings, loaded.problems, this.ccxCount ?? 0]);
    if (key === this.settingsKey) return false;
    this.settingsKey = key;
    if (loaded.created) this.tool.log.info(`created ${this.settingsFile} with the default profiles`);
    const problems = loaded.problems.join(" ");
    if (problems !== this.settingsProblems) {
      for (const p of loaded.problems) this.tool.log.warn(p);
      if (this.settings) {
        if (problems) this.addEvent("problem", `cpu.json can't be fully used: ${problems.replaceAll(`${this.settingsFile}: `, "")}`);
        else this.addEvent("problem", "cpu.json is fine again.");
      }
      this.settingsProblems = problems;
    }
    // A broken file reads as "both unset, stock": don't log that as the user's change.
    const broken = loaded.problems.some((p) => /isn't valid JSON|Can't read/.test(p));
    if (this.settings && !broken) for (const text of settingsEvents(this.settings, loaded.settings)) this.addEvent("config", text);
    if (!broken || !this.settings) this.settings = loaded.settings;
    this.publish("profiles", profilesState(loaded.settings, this.settingsFile, loaded.problems, this.ccxCount));
    return loaded.created === true;
  }

  // ---- Intel limits ----

  private startIntel(): void {
    const created = this.loadIntel(true);
    const s = this.intelSettings!;
    const active = s.active === null ? "no profile active (stock)" : `${intelName(s, s.active)} active`;
    this.addEvent("start", `CPU tool started: ${active}, apply at login ${s.applyOnStart ? "on" : "off"}.`);
    if (created) this.addEvent("config", "Created cpu.json with the default profiles.");
    if (s.active !== null && s.applyOnStart) {
      try {
        this.apply(s.active, "at start");
      } catch (e) {
        this.tool.log.warn(`applying ${s.active} at start failed: ${(e as Error).message}`);
      }
    }
  }

  /** Reads cpu.json (Intel shape); publishes and records events only when it changed. */
  loadIntel(create: boolean): boolean {
    const loaded = loadIntelSettings(this.settingsFile, { create });
    const key = JSON.stringify([loaded.settings, loaded.problems, this.hybrid]);
    if (key === this.settingsKey) return false;
    this.settingsKey = key;
    if (loaded.created) this.tool.log.info(`created ${this.settingsFile} with the default profiles`);
    const problems = loaded.problems.join(" ");
    if (problems !== this.settingsProblems) {
      for (const p of loaded.problems) this.tool.log.warn(p);
      if (this.intelSettings) {
        if (problems) this.addEvent("problem", `cpu.json can't be fully used: ${problems.replaceAll(`${this.settingsFile}: `, "")}`);
        else this.addEvent("problem", "cpu.json is fine again.");
      }
      this.settingsProblems = problems;
    }
    // A broken file reads as "both unset, stock": don't log that as the user's change.
    if (this.intelSettings && !loaded.broken) for (const text of intelSettingsEvents(this.intelSettings, loaded.settings)) this.addEvent("config", text);
    if (!loaded.broken || !this.intelSettings) this.intelSettings = loaded.settings;
    this.publish("profiles", intelProfilesState(loaded.settings, this.settingsFile, loaded.problems, this.hybrid) as JsonValue);
    this.pollLimits();
    return loaded.created === true;
  }

  /** One read of the limits, published with what the active profile (or stock) wants. */
  private pollLimits(): void {
    const l = this.limits;
    if (!l) return;
    const hw = readLimits(l.root);
    this.hybrid = hw.hybrid;
    const stock = loadStock(l.stockFile, bootId(l.root));
    const s = this.intelSettings;
    let target: Limits | undefined;
    // Nothing to compare against until motherapp has applied something this boot (the snapshot) or a profile is active.
    if (s?.active) target = targetOf(stock?.values ?? hw.current, s.profiles.find((p) => p.id === s.active), hw);
    else if (stock) target = targetOf(stock.values, undefined, hw);
    this.publish(LIMITS, limitsState(hw, stock, target) as JsonValue);
  }

  /** Applies a profile (null = stock), records it, publishes the new values. Throws when nothing could be changed. */
  private apply(id: ProfileId | null, why: string): { text: string; problems: string[] } {
    const l = this.limits!;
    const s = this.intelSettings!;
    const r = applyProfile(l.root, l.stockFile, s, id, this.now());
    const what = r.changed.length ? r.changed.join(", ") : "nothing needed changing";
    const text = `${r.name} applied ${why}: ${what}.`;
    if (r.problems.length && !r.changed.length) {
      const msg = `${r.name} not applied ${why}: ${r.problems.join(" ")}`;
      this.addEvent("problem", msg);
      this.tool.log.warn(msg);
      this.pollLimits();
      throw new RpcError(-32000, r.problems.join(" "));
    }
    this.addEvent("apply", text);
    for (const p of r.problems) this.addEvent("problem", p);
    this.tool.log.info(text, { problems: r.problems });
    this.pollLimits();
    return { text, problems: r.problems };
  }

  private needIntel(): void {
    if (!this.intel || !this.intelSettings) throw new RpcError(-32000, "Changing CPU limits is only available on Intel CPUs so far.");
    const loaded = loadIntelSettings(this.settingsFile);
    if (loaded.broken) throw new RpcError(-32000, loaded.problems.join(" "));
    this.intelSettings = loaded.settings;
  }

  private save(edit: (s: IntelSettings) => void): void {
    try {
      this.intelSettings = updateIntelSettings(this.settingsFile, edit);
    } catch (e) {
      throw new RpcError(-32000, `Couldn't save cpu.json: ${(e as Error).message}`);
    }
    this.loadIntel(false);
  }

  private registerActions(): void {
    const t = this.tool;
    const profileArg = (v: unknown, withStock: boolean): ProfileId | null => {
      if (withStock && v === "stock") return null;
      if (typeof v === "string" && (PROFILE_IDS as readonly string[]).includes(v)) return v as ProfileId;
      throw new RpcError(-32602, `id must be ${(withStock ? PROFILE_CHOICES : PROFILE_IDS).map((x) => `"${x}"`).join(", ")}`);
    };

    // Applies a profile (or stock) and makes it the active one in cpu.json.
    t.action("useProfile", (args) => {
      this.needIntel();
      const id = profileArg(args.id, true);
      const p = id === null ? undefined : this.intelSettings!.profiles.find((x) => x.id === id);
      if (p && !hasValues(p)) throw new RpcError(-32000, `${p.name} has nothing set yet: give it at least one value first.`);
      const r = this.apply(id, "now");
      if (this.intelSettings!.active !== id) this.save((s) => (s.active = id));
      return r as unknown as JsonValue;
    });

    // Puts the hardware back to the active profile (after something else changed it).
    t.action("reapply", () => {
      this.needIntel();
      return this.apply(this.intelSettings!.active, "again") as unknown as JsonValue;
    });

    // Replaces a profile's values (absent / null = stock); re-applies it when it is the active one.
    t.action("saveProfile", (args) => {
      this.needIntel();
      const id = profileArg(args.id, false) as ProfileId;
      const values = args.values;
      if (typeof values !== "object" || values === null || Array.isArray(values)) throw new RpcError(-32602, "values must be an object");
      const problems: string[] = [];
      const limits = parseLimits(values as Record<string, unknown>, problems);
      if (problems.length) throw new RpcError(-32602, problems.join("; "));
      const name = typeof args.name === "string" && args.name.trim() ? args.name.trim() : undefined;
      this.save((s) => {
        const i = s.profiles.findIndex((p) => p.id === id);
        s.profiles[i] = { id, name: name ?? s.profiles[i]!.name, ...limits };
      });
      const p = this.intelSettings!.profiles.find((x) => x.id === id)!;
      if (this.intelSettings!.active !== id) return { text: `${p.name} saved.`, problems: [] };
      const r = this.apply(id, "after saving");
      return r as unknown as JsonValue;
    });

    t.action("setApplyOnStart", (args) => {
      this.needIntel();
      if (typeof args.value !== "boolean") throw new RpcError(-32602, "value must be true or false");
      const v = args.value;
      this.save((s) => (s.applyOnStart = v));
      return { text: `Apply at login turned ${v ? "on" : "off"}.` };
    });
  }
}

// ---- Intel limits ----

const PROFILE_CHOICES = ["stock", ...PROFILE_IDS];

function intelName(s: IntelSettings, id: ProfileId | null): string {
  return id === null ? STOCK : (s.profiles.find((p) => p.id === id)?.name ?? id);
}

/** Log lines for what changed in cpu.json (Intel shape) between two good reads. */
export function intelSettingsEvents(prev: IntelSettings, next: IntelSettings): string[] {
  const out: string[] = [];
  if (prev.active !== next.active) out.push(`cpu.json: active profile now ${intelName(next, next.active)} (was ${intelName(prev, prev.active)}).`);
  if (prev.applyOnStart !== next.applyOnStart) out.push(`cpu.json: apply at login turned ${next.applyOnStart ? "on" : "off"}.`);
  for (const p of next.profiles) {
    const old = prev.profiles.find((x) => x.id === p.id);
    if (old && JSON.stringify(old) !== JSON.stringify(p)) out.push(`cpu.json: ${p.name} changed (${describeLimits(p, false) || "all stock"}).`);
  }
  return out;
}
