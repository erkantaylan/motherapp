// Turns a sysfs snapshot into what people read: a report (for `cpuctl status --json`), the page
// state (keyed maps for the declarative lists) and the plain-text status. Pure functions.
import type { JsonObject } from "@motherapp/tool-sdk";
import type { Profile, Settings } from "./settings.ts";
import type { Sensor, Snapshot } from "./sysfs.ts";
import { formatCpuList } from "./sysfs.ts";

/** Not readable without root or the ryzen_smu module; a later step adds them. */
export const NOT_AVAILABLE = ["Vcore", "package power (PPT)", "SMU overclocking mode"];
export const NOT_AVAILABLE_TEXT =
  "Not available yet: Vcore, package power (PPT) and the SMU overclocking mode. They need the ryzen_smu kernel module, which a later step adds.";
export const APPLY_NOTE = "Applying profiles isn't available yet.";
export const NOT_SET = "values not set yet";

export interface CcxReport {
  name: string;
  index: number;
  ccd?: number;
  cpus: number[];
  avgMHz?: number;
  maxMHz?: number;
  temp?: { label: string; value: number };
}

export interface CoreReport {
  name: string;
  /** Lowest cpu id of the core: the row key. */
  key: number;
  ccx: string;
  threads: { cpu: number; mhz?: number; rank?: number }[];
  mhz?: number;
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

export function formatTemp(c: number): string {
  return `${Number.isInteger(c) ? c : c.toFixed(1)} °C`;
}

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
  const ccd = s.ccd !== undefined ? `CCD${s.ccd} die` : known[s.label];
  const chip = s.chip === "asusec" ? "ASUS EC" : s.chip;
  return { name: s.label, description: ccd ? `${ccd} (${chip})` : chip };
}

export function buildReport(snap: Snapshot): Report {
  const threads = snap.threads;
  const max = Math.max(...threads.map((t) => t.maxKHz ?? 0));
  const cap = Math.min(...threads.map((t) => t.scalingMaxKHz ?? Infinity));
  const tccd = new Map<number, Sensor>();
  for (const s of snap.sensors) if (s.ccd !== undefined && !tccd.has(s.ccd)) tccd.set(s.ccd, s);

  const ccx: CcxReport[] = snap.ccx.map((g) => {
    const freqs = threads.filter((t) => g.cpus.includes(t.cpu) && t.curKHz !== undefined).map((t) => t.curKHz!);
    const r: CcxReport = { name: ccxName(g.index), index: g.index, cpus: g.cpus };
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
        ccx: ccxName(ts[0]!.ccx),
        threads: ts.map((t) => {
          const o: { cpu: number; mhz?: number; rank?: number } = { cpu: t.cpu };
          if (t.curKHz !== undefined) o.mhz = mhz(t.curKHz);
          if (t.rank !== undefined) o.rank = t.rank;
          return o;
        }),
      };
      const f = ts.filter((t) => t.curKHz !== undefined).map((t) => t.curKHz!);
      if (f.length) r.mhz = mhz(Math.max(...f));
      return r;
    });

  const report: Report = {
    model: snap.model,
    cores: byCore.size,
    threads: threads.length,
    ccx,
    coreList,
    sensors: snap.sensors.map((s) => ({ key: s.key, chip: s.chip, label: s.label, ...describeSensor(s), kind: s.kind, value: s.value, unit: s.kind === "temp" ? "°C" : "RPM" })),
    hidden: snap.hidden,
    problems: snap.problems,
    notAvailable: NOT_AVAILABLE,
  };
  if (snap.driver) report.driver = snap.driver;
  const gov = oneOrMixed(threads.map((t) => t.governor));
  if (gov) report.governor = gov;
  const epp = oneOrMixed(threads.map((t) => t.epp));
  if (epp) report.epp = epp;
  if (snap.boost !== undefined) report.boost = snap.boost;
  if (max > 0) report.maxMHz = mhz(max);
  if (Number.isFinite(cap) && cap < max) report.cappedMHz = mhz(cap);
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

function ccxDetail(c: CcxReport): string {
  const parts: string[] = [];
  if (c.maxMHz !== undefined) parts.push(`max ${c.maxMHz} MHz`);
  if (c.temp) parts.push(`${c.temp.label} ${formatTemp(c.temp.value)}`);
  parts.push(`cpus ${formatCpuList(c.cpus)}`);
  return parts.join(" · ");
}

function coreDetail(c: CoreReport): string {
  const parts = c.threads.map((t) => `cpu ${t.cpu} ${t.mhz !== undefined ? `${t.mhz} MHz` : "?"}`);
  const ranks = distinct(c.threads.map((t) => (t.rank === undefined ? undefined : String(t.rank))));
  if (ranks.length) parts.push(`rank ${ranks.join("/")}`);
  return parts.join(" · ");
}

const fraction = (v: number | undefined, max: number | undefined) => (v !== undefined && max ? Math.min(1, v / max) : 0);

/** The polled part of the page state: `cpu`, `ccx`, `cores`, `sensors`. */
export function polledState(r: Report): JsonObject {
  const ccx: JsonObject = {};
  for (const c of r.ccx) {
    ccx[String(c.index)] = {
      order: c.index,
      name: c.ccd !== undefined ? `${c.name} (CCD${c.ccd})` : c.name,
      value: c.avgMHz !== undefined ? `${c.avgMHz} MHz avg` : "no frequency",
      detail: ccxDetail(c),
      fraction: fraction(c.avgMHz, r.maxMHz),
    };
  }
  const cores: JsonObject = {};
  r.coreList.forEach((c, i) => {
    cores[String(c.key)] = {
      order: i,
      name: `${c.name} · ${c.ccx}`,
      value: c.mhz !== undefined ? `${c.mhz} MHz` : "?",
      detail: coreDetail(c),
      fraction: fraction(c.mhz, r.maxMHz),
    };
  });
  const sensors: JsonObject = {};
  r.sensors.forEach((s, i) => {
    sensors[s.key] = { order: i, name: s.name, detail: s.description, value: s.kind === "temp" ? formatTemp(s.value) : `${s.value} RPM` };
  });
  return { cpu: { model: r.model, summary: summaryLine(r) }, ccx, cores, sensors };
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

export function profilesState(s: Settings, ccxCount?: number): JsonObject {
  const out: JsonObject = {};
  s.profiles.forEach((p, i) => {
    const vcore = p.vcore === null ? (p.ccx === null ? "not set" : "Vcore not set") : formatVcore(p.vcore);
    out[p.id] = { order: i, name: p.id === s.active ? `${p.name} (active)` : p.name, value: vcore, detail: profileDetail(p, ccxCount) };
  });
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
    lines.push(`  ${c.name.padEnd(8)} ${c.ccx.padEnd(5)} ${coreDetail(c)}`);
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
  lines.push("", NOT_AVAILABLE_TEXT);
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
