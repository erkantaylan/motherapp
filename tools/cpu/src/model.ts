// Turns a sysfs snapshot into what people read: a report (for `cpuctl status --json`), the page
// state (raw numbers for the custom page) and the plain-text status. Pure functions.
import type { JsonObject } from "@motherapp/tool-sdk";
import type { Profile, Settings } from "./settings.ts";
import type { Sensor, Snapshot } from "./sysfs.ts";
import { coreClock, fastestCore, formatCpuList, formatTemp } from "./view.ts";

export { formatTemp };

/** Not readable without root or the ryzen_smu module; a later step adds them. */
export const NOT_AVAILABLE = ["Vcore", "package power (PPT)", "SMU overclocking mode"];
export const NOT_AVAILABLE_TEXT =
  "Not available yet: Vcore, package power (PPT) and the SMU overclocking mode. They need the ryzen_smu kernel module, which a later step adds.";
export const APPLY_NOTE = "Applying profiles isn't available yet.";
export const NOT_SET = "values not set yet";
export const AMD_ONLY = "Profiles and per-CCX tuning are for AMD Ryzen (Zen 2) only.";

/** "AMD" / "Intel" from /proc/cpuinfo's vendor_id; undefined for anything else. */
export function vendorName(vendorId: string | undefined): "AMD" | "Intel" | undefined {
  if (vendorId === "AuthenticAMD") return "AMD";
  if (vendorId === "GenuineIntel") return "Intel";
  return undefined;
}

/** The sidebar title (user's call, 2026-10-23): "CPU - AMD", "CPU - Intel", else "CPU". */
export function toolTitle(vendorId: string | undefined): string {
  const v = vendorName(vendorId);
  return v ? `CPU - ${v}` : "CPU";
}

/**
 * Whether the CCX profiles, the per-CCX tuning table and the SMU placeholders apply: AMD family
 * 0x17 (Zen, Zen+, Zen 2, what ClockTuner for Ryzen tunes per CCX). Everything else gets the
 * generic page and no cpu.json.
 */
export function tuningSupported(vendorId: string | undefined, family: number | undefined): boolean {
  return vendorId === "AuthenticAMD" && family === 0x17;
}

export interface CcxReport {
  name: string;
  index: number;
  ccd?: number;
  cpus: number[];
  /** Core keys (lowest cpu of each core), in layout order. */
  cores: number[];
  /**
   * Core slots the CCX has, enabled or not, from the topology/core_id stride (a 3900X CCX:
   * 3 cores, 4 slots). Equals the core count when core_id says nothing more. Which slot is
   * disabled isn't known (Linux numbers the enabled ones only).
   */
  slots: number;
  avgMHz?: number;
  maxMHz?: number;
  /** Key of the fastest core (its busier thread). */
  fastCore?: number;
  temp?: { label: string; value: number };
}

export interface CoreReport {
  name: string;
  /** Lowest cpu id of the core: the row key. */
  key: number;
  ccx: string;
  ccxIndex: number;
  threads: { cpu: number; mhz?: number; rank?: number }[];
  mhz?: number;
  /** Intel hybrid: P- or E-core. */
  kind?: "P" | "E";
  /** Per-core temperature (Intel coretemp "Core N"). */
  temp?: { label: string; value: number };
  /** Best amd_pstate_prefcore_ranking of its threads (siblings normally share one). */
  rank?: number;
}

export interface SensorReport {
  key: string;
  chip: string;
  label: string;
  name: string;
  description: string;
  kind: "temp" | "fan";
  value: number;
  unit: "°C" | "RPM";
}

export interface Report {
  model: string;
  /** "AMD" / "Intel", absent for other vendors. */
  vendor?: "AMD" | "Intel";
  /** See tuningSupported. */
  tuning: boolean;
  cores: number;
  threads: number;
  driver?: string;
  governor?: string;
  epp?: string;
  boost?: boolean;
  /** Highest cpuinfo_max_freq: the most any core may boost to. */
  maxMHz?: number;
  /** Lowest scaling_max_freq, when it is below maxMHz (a user or power-profile cap). */
  cappedMHz?: number;
  /** Lowest normal clock (what idle threads read): the bottom of the heat scale. */
  minMHz?: number;
  /** The package temperature: k10temp Tctl, else Tdie. */
  pkgTemp?: { label: string; value: number };
  ccx: CcxReport[];
  coreList: CoreReport[];
  sensors: SensorReport[];
  hidden: string[];
  problems: string[];
  notAvailable: string[];
}

const mhz = (khz: number) => Math.round(khz / 1000);
const distinct = (xs: (string | undefined)[]) => [...new Set(xs.filter((x): x is string => x !== undefined && x !== ""))];
const oneOrMixed = (xs: (string | undefined)[]) => {
  const d = distinct(xs);
  return d.length ? d.join(" / ") : undefined;
};

export const ccxName = (index: number) => `CCX${index + 1}`;
/** CCX on AMD; on other CPUs just the L3 cache group. */
const groupName = (amd: boolean, index: number) => (amd ? ccxName(index) : `L3 group ${index + 1}`);

function describeSensor(s: Sensor): { name: string; description: string } {
  if (s.kind === "fan") return { name: `${s.label} fan`, description: s.chip === "asusec" ? "ASUS EC" : s.chip };
  const known: Record<string, string> = {
    Tctl: "CPU control temperature, what fans react to",
    Tdie: "CPU die temperature",
    CPU: "CPU socket, board sensor",
    Motherboard: "board sensor",
    Chipset: "X570 chipset",
    T_Sensor: "T_Sensor header",
  };
  if (s.chip === "coretemp") {
    if (/^Package id \d+$/.test(s.label)) return { name: s.label, description: "CPU package (coretemp)" };
    if (s.coreId !== undefined) return { name: s.label, description: `core_id ${s.coreId} (coretemp)` };
  }
  const ccd = s.ccd !== undefined ? `CCD${s.ccd} die` : known[s.label];
  const chip = s.chip === "asusec" ? "ASUS EC" : s.chip;
  return { name: s.label, description: ccd ? `${ccd} (${chip})` : chip };
}

export function buildReport(snap: Snapshot): Report {
  const threads = snap.threads;
  const amd = snap.vendor === "AuthenticAMD";
  const max = Math.max(...threads.map((t) => t.maxKHz ?? 0));
  // A cap is a thread held below its own max (E-cores have a lower max, which isn't a cap).
  const cap = Math.min(...threads.filter((t) => t.scalingMaxKHz !== undefined && t.maxKHz !== undefined && t.scalingMaxKHz < t.maxKHz).map((t) => t.scalingMaxKHz!));
  const tccd = new Map<number, Sensor>();
  for (const s of snap.sensors) if (s.ccd !== undefined && !tccd.has(s.ccd)) tccd.set(s.ccd, s);

  const ccx: CcxReport[] = snap.ccx.map((g) => {
    const freqs = threads.filter((t) => g.cpus.includes(t.cpu) && t.curKHz !== undefined).map((t) => t.curKHz!);
    const r: CcxReport = { name: groupName(amd, g.index), index: g.index, cpus: g.cpus, cores: [], slots: 0 };
    if (g.ccd !== undefined) {
      r.ccd = g.ccd;
      const s = tccd.get(g.ccd);
      if (s) r.temp = { label: s.label, value: s.value };
    }
    if (freqs.length) {
      r.avgMHz = mhz(freqs.reduce((a, b) => a + b, 0) / freqs.length);
      r.maxMHz = mhz(Math.max(...freqs));
    }
    return r;
  });

  const byCore = new Map<number, typeof threads>();
  for (const t of threads) byCore.set(t.core, [...(byCore.get(t.core) ?? []), t]);
  const coreList: CoreReport[] = [...byCore.entries()]
    .sort((a, b) => a[1][0]!.ccx - b[1][0]!.ccx || a[0] - b[0])
    .map(([key, ts], i) => {
      const r: CoreReport = {
        name: `Core ${i + 1}`,
        key,
        ccx: groupName(amd, ts[0]!.ccx),
        ccxIndex: ts[0]!.ccx,
        threads: ts.map((t) => {
          const o: { cpu: number; mhz?: number; rank?: number } = { cpu: t.cpu };
          if (t.curKHz !== undefined) o.mhz = mhz(t.curKHz);
          if (t.rank !== undefined) o.rank = t.rank;
          return o;
        }),
      };
      const clock = coreClock(r.threads);
      if (clock !== undefined) r.mhz = clock;
      const ranks = ts.filter((t) => t.rank !== undefined).map((t) => t.rank!);
      if (ranks.length) r.rank = Math.max(...ranks);
      if (ts[0]!.kind) r.kind = ts[0]!.kind;
      const id = ts[0]!.coreId;
      const ct = id === undefined ? undefined : snap.sensors.find((x) => x.chip === "coretemp" && x.coreId === id);
      if (ct) r.temp = { label: ct.label, value: ct.value };
      return r;
    });

  // Cores per CCX, the fastest one, and the slot count from the core_id stride.
  const firstId = new Map<number, number>();
  for (const c of ccx) {
    const cs = coreList.filter((k) => k.ccxIndex === c.index);
    c.cores = cs.map((k) => k.key);
    const fast = fastestCore(cs);
    if (fast) c.fastCore = fast.key;
    const ids = threads.filter((t) => c.cpus.includes(t.cpu) && t.coreId !== undefined).map((t) => t.coreId!);
    if (ids.length) firstId.set(c.index, Math.min(...ids));
    c.slots = Math.max(cs.length, ids.length ? Math.max(...ids) - Math.min(...ids) + 1 : 0);
  }
  const strides: number[] = [];
  for (let i = 0; i + 1 < ccx.length; i++) {
    const a = firstId.get(ccx[i]!.index);
    const b = firstId.get(ccx[i + 1]!.index);
    strides.push(a !== undefined && b !== undefined ? b - a : 0);
  }
  ccx.forEach((c, i) => {
    const stride = strides[i] ?? strides[i - 1] ?? 0;
    // A stride is believable when it leaves room for this CCX's cores and at most as many again.
    if (stride >= c.cores.length && stride <= 2 * c.cores.length) c.slots = Math.max(c.slots, stride);
  });

  const report: Report = {
    model: snap.model,
    tuning: tuningSupported(snap.vendor, snap.family),
    cores: byCore.size,
    threads: threads.length,
    ccx,
    coreList,
    sensors: snap.sensors.map((s) => ({ key: s.key, chip: s.chip, label: s.label, ...describeSensor(s), kind: s.kind, value: s.value, unit: s.kind === "temp" ? "°C" : "RPM" })),
    hidden: snap.hidden,
    problems: snap.problems,
    notAvailable: tuningSupported(snap.vendor, snap.family) ? NOT_AVAILABLE : [],
  };
  const vendor = vendorName(snap.vendor);
  if (vendor) report.vendor = vendor;
  if (snap.driver) report.driver = snap.driver;
  const gov = oneOrMixed(threads.map((t) => t.governor));
  if (gov) report.governor = gov;
  const epp = oneOrMixed(threads.map((t) => t.epp));
  if (epp) report.epp = epp;
  if (snap.boost !== undefined) report.boost = snap.boost;
  if (max > 0) report.maxMHz = mhz(max);
  if (Number.isFinite(cap)) report.cappedMHz = mhz(cap);
  const mins = threads.filter((t) => t.minKHz !== undefined).map((t) => t.minKHz!);
  if (mins.length) report.minMHz = mhz(Math.min(...mins));
  const pkg =
    snap.sensors.find((s) => s.kind === "temp" && (s.chip === "k10temp" || s.chip === "zenpower") && (s.label === "Tctl" || s.label === "Tdie")) ??
    snap.sensors.find((s) => s.kind === "temp" && s.chip === "coretemp" && /^Package id \d+$/.test(s.label));
  if (pkg) report.pkgTemp = { label: pkg.label, value: pkg.value };
  return report;
}

/** "12 cores / 24 threads · amd-pstate-epp · governor performance · EPP performance · boost on, up to 4780 MHz" */
export function summaryLine(r: Report): string {
  const parts = [`${r.cores} cores / ${r.threads} threads`];
  if (r.driver) parts.push(r.driver);
  if (r.governor) parts.push(`governor ${r.governor}`);
  if (r.epp) parts.push(`EPP ${r.epp}`);
  const boost = r.boost === undefined ? "boost unknown" : r.boost ? "boost on" : "boost off";
  parts.push(r.maxMHz ? `${boost}, up to ${r.maxMHz} MHz` : boost);
  if (r.cappedMHz) parts.push(`capped at ${r.cappedMHz} MHz`);
  return parts.join(" · ");
}

function coreDetail(c: CoreReport): string {
  const parts = c.threads.map((t) => `cpu ${t.cpu} ${t.mhz !== undefined ? `${t.mhz} MHz` : "?"}`);
  const ranks = distinct(c.threads.map((t) => (t.rank === undefined ? undefined : String(t.rank))));
  if (ranks.length) parts.push(`rank ${ranks.join("/")}`);
  if (c.temp) parts.push(formatTemp(c.temp.value));
  return parts.join(" · ");
}

/**
 * The polled part of the page state: `cpu`, `ccx`, `cores`, `sensors`, as raw numbers the custom
 * page formats itself. State never stores null, so "unknown" is an absent field.
 */
export function polledState(r: Report): JsonObject {
  const ccx: JsonObject = {};
  for (const c of r.ccx) {
    const o: JsonObject = { index: c.index, name: c.name, cpus: c.cpus, cores: c.cores, slots: c.slots };
    if (c.ccd !== undefined) o.ccd = c.ccd;
    if (c.avgMHz !== undefined) o.avgMHz = c.avgMHz;
    if (c.maxMHz !== undefined) o.maxMHz = c.maxMHz;
    if (c.fastCore !== undefined) o.fastCore = c.fastCore;
    if (c.temp) o.temp = { ...c.temp };
    ccx[String(c.index)] = o;
  }
  const cores: JsonObject = {};
  r.coreList.forEach((c, i) => {
    const o: JsonObject = {
      order: i,
      name: c.name,
      ccx: c.ccxIndex,
      threads: c.threads.map((t): JsonObject => (t.mhz !== undefined ? { cpu: t.cpu, mhz: t.mhz } : { cpu: t.cpu })),
    };
    if (c.mhz !== undefined) o.mhz = c.mhz;
    if (c.rank !== undefined) o.rank = c.rank;
    if (c.kind) o.kind = c.kind;
    if (c.temp) o.temp = { ...c.temp };
    cores[String(c.key)] = o;
  });
  const sensors: JsonObject = {};
  r.sensors.forEach((s, i) => {
    sensors[s.key] = { order: i, chip: s.chip, label: s.label, name: s.name, description: s.description, kind: s.kind, value: s.value, unit: s.unit };
  });
  const cpu: JsonObject = { model: r.model, summary: summaryLine(r), cores: r.cores, threads: r.threads, tuning: r.tuning };
  for (const k of ["vendor", "driver", "governor", "epp", "boost", "maxMHz", "cappedMHz", "minMHz"] as const) {
    const v = r[k];
    if (v !== undefined) cpu[k] = v;
  }
  if (r.pkgTemp) cpu.pkgTemp = { ...r.pkgTemp };
  if (r.hidden.length) cpu.hidden = [...r.hidden];
  return { cpu, ccx, cores, sensors };
}

export function profileDetail(p: Profile, ccxCount?: number): string {
  if (p.ccx === null && p.vcore === null) return NOT_SET;
  const parts = [p.ccx === null ? "CCX frequencies not set yet" : p.ccx.map((f, i) => `${ccxName(i)} ${f}`).join(" · ") + " MHz"];
  if (p.vcore === null) parts.push("Vcore not set yet");
  if (p.cinebenchR20 !== undefined) parts.push(`Cinebench R20 ${p.cinebenchR20}`);
  if (p.powerW !== undefined) parts.push(`${p.powerW} W`);
  if (ccxCount && p.ccx !== null && p.ccx.length !== ccxCount) parts.push(`${p.ccx.length} CCX values, this CPU has ${ccxCount}`);
  return parts.join(" · ");
}

export const formatVcore = (v: number | null) => (v === null ? "not set" : `${v.toFixed(3)} V`);

/** "Active profile: Overclock (CTR), re-applied when the tool starts." */
export function activeLine(s: Settings): string {
  const p = s.profiles.find((x) => x.id === s.active);
  if (!p) return "Active profile: none (stock settings, nothing applied).";
  return `Active profile: ${p.name}${s.applyOnStart ? ", re-applied when the tool starts" : ", not re-applied on start"}.`;
}

/**
 * `profiles` in the page state: `{ active?, applyOnStart, file, list: { underclock, overclock },
 * problems? }`. `active` absent = stock (cpu.json's `active: null`); a profile's unset values
 * (null in the file) are absent fields, so the page never shows an invented number.
 */
export function profilesState(s: Settings, file: string, problems: string[], ccxCount?: number): JsonObject {
  const list: JsonObject = {};
  s.profiles.forEach((p, i) => {
    const o: JsonObject = { order: i, name: p.name, detail: profileDetail(p, ccxCount) };
    if (p.ccx !== null) o.ccx = [...p.ccx];
    if (p.vcore !== null) o.vcore = p.vcore;
    if (p.cinebenchR20 !== undefined) o.cinebenchR20 = p.cinebenchR20;
    if (p.powerW !== undefined) o.powerW = p.powerW;
    list[p.id] = o;
  });
  const out: JsonObject = { applyOnStart: s.applyOnStart, file, list };
  if (s.active !== null) out.active = s.active;
  if (problems.length) out.problems = problems.join(" ");
  return out;
}

/** The text `cpuctl status` prints. */
export function formatStatus(r: Report): string {
  const lines = [r.model, summaryLine(r), ""];
  for (const p of r.problems) lines.push(`! ${p}`);
  if (r.problems.length) lines.push("");
  for (const c of r.ccx) {
    const name = c.ccd !== undefined ? `${c.name} (CCD${c.ccd})` : c.name;
    const freq = c.avgMHz !== undefined ? `avg ${String(c.avgMHz).padStart(4)} MHz  max ${String(c.maxMHz).padStart(4)} MHz` : "no frequency";
    const temp = c.temp ? `  ${c.temp.label} ${formatTemp(c.temp.value)}` : "";
    lines.push(`${name.padEnd(12)}  ${freq}${temp}  cpus ${formatCpuList(c.cpus)}`);
  }
  lines.push("", "Cores");
  for (const c of r.coreList) {
    const group = c.kind ? `${c.kind}-core` : c.ccx;
    lines.push(`  ${c.name.padEnd(8)} ${group.padEnd(5)} ${coreDetail(c)}`);
  }
  if (r.sensors.length) {
    lines.push("", "Sensors");
    const w = Math.max(...r.sensors.map((s) => s.name.length));
    for (const s of r.sensors) {
      const v = s.kind === "temp" ? formatTemp(s.value) : `${s.value} RPM`;
      lines.push(`  ${s.name.padEnd(w)}  ${v.padStart(9)}  ${s.description}`);
    }
  }
  for (const h of r.hidden) lines.push(`  hidden: ${h}`);
  lines.push("", r.tuning ? NOT_AVAILABLE_TEXT : AMD_ONLY);
  return lines.join("\n");
}

export function formatProfiles(file: string, s: Settings, problems: string[], ccxCount?: number): string {
  const lines = [`Saved profiles (reference), from ${file}:`, ""];
  for (const p of problems) lines.push(`! ${p}`);
  if (problems.length) lines.push("");
  for (const p of s.profiles) {
    lines.push(`${p.id.padEnd(10)}  ${p.name}${p.id === s.active ? "  (active)" : ""}`);
    if (p.ccx === null && p.vcore === null) {
      lines.push(`    ${NOT_SET}`, "");
      continue;
    }
    lines.push(`    ${p.ccx === null ? "CCX frequencies not set yet" : p.ccx.map((f, i) => `${ccxName(i)} ${f} MHz`).join("  ")}`);
    const extra = [`Vcore ${formatVcore(p.vcore)}`];
    if (p.cinebenchR20 !== undefined) extra.push(`Cinebench R20 ${p.cinebenchR20}`);
    if (p.powerW !== undefined) extra.push(`${p.powerW} W`);
    lines.push(`    ${extra.join(" · ")}`);
    if (ccxCount && p.ccx !== null && p.ccx.length !== ccxCount) lines.push(`    ${p.ccx.length} CCX values, this CPU has ${ccxCount}`);
    lines.push("");
  }
  lines.push(activeLine(s), APPLY_NOTE);
  return lines.join("\n");
}
