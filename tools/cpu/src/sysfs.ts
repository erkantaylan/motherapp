// Reads the CPU's live numbers from sysfs and /proc: topology (CCX from the L3 cache groups),
// per-thread frequencies and amd-pstate settings, and the k10temp / asusec hwmon sensors.
// Read-only: nothing here ever writes. Everything is read under `root` ("/" on the machine, a
// fixture tree in tests), so no test depends on the hardware it runs on.
import * as fs from "node:fs";
import * as path from "node:path";

export const DEFAULT_ROOT = "/";

/** hwmon chips shown on the page, matched by their `name` file (hwmonN numbers change across boots). */
export const SENSOR_CHIPS = ["k10temp", "zenpower", "asusec"] as const;

/** A temperature at or below this is a header with nothing plugged in (asusec's T_Sensor reads -40 °C). */
export const DISCONNECTED_C = -40;

export interface Thread {
  cpu: number;
  /** Lowest cpu id among this thread's SMT siblings: the physical core's key. */
  core: number;
  /** Index into `Snapshot.ccx`. */
  ccx: number;
  curKHz?: number;
  maxKHz?: number;
  scalingMaxKHz?: number;
  governor?: string;
  epp?: string;
  /** amd_pstate_prefcore_ranking: higher means a better core. */
  rank?: number;
}

export interface Ccx {
  /** 0-based position, ordered by lowest cpu id. Shown 1-based ("CCX1"), as CTR does. */
  index: number;
  /** 0-based CCD ("CCD0"), when the CPU family says how CCXs map to CCDs. */
  ccd?: number;
  cpus: number[];
}

export interface Sensor {
  /** State key: `<chip>-<file prefix>`, e.g. `k10temp-temp3`. No dots. */
  key: string;
  chip: string;
  label: string;
  kind: "temp" | "fan";
  /** °C for temperatures, RPM for fans. */
  value: number;
  /** For k10temp's TccdN: the CCD it measures (N - 1). */
  ccd?: number;
}

export interface Snapshot {
  model: string;
  vendor?: string;
  family?: number;
  driver?: string;
  boost?: boolean;
  threads: Thread[];
  ccx: Ccx[];
  sensors: Sensor[];
  /** Sensors left out on purpose, e.g. "asusec T_Sensor (reads -40 °C: nothing plugged in)". */
  hidden: string[];
  /** Things that couldn't be read, worded for the page. */
  problems: string[];
}

/** "0-2,12-14" -> [0, 1, 2, 12, 13, 14]. Junk parts are skipped. */
export function parseCpuList(s: string): number[] {
  const out: number[] = [];
  for (const part of s.trim().split(",")) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    for (let i = a; i <= b && i - a < 4096; i++) out.push(i);
  }
  return [...new Set(out)].sort((x, y) => x - y);
}

/** [0, 1, 2, 12, 13, 14] -> "0-2, 12-14". */
export function formatCpuList(cpus: number[]): string {
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

/**
 * How many CCXs share one CCD. Zen, Zen+ and Zen 2 (family 0x17) have two 4-core CCXs per CCD;
 * from Zen 3 (family 0x19 and later) a CCD is one CCX. Unknown for other vendors.
 */
export function ccxPerCcd(vendor: string | undefined, family: number | undefined): number | undefined {
  if (vendor !== "AuthenticAMD" || family === undefined) return undefined;
  if (family === 0x17) return 2;
  if (family >= 0x19) return 1;
  return undefined;
}

export class SysReader {
  readonly root: string;
  constructor(root = DEFAULT_ROOT) {
    this.root = root;
  }

  text(p: string): string | undefined {
    try {
      return fs.readFileSync(path.join(this.root, p), "utf8").trim();
    } catch {
      return undefined;
    }
  }

  int(p: string): number | undefined {
    const t = this.text(p);
    if (t === undefined || !/^-?\d+$/.test(t)) return undefined;
    return Number(t);
  }

  list(p: string): string[] {
    try {
      return fs.readdirSync(path.join(this.root, p));
    } catch {
      return [];
    }
  }
}

const CPU_DIR = "sys/devices/system/cpu";
const HWMON_DIR = "sys/class/hwmon";

function readCpuinfo(r: SysReader): { model: string; vendor?: string; family?: number } {
  const info = r.text("proc/cpuinfo") ?? "";
  const field = (name: string) => new RegExp(`^${name}\\s*:\\s*(.*)$`, "m").exec(info)?.[1]?.trim();
  const fam = field("cpu family");
  const vendor = field("vendor_id");
  const out: { model: string; vendor?: string; family?: number } = { model: field("model name") ?? "Unknown CPU" };
  if (vendor) out.vendor = vendor;
  if (fam && /^\d+$/.test(fam)) out.family = Number(fam);
  return out;
}

function onlineCpus(r: SysReader): number[] {
  const online = r.text(`${CPU_DIR}/online`);
  if (online !== undefined) {
    const l = parseCpuList(online);
    if (l.length) return l;
  }
  return r
    .list(CPU_DIR)
    .map((n) => /^cpu(\d+)$/.exec(n)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number)
    .sort((a, b) => a - b);
}

function readSensors(r: SysReader, hidden: string[]): Sensor[] {
  const chips = r
    .list(HWMON_DIR)
    .filter((d) => /^hwmon\d+$/.test(d))
    .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)))
    .map((dir) => ({ dir, name: r.text(`${HWMON_DIR}/${dir}/name`) ?? "" }))
    .filter((c) => (SENSOR_CHIPS as readonly string[]).includes(c.name))
    .sort((a, b) => SENSOR_CHIPS.indexOf(a.name as never) - SENSOR_CHIPS.indexOf(b.name as never));
  const seen = new Map<string, number>();
  const out: Sensor[] = [];
  for (const { dir, name } of chips) {
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    const chipKey = n === 1 ? name : `${name}${n}`;
    const files = r.list(`${HWMON_DIR}/${dir}`);
    const inputs = files
      .map((f) => /^(temp|fan)(\d+)_input$/.exec(f))
      .filter((m): m is RegExpExecArray => m !== null)
      .sort((a, b) => (a[1] === b[1] ? Number(a[2]) - Number(b[2]) : a[1] === "temp" ? -1 : 1));
    for (const m of inputs) {
      const kind = m[1] as "temp" | "fan";
      const prefix = `${kind}${m[2]}`;
      const raw = r.int(`${HWMON_DIR}/${dir}/${prefix}_input`);
      if (raw === undefined) continue; // EIO / ENODATA: the sensor isn't there right now
      const label = r.text(`${HWMON_DIR}/${dir}/${prefix}_label`) || prefix;
      const value = kind === "temp" ? raw / 1000 : raw;
      if (kind === "temp" && value <= DISCONNECTED_C) {
        hidden.push(`${name} ${label} (reads ${value} °C: nothing plugged in)`);
        continue;
      }
      const s: Sensor = { key: `${chipKey}-${prefix}`, chip: name, label, kind, value };
      const ccd = /^Tccd(\d+)$/.exec(label);
      if (kind === "temp" && ccd && (name === "k10temp" || name === "zenpower")) s.ccd = Number(ccd[1]) - 1;
      out.push(s);
    }
  }
  return out;
}

/** One fresh read of everything the page and `cpuctl status` show. Never throws for missing files. */
export function readSnapshot(root = DEFAULT_ROOT): Snapshot {
  const r = new SysReader(root);
  const problems: string[] = [];
  const hidden: string[] = [];
  const { model, vendor, family } = readCpuinfo(r);
  const cpus = onlineCpus(r);
  if (cpus.length === 0) problems.push(`Can't list the CPUs under ${path.join(root, CPU_DIR)}.`);

  // CCX = the CPUs sharing one L3 cache. Without cache info, one group for the whole CPU.
  const groups = new Map<string, number[]>();
  for (const cpu of cpus) {
    const l3 = r.text(`${CPU_DIR}/cpu${cpu}/cache/index3/shared_cpu_list`);
    const members = l3 ? parseCpuList(l3).filter((c) => cpus.includes(c)) : [];
    const key = members.length ? members.join(",") : "all";
    if (!groups.has(key)) groups.set(key, members.length ? members : []);
    if (!members.length) groups.get(key)!.push(cpu);
  }
  const perCcd = ccxPerCcd(vendor, family);
  const ccx: Ccx[] = [...groups.values()]
    .sort((a, b) => Math.min(...a) - Math.min(...b))
    .map((members, index) => (perCcd ? { index, ccd: Math.floor(index / perCcd), cpus: members } : { index, cpus: members }));
  const ccxOf = new Map<number, number>();
  for (const g of ccx) for (const c of g.cpus) ccxOf.set(c, g.index);

  const threads: Thread[] = [];
  let driver: string | undefined;
  for (const cpu of cpus) {
    const base = `${CPU_DIR}/cpu${cpu}`;
    const sib = r.text(`${base}/topology/thread_siblings_list`);
    const siblings = sib ? parseCpuList(sib) : [];
    const t: Thread = { cpu, core: siblings.length ? siblings[0]! : cpu, ccx: ccxOf.get(cpu) ?? 0 };
    const set = <K extends keyof Thread>(k: K, v: Thread[K] | undefined) => {
      if (v !== undefined) t[k] = v;
    };
    set("curKHz", r.int(`${base}/cpufreq/scaling_cur_freq`));
    set("maxKHz", r.int(`${base}/cpufreq/cpuinfo_max_freq`));
    set("scalingMaxKHz", r.int(`${base}/cpufreq/scaling_max_freq`));
    set("governor", r.text(`${base}/cpufreq/scaling_governor`));
    set("epp", r.text(`${base}/cpufreq/energy_performance_preference`));
    set("rank", r.int(`${base}/cpufreq/amd_pstate_prefcore_ranking`));
    driver ??= r.text(`${base}/cpufreq/scaling_driver`);
    threads.push(t);
  }
  if (cpus.length && !threads.some((t) => t.curKHz !== undefined)) {
    problems.push(`No CPU frequencies under ${path.join(root, CPU_DIR)}/cpu*/cpufreq (is a cpufreq driver loaded?).`);
  }

  // Global boost switch (acpi-cpufreq, amd-pstate passive); amd-pstate-epp also has one per policy.
  const boostText = r.text(`${CPU_DIR}/cpufreq/boost`) ?? (cpus.length ? r.text(`${CPU_DIR}/cpu${cpus[0]}/cpufreq/boost`) : undefined);
  const snap: Snapshot = { model, threads, ccx, sensors: readSensors(r, hidden), hidden, problems };
  if (vendor) snap.vendor = vendor;
  if (family !== undefined) snap.family = family;
  if (driver) snap.driver = driver;
  if (boostText === "1" || boostText === "0") snap.boost = boostText === "1";
  return snap;
}
