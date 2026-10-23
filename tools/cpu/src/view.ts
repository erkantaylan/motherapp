// Pure helpers shared by the service (Node) and the custom page (browser). This file must
// import nothing: the browser loads it through a relative `./src/view.ts` import, where bare
// imports don't resolve (docs/extension-contract.md § 6).

export interface ThreadClock {
  cpu: number;
  mhz?: number;
}

export interface RankedCore {
  /** Lowest cpu id of the core (the state key). */
  key: number;
  rank?: number;
}

/** A core's clock: the faster (busier) of its threads. Undefined when none is readable. */
export function coreClock(threads: readonly ThreadClock[]): number | undefined {
  let best: number | undefined;
  for (const t of threads) if (t.mhz !== undefined && (best === undefined || t.mhz > best)) best = t.mhz;
  return best;
}

/** The fastest of `cores` (ties: the first one given). Undefined when no clock is known. */
export function fastestCore<T extends { key: number; mhz?: number }>(cores: readonly T[]): T | undefined {
  let best: T | undefined;
  for (const c of cores) if (c.mhz !== undefined && (best?.mhz === undefined || c.mhz > best.mhz)) best = c;
  return best;
}

/**
 * Core keys by preferred-core rank (amd_pstate_prefcore_ranking), highest first; ties, and
 * cores without a rank (last), keep cpu order.
 */
export function rankOrder(cores: readonly RankedCore[]): number[] {
  return [...cores]
    .sort((a, b) => {
      if (a.rank === undefined || b.rank === undefined) {
        if (a.rank !== b.rank) return a.rank === undefined ? 1 : -1;
        return a.key - b.key;
      }
      return b.rank - a.rank || a.key - b.key;
    })
    .map((c) => c.key);
}

/** key -> 1-based position in rankOrder, only for cores that have a rank. */
export function rankNumbers(cores: readonly RankedCore[]): Map<number, number> {
  const ranked = cores.filter((c) => c.rank !== undefined);
  return new Map(rankOrder(ranked).map((k, i) => [k, i + 1]));
}

/** [0, 1, 2, 12, 13, 14] -> "0-2, 12-14". */
export function formatCpuList(cpus: readonly number[]): string {
  const s = [...cpus].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < s.length; ) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j]! + 1) j++;
    parts.push(j === i ? String(s[i]) : j === i + 1 ? `${s[i]}, ${s[j]}` : `${s[i]}-${s[j]}`);
    i = j + 1;
  }
  return parts.join(", ");
}

export function formatTemp(c: number): string {
  return `${Number.isInteger(c) ? c : c.toFixed(1)} °C`;
}

/** "+25", "−150" (a real minus sign), "±0". */
export function formatDelta(d: number): string {
  const r = Math.round(d);
  return r > 0 ? `+${r}` : r < 0 ? `−${-r}` : "±0";
}

/**
 * 0…1 for the heat map. Idle clocks (near `lo`) stay pale, and most of the scale goes to the
 * top quarter of the range, where boost and the profile targets live (generalises the
 * mockup's 1728 / 4000 / 4780 MHz knees to any lo/hi).
 */
export function heatFraction(mhz: number | undefined, lo: number, hi: number): number {
  if (mhz === undefined || !(hi > lo)) return 0;
  const x = (mhz - lo) / (hi - lo);
  if (x <= 0.025) return 0.06;
  const knee = 0.745;
  if (x < knee) return 0.1 + (x / knee) * 0.32;
  return Math.min(1, 0.45 + ((x - knee) / (1 - knee)) * 0.55);
}

// ---- profiles ----

export type ProfileKey = "stock" | "underclock" | "overclock";

/** A profile as the service publishes it (absent fields = not set yet). */
export interface ProfileView {
  name: string;
  ccx?: number[];
  vcore?: number;
  cinebenchR20?: number;
  powerW?: number;
}

/** The target clock of CCX `index` under a profile; undefined for stock or not set. */
export function targetFor(p: ProfileView | undefined, index: number): number | undefined {
  return p?.ccx?.[index];
}

export const formatVolts = (v: number) => `${v.toFixed(3)} V`;

/** One line about a profile, for the selector. */
export function profileSummary(key: ProfileKey, p: ProfileView | undefined, ctx: { driver?: string; maxMHz?: number } = {}): string {
  if (key === "stock" || !p) {
    const how = ctx.driver ? `${ctx.driver} boosts each core on its own` : "the CPU boosts on its own";
    return `Stock: no profile active, ${how}${ctx.maxMHz ? `, up to ${ctx.maxMHz} MHz` : ""}.`;
  }
  if (!p.ccx && p.vcore === undefined) return `${p.name}: values not set yet.`;
  const parts: string[] = [];
  parts.push(p.ccx ? `${p.ccx.map((f, i) => `CCX${i + 1} ${f}`).join(" · ")} MHz` : "CCX clocks not set yet");
  parts[0] += p.vcore !== undefined ? ` at ${formatVolts(p.vcore)}` : ", Vcore not set yet";
  if (p.cinebenchR20 !== undefined) parts.push(`Cinebench R20 ${p.cinebenchR20}`);
  if (p.powerW !== undefined) parts.push(`${p.powerW} W`);
  return parts.join(" · ");
}

export interface CompareRow {
  label: string;
  /** Display values, "—" when not set. */
  a: string;
  b: string;
  /** Highlight this row in card a / card b. */
  hlA: boolean;
  hlB: boolean;
}

/**
 * Rows for the side-by-side profile cards. When both profiles set a row, rows that differ are
 * highlighted in both. A CCX row a profile sets below that profile's own best CCX is
 * highlighted too, with the offset ("4125 MHz (−125)"), since that's what tuning changed.
 */
export function compareProfiles(a: ProfileView | undefined, b: ProfileView | undefined, ccxCount: number): CompareRow[] {
  const rows: CompareRow[] = [];
  const n = Math.max(ccxCount, a?.ccx?.length ?? 0, b?.ccx?.length ?? 0);
  const ccxCell = (p: ProfileView | undefined, i: number): { text: string; below: boolean } => {
    const f = p?.ccx?.[i];
    if (f === undefined) return { text: "—", below: false };
    const best = Math.max(...p!.ccx!);
    return f < best ? { text: `${f} MHz (${formatDelta(f - best)})`, below: true } : { text: `${f} MHz`, below: false };
  };
  for (let i = 0; i < n; i++) {
    const ca = ccxCell(a, i);
    const cb = ccxCell(b, i);
    const fa = a?.ccx?.[i];
    const fb = b?.ccx?.[i];
    const differ = fa !== undefined && fb !== undefined && fa !== fb;
    rows.push({ label: `CCX${i + 1}`, a: ca.text, b: cb.text, hlA: differ || ca.below, hlB: differ || cb.below });
  }
  const simple = (label: string, va: number | undefined, vb: number | undefined, fmt: (v: number) => string) => {
    const differ = va !== undefined && vb !== undefined && va !== vb;
    rows.push({ label, a: va === undefined ? "—" : fmt(va), b: vb === undefined ? "—" : fmt(vb), hlA: differ, hlB: differ });
  };
  simple("Vcore", a?.vcore, b?.vcore, formatVolts);
  simple("Cinebench R20", a?.cinebenchR20, b?.cinebenchR20, String);
  simple("Power", a?.powerW, b?.powerW, (v) => `${v} W`);
  return rows;
}

// ---- events and the timeline ----

export interface CpuEvent {
  /** ms since the epoch. */
  ts: number;
  text: string;
  /** start | config | boost | cpufreq | problem */
  kind: string;
}

export const EVENTS_CAP = 50;

/** Appends `ev`, keeping the newest `cap` (oldest first). Returns a new array. */
export function pushEvent(list: readonly CpuEvent[], ev: CpuEvent, cap = EVENTS_CAP): CpuEvent[] {
  const out = [...list, ev];
  return out.length > cap ? out.slice(out.length - cap) : out;
}

export interface Sample {
  ts: number;
  /** Fastest core, MHz. */
  mhz?: number;
  /** Package temperature (Tctl), °C. */
  temp?: number;
  /** Package power, W. */
  w?: number;
}

/** Appends a sample and drops those older than `windowMs` before `s.ts`. Mutates `buf`. */
export function pushSample(buf: Sample[], s: Sample, windowMs: number): Sample[] {
  buf.push(s);
  let drop = 0;
  while (drop < buf.length && buf[drop]!.ts < s.ts - windowMs) drop++;
  if (drop) buf.splice(0, drop);
  return buf;
}

/** The sample nearest to `ts`, if one lies within `maxGapMs`. */
export function nearestSample(buf: readonly Sample[], ts: number, maxGapMs: number): Sample | undefined {
  let best: Sample | undefined;
  for (const s of buf) if (!best || Math.abs(s.ts - ts) < Math.abs(best.ts - ts)) best = s;
  return best && Math.abs(best.ts - ts) <= maxGapMs ? best : undefined;
}

/** Axis range around `vals`, at least `minSpan` wide, widened to multiples of `step`. */
export function axisRange(vals: readonly number[], fallback: [number, number], minSpan: number, step: number): [number, number] {
  if (!vals.length) return fallback;
  let lo = Math.min(...vals, fallback[0]);
  let hi = Math.max(...vals, fallback[1]);
  if (hi - lo < minSpan) {
    const m = (hi + lo) / 2;
    lo = m - minSpan / 2;
    hi = m + minSpan / 2;
  }
  return [Math.floor(lo / step) * step, Math.ceil(hi / step) * step];
}

// ---- page layout decisions ----

export interface CcxShape {
  index: number;
  ccd?: number;
  /** Enabled cores. */
  cores: number;
  /** Core slots, enabled or not (>= cores). */
  slots: number;
}

/**
 * The drawn package (two CCD chiplets over the I/O die, each CCX core | L3 | core) applies to
 * exactly 2 CCD × 2 CCX with at most 4 core slots per CCX (a Zen 2 3900X/3950X). Returns the
 * CCX indices per CCD in that case, undefined for anything else (the page draws a grid).
 */
export function dieLayout(ccx: readonly CcxShape[]): { ccd: number; ccx: number[] }[] | undefined {
  if (ccx.length !== 4 || ccx.some((c) => c.ccd === undefined || c.cores < 1 || Math.max(c.slots, c.cores) > 4)) return undefined;
  const by = new Map<number, number[]>();
  for (const c of [...ccx].sort((a, b) => a.index - b.index)) by.set(c.ccd!, [...(by.get(c.ccd!) ?? []), c.index]);
  if (by.size !== 2 || [...by.values()].some((l) => l.length !== 2)) return undefined;
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([ccd, list]) => ({ ccd, ccx: list }));
}

export interface GridCore {
  key: number;
  order: number;
  ccx: number;
  kind?: "P" | "E";
}

export interface GridGroup {
  title: string;
  /** The CCX this group is, when hovering it should show CCX details (AMD). */
  ccx?: number;
  keys: number[];
}

/**
 * Groups for the plain core grid: per CCX on AMD; P-cores / E-cores on an Intel hybrid; per L3
 * group otherwise (one "Cores" group when the whole CPU shares one L3).
 */
export function gridGroups(cores: readonly GridCore[], ccx: readonly { index: number; name: string }[], amd: boolean): GridGroup[] {
  const sorted = [...cores].sort((a, b) => a.order - b.order);
  if (amd) return ccx.map((c) => ({ title: c.name, ccx: c.index, keys: sorted.filter((k) => k.ccx === c.index).map((k) => k.key) }));
  if (sorted.some((k) => k.kind)) {
    return [
      { title: "P-cores", keys: sorted.filter((k) => k.kind === "P").map((k) => k.key) },
      { title: "E-cores", keys: sorted.filter((k) => k.kind === "E").map((k) => k.key) },
      { title: "Other cores", keys: sorted.filter((k) => !k.kind).map((k) => k.key) },
    ].filter((g) => g.keys.length > 0);
  }
  if (ccx.length <= 1) return [{ title: "Cores", keys: sorted.map((k) => k.key) }];
  return ccx.map((c) => ({ title: c.name, keys: sorted.filter((k) => k.ccx === c.index).map((k) => k.key) }));
}
