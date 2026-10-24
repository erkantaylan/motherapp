// Intel CPU limits (the user's call, 2026-10-23: the safe operations first): clock caps per
// core type, turbo, governor and EPP through cpufreq / intel_pstate, and the package power
// limits PL1/PL2 through RAPL (powercap). The kernel checks every value. The one setting outside
// sysfs is the undervolt (undervoltMV), set through a root helper (src/voltage.ts).
//
// Writing needs access to the sysfs files, which motherapp-cpu-access.service grants the
// user's group at boot (packaging/, offered by install.sh). Without it every write fails with
// EACCES and the page says how to get access.
//
// Stock = the values before motherapp first changed anything this boot, snapshotted to
// $XDG_STATE_HOME/motherapp/cpu-stock.json (keyed by the kernel's boot_id) right before the
// first write. Until then the current values are stock. A profile only names what it changes;
// everything else is put back to stock when it is applied, so switching profiles never leaves
// the previous one's values behind.
//
// cpu.json on Intel has the same top level as on Ryzen (src/settings.ts) with these profiles:
//   "underclock": { "name": "Underclock", "pl1W": 125, "pl2W": 188 },
//   "overclock":  { "name": "Overclock" }
// Fields: maxMHz (clock cap, all cores; the P-cores on a hybrid), eMaxMHz (E-cores, hybrids
// only), turbo (true/false), governor ("performance" / "powersave"), epp (powersave only),
// pl1W, pl2W, undervoltMV (core + cache voltage offset, -150..0 mV in 5 mV steps; stock is
// 0). Absent or null = stock. The underclock defaults are Intel's "Baseline" power
// profile for the i9-13900K (125 W / 188 W); the overclock profile starts empty.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PROFILE_IDS, writeAtomic } from "./settings.ts";
import type { ProfileId } from "./settings.ts";
import { DEFAULT_ROOT, SysReader, parseCpuList } from "./sysfs.ts";
import { UNDERVOLT_RANGE, UNDERVOLT_STEP, VOLTAGE_HELPER, NO_VOLTAGE, saveGuard, loadGuard } from "./voltage.ts";
import type { Guard, Voltage } from "./voltage.ts";

export const LIMIT_KEYS = ["maxMHz", "eMaxMHz", "turbo", "governor", "epp", "pl1W", "pl2W", "undervoltMV"] as const;
export type LimitKey = (typeof LIMIT_KEYS)[number];

export interface Limits {
  maxMHz?: number;
  eMaxMHz?: number;
  turbo?: boolean;
  governor?: string;
  epp?: string;
  pl1W?: number;
  pl2W?: number;
  /** mV, <= 0. */
  undervoltMV?: number;
}

export const GOVERNORS = ["performance", "powersave"];
export const EPPS = ["default", "performance", "balance_performance", "balance_power", "power"];
export const MHZ_RANGE: [number, number] = [400, 7000];
/** RAPL takes up to 4095 W; boards call that "unlimited". */
export const PL_RANGE: [number, number] = [10, 4095];

export const THERMALD =
  "thermald is running: in its adaptive mode it rewrites PL1 every few seconds, so a PL1 set here doesn't stick. Run `motherapp install` and allow it to turn thermald off (`sudo systemctl disable --now thermald`).";

/** thermald is running (found by its /proc/<pid>/comm). It manages PL1 itself. */
export function thermaldRunning(root = DEFAULT_ROOT): boolean {
  const r = new SysReader(root);
  return r
    .list("proc")
    .filter((d) => /^\d+$/.test(d))
    .some((pid) => r.text(`proc/${pid}/comm`) === "thermald");
}

export const NO_ACCESS =
  "motherapp can't change the CPU limits yet: run `motherapp install` in a terminal and allow the \"CPU limits\" step (it asks for sudo once).";

const CPU_DIR = "sys/devices/system/cpu";
const POWERCAP_DIR = "sys/class/powercap";

/** What the hardware offers and what it is set to now. */
export interface LimitsHw {
  hybrid: boolean;
  /** P-cores (all cores when not hybrid) and E-cores. */
  p: number[];
  e: number[];
  current: Limits;
  /** Clock cap ranges in MHz: [highest cpuinfo_min_freq, highest cpuinfo_max_freq] of the group. */
  range: { maxMHz?: [number, number]; eMaxMHz?: [number, number] };
  governors: string[];
  epps: string[];
  /** The files each setting is read from and written to, relative to the root. */
  files: Record<LimitKey, string[]>;
  /** The setting exists and every one of its files is writable by this process. */
  writable: Record<LimitKey, boolean>;
  /** Why the undervolt can't be read or set (no helper, the BIOS refused). */
  voltageProblem?: string;
}

const mhz = (khz: number) => Math.round(khz / 1000);
const W = 1_000_000;

function canWrite(abs: string): boolean {
  try {
    fs.accessSync(abs, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Package RAPL zones (intel-rapl:0, intel-rapl-mmio:0), never their core/uncore subzones. */
function packageZones(r: SysReader): string[] {
  return r
    .list(POWERCAP_DIR)
    .filter((z) => /^intel-rapl(-mmio)?:\d+$/.test(z))
    .sort((a, b) => Number(a.includes("mmio")) - Number(b.includes("mmio")) || a.localeCompare(b, undefined, { numeric: true }))
    .map((z) => `${POWERCAP_DIR}/${z}`)
    .filter((z) => (r.text(`${z}/name`) ?? "").startsWith("package"));
}

/** The power_limit_uw file of the constraint called `name` ("long_term" = PL1, "short_term" = PL2). */
function constraintFile(r: SysReader, zone: string, name: string): string | undefined {
  for (const f of r.list(zone)) {
    const m = /^constraint_(\d+)_name$/.exec(f);
    if (m && r.text(`${zone}/${f}`) === name) return `${zone}/constraint_${m[1]}_power_limit_uw`;
  }
  return undefined;
}

/** `voltage`: the undervolt helper; without it there is no undervolt setting. */
export function readLimits(root = DEFAULT_ROOT, voltage?: Voltage): LimitsHw {
  const r = new SysReader(root);
  const online = parseCpuList(r.text(`${CPU_DIR}/online`) ?? "");
  const cpus = online.filter((c) => r.text(`${CPU_DIR}/cpu${c}/cpufreq/scaling_max_freq`) !== undefined);
  const pmuP = parseCpuList(r.text("sys/devices/cpu_core/cpus") ?? "").filter((c) => cpus.includes(c));
  const pmuE = parseCpuList(r.text("sys/devices/cpu_atom/cpus") ?? "").filter((c) => cpus.includes(c));
  const hybrid = pmuP.length > 0 && pmuE.length > 0;
  const p = hybrid ? pmuP : cpus;
  const e = hybrid ? pmuE : [];
  const cf = (c: number, f: string) => `${CPU_DIR}/cpu${c}/cpufreq/${f}`;

  const files: Record<LimitKey, string[]> = { maxMHz: [], eMaxMHz: [], turbo: [], governor: [], epp: [], pl1W: [], pl2W: [], undervoltMV: [] };
  const current: Limits = {};
  const range: LimitsHw["range"] = {};
  const group = (key: "maxMHz" | "eMaxMHz", list: number[]) => {
    if (!list.length) return;
    files[key] = list.map((c) => cf(c, "scaling_max_freq"));
    const caps = list.map((c) => r.int(cf(c, "scaling_max_freq"))).filter((x): x is number => x !== undefined);
    // The highest cap: favoured cores boost higher, and a cap above a core's own max is clamped by the kernel.
    if (caps.length) current[key] = mhz(Math.max(...caps));
    const lo = Math.max(...list.map((c) => r.int(cf(c, "cpuinfo_min_freq")) ?? 0));
    const hi = Math.max(...list.map((c) => r.int(cf(c, "cpuinfo_max_freq")) ?? 0));
    if (hi > 0) range[key] = [Math.max(MHZ_RANGE[0], mhz(lo)), mhz(hi)];
  };
  group("maxMHz", p);
  group("eMaxMHz", e);

  if (r.text(`${CPU_DIR}/intel_pstate/no_turbo`) !== undefined) {
    files.turbo = [`${CPU_DIR}/intel_pstate/no_turbo`];
    current.turbo = r.text(files.turbo[0]!) === "0";
  } else if (r.text(`${CPU_DIR}/cpufreq/boost`) !== undefined) {
    files.turbo = [`${CPU_DIR}/cpufreq/boost`];
    current.turbo = r.text(files.turbo[0]!) === "1";
  }

  const first = cpus[0];
  const words = (f: string) => (first === undefined ? [] : (r.text(cf(first, f)) ?? "").split(/\s+/).filter(Boolean));
  const governors = words("scaling_available_governors");
  const epps = words("energy_performance_available_preferences");
  if (first !== undefined && r.text(cf(first, "scaling_governor")) !== undefined) {
    files.governor = cpus.map((c) => cf(c, "scaling_governor"));
    current.governor = r.text(cf(first, "scaling_governor"))!;
  }
  if (first !== undefined && r.text(cf(first, "energy_performance_preference")) !== undefined) {
    files.epp = cpus.map((c) => cf(c, "energy_performance_preference"));
    current.epp = r.text(cf(first, "energy_performance_preference"))!;
  }

  for (const [key, name] of [
    ["pl1W", "long_term"],
    ["pl2W", "short_term"],
  ] as const) {
    files[key] = packageZones(r)
      .map((z) => constraintFile(r, z, name))
      .filter((f): f is string => f !== undefined);
    const uw = files[key][0] === undefined ? undefined : r.int(files[key][0]);
    if (uw !== undefined) current[key] = Math.round(uw / W);
  }

  const writable = {} as Record<LimitKey, boolean>;
  for (const k of LIMIT_KEYS) writable[k] = k !== "undervoltMV" && files[k].length > 0 && files[k].every((f) => canWrite(path.join(root, f)));
  const hw: LimitsHw = { hybrid, p, e, current, range, governors, epps, files, writable };

  if (voltage) {
    // Not a file: the helper. Shown (and editable in profiles) even when it isn't set up yet.
    files.undervoltMV = [VOLTAGE_HELPER];
    const v = voltage.state();
    if (v.offsets) {
      current.undervoltMV = v.offsets.core;
      writable.undervoltMV = true;
    }
    if (v.problem) hw.voltageProblem = v.problem;
    else if (v.offsets && v.offsets.cache !== v.offsets.core) hw.voltageProblem = `Undervolt: the cache reads ${v.offsets.cache} mV, the core ${v.offsets.core} mV (they should match).`;
  }
  return hw;
}

/** Settings this CPU has (a file to read them from). */
export const presentKeys = (hw: LimitsHw): LimitKey[] => LIMIT_KEYS.filter((k) => hw.files[k].length > 0);

/** "full" when every present sysfs setting can be written, "none" when none can (the undervolt has its own text). */
export function access(hw: LimitsHw): "full" | "partial" | "none" {
  const keys = presentKeys(hw).filter((k) => k !== "undervoltMV");
  const n = keys.filter((k) => hw.writable[k]).length;
  return keys.length > 0 && n === keys.length ? "full" : n === 0 ? "none" : "partial";
}

// ---- wording ----

export function label(k: LimitKey, hybrid: boolean): string {
  switch (k) {
    case "maxMHz":
      return hybrid ? "P-core clock cap" : "Clock cap";
    case "eMaxMHz":
      return "E-core clock cap";
    case "turbo":
      return "Turbo";
    case "governor":
      return "Governor";
    case "epp":
      return "EPP";
    case "pl1W":
      return "PL1 (long-term power)";
    case "pl2W":
      return "PL2 (short-term power)";
    case "undervoltMV":
      return "Undervolt (core + cache)";
  }
}

export function formatValue(k: LimitKey, v: Limits[LimitKey]): string {
  if (v === undefined) return "stock";
  if (k === "turbo") return v ? "on" : "off";
  if (k === "maxMHz" || k === "eMaxMHz") return `${v} MHz`;
  if (k === "pl1W" || k === "pl2W") return `${v} W`;
  if (k === "undervoltMV") return `${v} mV`;
  return String(v);
}

const short: Record<LimitKey, string> = { maxMHz: "cap", eMaxMHz: "E-core cap", turbo: "turbo", governor: "governor", epp: "EPP", pl1W: "PL1", pl2W: "PL2", undervoltMV: "undervolt" };

/** "PL1 125 W · PL2 188 W · turbo off" (only what is set). */
export function describeLimits(l: Limits, hybrid: boolean): string {
  const parts: string[] = [];
  for (const k of LIMIT_KEYS) {
    if (l[k] === undefined) continue;
    const name = k === "maxMHz" && hybrid ? "P-core cap" : short[k];
    parts.push(`${name} ${formatValue(k, l[k])}`);
  }
  return parts.join(" · ");
}

// ---- validation ----

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const intIn = (v: unknown, [lo, hi]: [number, number]): v is number => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;

/**
 * Reads limit fields from `v` (a profile in cpu.json, or an action's values). null / absent =
 * stock. Bad fields are left out and worded in `problems`.
 */
export function parseLimits(v: Record<string, unknown>, problems: string[], where = ""): Limits {
  const out: Limits = {};
  const bad = (msg: string) => problems.push(`${where}${msg}`);
  for (const k of ["maxMHz", "eMaxMHz"] as const) {
    if (v[k] === undefined || v[k] === null) continue;
    if (intIn(v[k], MHZ_RANGE)) out[k] = v[k];
    else bad(`"${k}" must be null or whole MHz (${MHZ_RANGE[0]}-${MHZ_RANGE[1]})`);
  }
  for (const k of ["pl1W", "pl2W"] as const) {
    if (v[k] === undefined || v[k] === null) continue;
    if (intIn(v[k], PL_RANGE)) out[k] = v[k];
    else bad(`"${k}" must be null or whole watts (${PL_RANGE[0]}-${PL_RANGE[1]})`);
  }
  if (v.undervoltMV !== undefined && v.undervoltMV !== null) {
    if (intIn(v.undervoltMV, UNDERVOLT_RANGE) && v.undervoltMV % UNDERVOLT_STEP === 0) out.undervoltMV = v.undervoltMV;
    else bad(`"undervoltMV" must be null or ${UNDERVOLT_RANGE[0]} to ${UNDERVOLT_RANGE[1]} mV in steps of ${UNDERVOLT_STEP} (never positive)`);
  }
  if (out.pl1W !== undefined && out.pl2W !== undefined && out.pl1W > out.pl2W) {
    bad(`"pl1W" (${out.pl1W} W) can't be above "pl2W" (${out.pl2W} W)`);
    delete out.pl1W;
    delete out.pl2W;
  }
  if (typeof v.turbo === "boolean") out.turbo = v.turbo;
  else if (v.turbo !== undefined && v.turbo !== null) bad('"turbo" must be null, true or false');
  if (typeof v.governor === "string" && GOVERNORS.includes(v.governor)) out.governor = v.governor;
  else if (v.governor !== undefined && v.governor !== null) bad(`"governor" must be null, ${GOVERNORS.map((g) => `"${g}"`).join(" or ")}`);
  if (typeof v.epp === "string" && EPPS.includes(v.epp)) out.epp = v.epp;
  else if (v.epp !== undefined && v.epp !== null) bad(`"epp" must be null or one of ${EPPS.join(", ")}`);
  if (out.governor === "performance" && out.epp !== undefined && out.epp !== "performance") {
    bad(`"epp" ${out.epp} needs the powersave governor (the performance governor always uses EPP performance)`);
    delete out.epp;
  }
  return out;
}

// ---- writing ----

export interface ApplyResult {
  /** "PL1 253 W → 125 W" per changed setting. */
  changed: string[];
  problems: string[];
}

function writeError(e: unknown, file: string, value: string): string {
  const code = (e as NodeJS.ErrnoException).code;
  if (code === "EBUSY") return `The kernel refused ${value} for /${file} right now (busy).`;
  if (code === "EINVAL") return `The kernel refused ${value} for /${file} (not a valid value here).`;
  return `Writing ${value} to /${file} failed: ${(e as Error).message}`;
}

function raw(k: LimitKey, v: NonNullable<Limits[LimitKey]>, file: string): string {
  if (k === "turbo") return file.endsWith("no_turbo") ? (v ? "0" : "1") : v ? "1" : "0";
  if (k === "maxMHz" || k === "eMaxMHz") return String((v as number) * 1000);
  if (k === "pl1W" || k === "pl2W") return String((v as number) * W);
  return String(v);
}

/**
 * Writes the settings in `target` that differ from what the hardware has now, in a safe order
 * (turbo, governor, then EPP, the clock caps, the power limits), then reads them back and
 * reports any that didn't take. Settings the CPU doesn't have are skipped.
 */
export function applyLimits(root: string, target: Limits, hw: LimitsHw = readLimits(root), voltage?: Voltage): ApplyResult {
  const changed: string[] = [];
  const problems: string[] = [];
  const skipped = new Set<LimitKey>();
  const denied: string[] = [];
  // The undervolt last: the other settings never need it.
  const order: LimitKey[] = ["turbo", "governor", "epp", "maxMHz", "eMaxMHz", "pl1W", "pl2W", "undervoltMV"];
  const governor = target.governor ?? hw.current.governor;
  for (const k of order) {
    const want = target[k];
    if (want === undefined || hw.files[k].length === 0 || want === hw.current[k]) continue;
    if (k === "epp" && governor === "performance" && want !== "performance") {
      problems.push(`EPP ${want} needs the powersave governor; left at ${hw.current.epp ?? "?"}.`);
      skipped.add(k);
      continue;
    }
    if (k === "epp" && hw.epps.length && !hw.epps.includes(String(want))) {
      problems.push(`This CPU doesn't offer EPP ${want} (it has ${hw.epps.join(", ")}).`);
      skipped.add(k);
      continue;
    }
    if (k === "governor" && hw.governors.length && !hw.governors.includes(String(want))) {
      problems.push(`The ${want} governor isn't available (there is ${hw.governors.join(", ")}).`);
      skipped.add(k);
      continue;
    }
    if (k === "undervoltMV") {
      const r = voltage?.set(want as number);
      if (!r || r.problem) {
        problems.push(r?.problem ?? NO_VOLTAGE);
        skipped.add(k);
      } else changed.push(`${label(k, hw.hybrid)} ${formatValue(k, hw.current[k])} → ${formatValue(k, want)}`);
      continue;
    }
    for (const f of hw.files[k]) {
      const value = raw(k, want, f);
      try {
        fs.writeFileSync(path.join(root, f), value);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "EACCES" || code === "EPERM") denied.push(label(k, hw.hybrid));
        else problems.push(writeError(e, f, value));
        skipped.add(k);
        break; // one message per setting is enough
      }
    }
    if (!skipped.has(k)) changed.push(`${label(k, hw.hybrid)} ${formatValue(k, hw.current[k])} → ${formatValue(k, want)}`);
  }
  if (denied.length) problems.unshift(`Not allowed to change ${denied.join(", ")}. ${NO_ACCESS}`);
  if (changed.length) {
    const after = readLimits(root, voltage).current;
    for (const k of order) {
      const want = target[k];
      if (want === undefined || hw.files[k].length === 0 || after[k] === want || skipped.has(k)) continue;
      let why = "";
      if ((k === "maxMHz" || k === "eMaxMHz") && after.turbo === false) why = " (turbo is off, which holds the clock at the base frequency)";
      if (k === "pl1W" || k === "pl2W") why = " (the BIOS may lock the power limits)";
      problems.push(`${label(k, hw.hybrid)} reads ${formatValue(k, after[k])} after writing ${formatValue(k, want)}${why}.`);
    }
  }
  return { changed, problems };
}

// ---- stock ----

export interface Stock {
  bootId?: string;
  /** ms since the epoch. */
  takenAt: number;
  values: Limits;
}

export function stockFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "motherapp", "cpu-stock.json");
}

export function bootId(root = DEFAULT_ROOT): string | undefined {
  return new SysReader(root).text("proc/sys/kernel/random/boot_id");
}

/** This boot's snapshot, if one was taken (one from an earlier boot doesn't count). */
export function loadStock(file: string, boot: string | undefined): Stock | undefined {
  try {
    const v: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!isObj(v) || !isObj(v.values) || typeof v.takenAt !== "number") return undefined;
    if (boot !== undefined && v.bootId !== boot) return undefined;
    const values: Limits = {};
    for (const k of LIMIT_KEYS) {
      const x = v.values[k];
      if (typeof x === "number" || typeof x === "boolean" || typeof x === "string") (values as Record<string, unknown>)[k] = x;
    }
    const out: Stock = { takenAt: v.takenAt, values };
    if (typeof v.bootId === "string") out.bootId = v.bootId;
    return out;
  } catch {
    return undefined;
  }
}

/** The snapshot for this boot, taken now from `hw` if there is none yet. */
export function ensureStock(file: string, boot: string | undefined, hw: LimitsHw, now = Date.now()): Stock {
  const have = loadStock(file, boot);
  if (have) return have;
  const s: Stock = { takenAt: now, values: { ...hw.current } };
  if (boot !== undefined) s.bootId = boot;
  writeAtomic(file, JSON.stringify(s, null, 2) + "\n");
  return s;
}

/** What a profile sets on this CPU: stock for everything it doesn't name. */
export function targetOf(stock: Limits, profile: Limits | undefined, hw: LimitsHw): Limits {
  const t: Limits = {};
  for (const k of presentKeys(hw)) {
    // A snapshot taken before the helper was set up has no undervolt: offsets start at 0 every boot.
    const v = profile?.[k] ?? stock[k] ?? (k === "undervoltMV" ? 0 : undefined);
    if (v !== undefined) (t as Record<string, unknown>)[k] = v;
  }
  // A profile that picks performance can't keep a powersave-only EPP from stock.
  if (t.governor === "performance" && profile?.epp === undefined) delete t.epp;
  // Turbo off holds every core at its base clock; stock caps above that can't be met.
  if (t.turbo === false) {
    if (profile?.maxMHz === undefined) delete t.maxMHz;
    if (profile?.eMaxMHz === undefined) delete t.eMaxMHz;
  }
  return t;
}

/** Settings whose current value isn't the target's: "PL1 200 W (profile: 125 W)". */
export function drift(target: Limits, hw: LimitsHw): string[] {
  const out: string[] = [];
  for (const k of presentKeys(hw)) {
    const want = target[k];
    if (want === undefined || hw.current[k] === want || hw.current[k] === undefined) continue;
    if (k === "epp" && hw.current.governor === "performance") continue;
    out.push(`${label(k, hw.hybrid)} ${formatValue(k, hw.current[k])} (wanted ${formatValue(k, want)})`);
  }
  return out;
}

// ---- profiles in cpu.json ----

export interface IntelProfile extends Limits {
  id: ProfileId;
  name: string;
}

export interface IntelSettings {
  version: 1;
  active: ProfileId | null;
  applyOnStart: boolean;
  profiles: IntelProfile[];
}

const NAMES: Record<ProfileId, string> = { underclock: "Underclock", overclock: "Overclock" };

export function defaultIntelSettings(): IntelSettings {
  return {
    version: 1,
    active: null,
    applyOnStart: true,
    profiles: [
      { id: "underclock", name: NAMES.underclock, pl1W: 125, pl2W: 188 },
      { id: "overclock", name: NAMES.overclock },
    ],
  };
}

const emptyIntel = (): IntelSettings => ({ version: 1, active: null, applyOnStart: true, profiles: PROFILE_IDS.map((id) => ({ id, name: NAMES[id] })) });

/** The profile sets something. */
export const hasValues = (p: Limits): boolean => LIMIT_KEYS.some((k) => p[k] !== undefined);

export function parseIntelSettings(raw: unknown): { settings: IntelSettings; problems: string[] } {
  const problems: string[] = [];
  const settings = emptyIntel();
  if (!isObj(raw)) return { settings, problems: ["it isn't a JSON object"] };
  const src = isObj(raw.profiles) ? raw.profiles : {};
  if (raw.profiles !== undefined && !isObj(raw.profiles)) problems.push('"profiles" must be an object with "underclock" and "overclock"');
  settings.profiles = PROFILE_IDS.map((id) => {
    const v = src[id];
    const p: IntelProfile = { id, name: NAMES[id] };
    if (v === undefined || v === null) return p;
    if (!isObj(v)) {
      problems.push(`"${id}" is not an object`);
      return p;
    }
    if (typeof v.name === "string" && v.name.trim() !== "") p.name = v.name.trim();
    return { ...p, ...parseLimits(v, problems, `"${id}": `) };
  });
  for (const k of Object.keys(src)) if (!(PROFILE_IDS as readonly string[]).includes(k)) problems.push(`profile "${k}" ignored: only "underclock" and "overclock" exist`);
  if (raw.active === null || raw.active === undefined) settings.active = null;
  else if (typeof raw.active === "string" && (PROFILE_IDS as readonly string[]).includes(raw.active)) settings.active = raw.active as ProfileId;
  else problems.push(`"active" must be "underclock", "overclock" or null; treated as null`);
  if (typeof raw.applyOnStart === "boolean") settings.applyOnStart = raw.applyOnStart;
  else if (raw.applyOnStart !== undefined) problems.push('"applyOnStart" must be true or false; treated as true');
  return { settings, problems };
}

export function formatIntelSettings(s: IntelSettings): string {
  const profiles: Record<string, unknown> = {};
  for (const { id, ...rest } of s.profiles) profiles[id] = rest;
  return JSON.stringify({ version: s.version, active: s.active, applyOnStart: s.applyOnStart, profiles }, null, 2) + "\n";
}

export interface IntelLoaded {
  settings: IntelSettings;
  created?: boolean;
  /** The file can't be parsed: never written over. */
  broken?: boolean;
  problems: string[];
}

/** Like loadSettings (src/settings.ts), for the Intel shape. */
export function loadIntelSettings(file: string, opts: { create?: boolean } = {}): IntelLoaded {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") return { settings: emptyIntel(), broken: true, problems: [`Can't read ${file}: ${(e as Error).message}`] };
    const settings = defaultIntelSettings();
    if (!opts.create) return { settings, problems: [] };
    try {
      writeAtomic(file, formatIntelSettings(settings));
      return { settings, created: true, problems: [] };
    } catch (w) {
      return { settings, problems: [`Can't create ${file}: ${(w as Error).message}`] };
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { settings: emptyIntel(), broken: true, problems: [`${file} isn't valid JSON (${(e as Error).message}): fix or delete it`] };
  }
  const { settings, problems } = parseIntelSettings(parsed);
  return { settings, problems: problems.map((p) => `${file}: ${p}`) };
}

/** Reads cpu.json, changes it with `edit` and writes it back. Refuses a file it can't parse. */
export function updateIntelSettings(file: string, edit: (s: IntelSettings) => void): IntelSettings {
  const loaded = loadIntelSettings(file);
  if (loaded.broken) throw new Error(loaded.problems.join(" "));
  edit(loaded.settings);
  writeAtomic(file, formatIntelSettings(loaded.settings));
  return loaded.settings;
}

/** Applies profile `id` (null = stock): snapshots stock first if this boot has none. */
export interface UndervoltOpts {
  voltage?: Voltage;
  /** The crash guard (src/voltage.ts guardFile). */
  guardFile?: string;
  /** Leave the undervolt alone (it is blocked by the crash guard): only at start. */
  skipUndervolt?: boolean;
}

/**
 * Applies profile `id` (null = stock): snapshots stock first if this boot has none. A new
 * negative undervolt starts a trial in the crash guard; any other apply that isn't
 * skipUndervolt lifts a block (the user chose again).
 */
export function applyProfile(
  root: string,
  stockPath: string,
  settings: IntelSettings,
  id: ProfileId | null,
  now = Date.now(),
  uv: UndervoltOpts = {},
): ApplyResult & { target: Limits; name: string; trial?: number } {
  const hw = readLimits(root, uv.voltage);
  const boot = bootId(root);
  const stock = ensureStock(stockPath, boot, hw, now);
  const p = id === null ? undefined : settings.profiles.find((x) => x.id === id);
  const target = targetOf(stock.values, p, hw);
  if (uv.skipUndervolt) delete target.undervoltMV;
  let guard: Guard | undefined;
  const want = target.undervoltMV;
  if (uv.guardFile && !uv.skipUndervolt) {
    guard = loadGuard(uv.guardFile);
    delete guard.blocked;
    if (want !== undefined && want !== hw.current.undervoltMV && hw.writable.undervoltMV) {
      // Written before the offset is set: a crash right after it must find it.
      if (want < 0) guard.trial = boot === undefined ? { mV: want, at: now } : { mV: want, bootId: boot, at: now };
      else delete guard.trial;
    }
    saveGuard(uv.guardFile, guard);
  }
  const r = applyLimits(root, target, hw, uv.voltage);
  if (uv.guardFile && guard?.trial && uv.voltage?.state().offsets?.core !== guard.trial.mV) {
    delete guard.trial; // it didn't take: nothing to watch
    saveGuard(uv.guardFile, guard);
  }
  const out: ApplyResult & { target: Limits; name: string; trial?: number } = { ...r, target, name: p?.name ?? "Stock" };
  if (guard?.trial && guard.trial.at === now) out.trial = guard.trial.mV;
  return out;
}

// ---- page state ----

type Row = { order: number; label: string; now?: number | boolean | string; stock?: number | boolean | string; min?: number; max?: number; writable: boolean };

/**
 * `limits` in the page state: one row per setting the CPU has (now, stock, range, writable),
 * access, the choices for governor/EPP, and how the hardware differs from the active profile.
 * State can't hold null: unknown values are absent fields.
 */
export function limitsState(
  hw: LimitsHw,
  stock: Stock | undefined,
  target: Limits | undefined,
  thermald = false,
  guard: Guard = {},
  blockedText?: string,
): Record<string, unknown> {
  const rows: Record<string, Row> = {};
  const stockValues = stock?.values ?? hw.current;
  presentKeys(hw).forEach((k, i) => {
    const r: Row = { order: i, label: label(k, hw.hybrid), writable: hw.writable[k] };
    if (hw.current[k] !== undefined) r.now = hw.current[k];
    const st = stockValues[k] ?? (k === "undervoltMV" ? 0 : undefined); // offsets start at 0 every boot
    if (st !== undefined) r.stock = st;
    const range = k === "maxMHz" || k === "eMaxMHz" ? hw.range[k] : k === "pl1W" || k === "pl2W" ? PL_RANGE : k === "undervoltMV" ? UNDERVOLT_RANGE : undefined;
    if (range) [r.min, r.max] = range;
    rows[k] = r;
  });
  const a = access(hw);
  const out: Record<string, unknown> = { supported: true, hybrid: hw.hybrid, access: a, rows, governors: hw.governors, epps: hw.epps };
  if (a !== "full") out.accessText = NO_ACCESS;
  if (thermald && hw.files.pl1W.length) out.thermaldText = THERMALD;
  if (hw.voltageProblem) out.voltageText = hw.voltageProblem;
  if (guard.trial) out.undervoltTrial = { mV: guard.trial.mV, at: guard.trial.at };
  if (guard.blocked && blockedText) out.undervoltBlocked = blockedText;
  out.stockFrom = stock ? "snapshot" : "now";
  if (stock) out.stockAt = stock.takenAt;
  const d = target ? drift(target, hw) : [];
  if (d.length) out.drift = d;
  return out;
}

/** `profiles` in the page state on Intel: like profilesState (src/model.ts), values under `values`. */
export function intelProfilesState(s: IntelSettings, file: string, problems: string[], hybrid: boolean): Record<string, unknown> {
  const list: Record<string, unknown> = {};
  s.profiles.forEach((p, i) => {
    const values: Record<string, unknown> = {};
    for (const k of LIMIT_KEYS) if (p[k] !== undefined) values[k] = p[k];
    list[p.id] = { order: i, name: p.name, values, detail: hasValues(p) ? describeLimits(p, hybrid) : "nothing set yet (all stock)" };
  });
  const out: Record<string, unknown> = { kind: "limits", applyOnStart: s.applyOnStart, file, list };
  if (s.active !== null) out.active = s.active;
  if (problems.length) out.problems = problems.join(" ");
  return out;
}
