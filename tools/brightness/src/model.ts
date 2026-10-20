// Pure helpers: stable monitor keys, titles, percent conversion, value specs ("50", "+10",
// "-5") and matching a monitor from a command-line word ("DP-1", "1", "msi", a key).
import type { MonitorInfo } from "./backend.ts";

/** The state entry of one monitor (`monitors.<key>`). */
export interface MonitorEntry {
  title: string;
  subtitle: string;
  bus: number;
  connector?: string;
  mfg: string;
  model: string;
  serial: string;
  /** Found on the last detection. */
  present: boolean;
  /** Why the row needs attention, e.g. "no answer over DDC/CI…". Absent when fine. */
  note?: string;
  /** Percent 0–100. Absent until first read. */
  brightness?: number;
}

const clean = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");

/**
 * A state key that stays the same across restarts and bus renumbering: manufacturer, model and
 * EDID serial. Without a serial the bus stands in. Never contains "." (state paths).
 */
export function keyFor(info: MonitorInfo): string {
  const parts = [info.mfg, info.model, info.serial || `i2c${info.bus}`].map(clean).filter(Boolean);
  return parts.length > 0 ? parts.join("-") : `i2c${info.bus}`;
}

/** Keys for one detection, made unique by appending the bus where two monitors collide. */
export function keysFor(found: MonitorInfo[]): string[] {
  const keys = found.map(keyFor);
  return keys.map((k, i) => (keys.indexOf(k) !== keys.lastIndexOf(k) ? `${k}-i2c${found[i]!.bus}` : k));
}

export function titleFor(info: MonitorInfo): string {
  if (info.model) return info.model;
  if (info.mfg) return `${info.mfg} monitor`;
  return `Monitor on i2c-${info.bus}`;
}

export function subtitleFor(info: Pick<MonitorInfo, "bus" | "connector">, note?: string): string {
  return [info.connector ?? `/dev/i2c-${info.bus}`, note].filter(Boolean).join(" · ");
}

export function toPercent(current: number, max: number): number {
  if (!(max > 0)) return Math.max(0, Math.min(100, current));
  return Math.max(0, Math.min(100, Math.round((current * 100) / max)));
}

export function toRaw(percent: number, max: number): number {
  if (!(max > 0)) return Math.round(percent);
  return Math.round((percent * max) / 100);
}

export function clampPercent(v: number): number {
  return Math.max(0, Math.min(100, Math.round(v)));
}

export type ValueSpec = { kind: "absolute"; value: number } | { kind: "relative"; delta: number };

/** "50", "50%", "+10", "-5%". Throws a message for anything else. */
export function parseValueSpec(s: string): ValueSpec {
  const m = s.trim().match(/^([+-]?)(\d{1,3})%?$/);
  if (!m) throw new Error(`brightness must be 0-100, +N or -N (got "${s}")`);
  const n = Number(m[2]);
  if (m[1] === "+") return { kind: "relative", delta: n };
  if (m[1] === "-") return { kind: "relative", delta: -n };
  if (n > 100) throw new Error(`brightness must be 0-100 (got ${n})`);
  return { kind: "absolute", value: n };
}

export function applySpec(spec: ValueSpec, current: number | undefined): number {
  if (spec.kind === "absolute") return spec.value;
  return clampPercent((current ?? 50) + spec.delta);
}

export interface Matchable {
  key: string;
  title: string;
  bus: number;
  connector?: string;
  mfg: string;
  model: string;
}

/**
 * Finds the monitor a word names: its key, connector ("DP-1"), bus ("3", "i2c-3",
 * "/dev/i2c-3"), or a unique case-insensitive part of the model or manufacturer.
 */
export function matchMonitor<T extends Matchable>(list: T[], word: string): T {
  const w = word.trim();
  const lower = w.toLowerCase();
  const exact = list.find((m) => m.key === w);
  if (exact) return exact;
  const byConnector = list.filter((m) => m.connector?.toLowerCase() === lower);
  if (byConnector.length === 1) return byConnector[0]!;
  const bus = lower.match(/^(?:\/dev\/)?(?:i2c-)?(\d+)$/)?.[1];
  if (bus !== undefined) {
    const byBus = list.filter((m) => m.bus === Number(bus));
    if (byBus.length === 1) return byBus[0]!;
  }
  const byName = list.filter((m) => `${m.mfg} ${m.model} ${m.title}`.toLowerCase().includes(lower));
  if (byName.length === 1) return byName[0]!;
  const names = list.map((m) => `${m.title} (${m.connector ?? `i2c-${m.bus}`})`).join(", ") || "none";
  if (byName.length > 1) throw new Error(`"${word}" matches more than one monitor: ${byName.map((m) => m.title).join(", ")}`);
  throw new Error(`no monitor matches "${word}" (monitors: ${names})`);
}
