// Fixture trees: a fake `/sys` + `/proc` under a temp dir, shaped like the user's Ryzen 9 3900X
// (read on the machine 2026-10-22: 4 CCX of 3 cores, SMT siblings n and n+12, amd-pstate-epp,
// k10temp Tctl/Tccd1/Tccd2, asusec with T_Sensor at -40 °C). Tests never read the real /sys.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface HwmonSpec {
  name: string;
  /** file name -> content, e.g. { temp1_input: "56250", temp1_label: "Tctl" } */
  files: Record<string, string>;
}

export interface MachineSpec {
  model: string;
  vendor: string;
  family: number;
  /** CPU ids per CCX (L3 group). */
  ccx: number[][];
  /** SMT sibling list per cpu (all cpus). */
  siblings: (cpu: number) => number[];
  /** kHz per cpu; undefined = no cpufreq dir for it. */
  freqKHz?: (cpu: number) => number | undefined;
  maxKHz: number;
  /** Per-cpu cpuinfo_max_freq, when cores differ (Intel P-/E-cores). */
  maxKHzOf?: (cpu: number) => number;
  scalingMaxKHz?: number;
  /** amd_pstate_lowest_nonlinear_freq; absent = not written. */
  lowestNonlinearKHz?: number;
  /** cpuinfo_min_freq; absent = not written. */
  minKHz?: number;
  /** topology/core_id per cpu; absent = not written. */
  coreId?: (cpu: number) => number;
  /** intel_pstate/no_turbo ("1" = boost off); absent = not written. */
  noTurbo?: "0" | "1";
  /** Intel hybrid: cpu lists for /sys/devices/cpu_core/cpus and cpu_atom/cpus. */
  pmu?: { core: number[]; atom: number[] };
  driver: string;
  governor: string;
  epp: string;
  /** Global boost file; null = absent. */
  boost: "0" | "1" | null;
  rank?: (cpu: number) => number;
  hwmon: HwmonSpec[];
  /** Extra hwmon dirs before the interesting ones, so their numbers don't match the machine's. */
  hwmonOffset?: number;
  /** RAPL package zone intel-rapl:0 (plus a core subzone, and intel-rapl-mmio:0 with `mmio`). */
  rapl?: { pl1W: number; pl2W: number; mmio?: boolean };
  /** scaling_available_governors / energy_performance_available_preferences; absent = not written. */
  governors?: string;
  epps?: string;
  /** /proc/sys/kernel/random/boot_id; absent = not written. */
  bootId?: string;
}

export const RANKS = [211, 216, 216, 206, 201, 196, 181, 191, 186, 171, 176, 166];

export function ryzen3900x(over: Partial<MachineSpec> = {}): MachineSpec {
  return {
    model: "AMD Ryzen 9 3900X 12-Core Processor",
    vendor: "AuthenticAMD",
    family: 23,
    ccx: [
      [0, 1, 2, 12, 13, 14],
      [3, 4, 5, 15, 16, 17],
      [6, 7, 8, 18, 19, 20],
      [9, 10, 11, 21, 22, 23],
    ],
    siblings: (c) => [c % 12, (c % 12) + 12],
    // CCX n runs at 4100 + 50n MHz, the second thread of each core 10 MHz lower
    freqKHz: (c) => (4100 + 50 * Math.floor((c % 12) / 3)) * 1000 - (c >= 12 ? 10_000 : 0),
    maxKHz: 4_780_046,
    scalingMaxKHz: 4_780_046,
    lowestNonlinearKHz: 1_727_728,
    minKHz: 575_910,
    // read on the machine: 0, 1, 2 | 4, 5, 6 | 8, 9, 10 | 12, 13, 14 (one disabled slot per CCX)
    coreId: (c) => Math.floor((c % 12) / 3) * 4 + ((c % 12) % 3),
    driver: "amd-pstate-epp",
    governor: "performance",
    epp: "performance",
    boost: "1",
    rank: (c) => RANKS[c % 12]!,
    hwmon: [
      { name: "nvme", files: { temp1_input: "38850", temp1_label: "Composite" } },
      { name: "k10temp", files: { temp1_input: "56250", temp1_label: "Tctl", temp3_input: "53750", temp3_label: "Tccd1", temp4_input: "44750", temp4_label: "Tccd2" } },
      {
        name: "asusec",
        files: {
          fan1_input: "2491",
          fan1_label: "Chipset",
          temp1_input: "60000",
          temp1_label: "Chipset",
          temp2_input: "45000",
          temp2_label: "CPU",
          temp3_input: "34000",
          temp3_label: "Motherboard",
          temp4_input: "-40000",
          temp4_label: "T_Sensor",
        },
      },
      { name: "asus", files: {} },
    ],
    ...over,
  };
}

const list = (cpus: number[]) => {
  // "0-2,12-14", the way the kernel prints it
  const s = [...cpus].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < s.length; ) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j]! + 1) j++;
    parts.push(j === i ? String(s[i]) : `${s[i]}-${s[j]}`);
    i = j + 1;
  }
  return parts.join(",");
};

function put(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content + "\n");
}

/** A Ryzen 5 3600: one CCD with two 3-core CCXs (not the drawn 2 CCD × 2 CCX shape). */
export function ryzen3600(over: Partial<MachineSpec> = {}): MachineSpec {
  return ryzen3900x({
    model: "AMD Ryzen 5 3600 6-Core Processor",
    ccx: [
      [0, 1, 2, 6, 7, 8],
      [3, 4, 5, 9, 10, 11],
    ],
    siblings: (c) => [c % 6, (c % 6) + 6],
    freqKHz: (c) => (3600 + 100 * Math.floor((c % 6) / 3)) * 1000,
    maxKHz: 4_208_000,
    scalingMaxKHz: 4_208_000,
    rank: undefined,
    coreId: (c) => Math.floor((c % 6) / 3) * 4 + ((c % 6) % 3),
    hwmon: [{ name: "k10temp", files: { temp1_input: "48000", temp1_label: "Tctl", temp3_input: "45500", temp3_label: "Tccd1" } }],
    ...over,
  });
}

/**
 * An Intel hybrid like an i9-12900K: 8 P-cores with HT (cpus 0-15, siblings 2n and 2n+1) and
 * 8 E-cores (cpus 16-23), one shared L3, intel_pstate, coretemp, no prefcore ranking.
 */
export function intelHybrid(over: Partial<MachineSpec> = {}): MachineSpec {
  const all = Array.from({ length: 24 }, (_, i) => i);
  const files: Record<string, string> = { temp1_input: "41000", temp1_label: "Package id 0" };
  // coretemp labels its per-core sensors by core_id: P-cores 0, 4, …, 28, E-cores 32-39
  const ids = [...Array.from({ length: 8 }, (_, i) => i * 4), ...Array.from({ length: 8 }, (_, i) => 32 + i)];
  ids.forEach((id, i) => {
    files[`temp${i + 2}_input`] = String(35000 + i * 500);
    files[`temp${i + 2}_label`] = `Core ${id}`;
  });
  return {
    model: "12th Gen Intel(R) Core(TM) i9-12900K",
    vendor: "GenuineIntel",
    family: 6,
    ccx: [all],
    siblings: (c) => (c < 16 ? [c - (c % 2), c - (c % 2) + 1] : [c]),
    freqKHz: (c) => (c < 16 ? 4900_000 - (c % 2) * 400_000 : 3700_000),
    maxKHz: 5_200_000,
    maxKHzOf: (c) => (c < 16 ? 5_200_000 : 3_900_000),
    minKHz: 800_000,
    driver: "intel_pstate",
    governor: "powersave",
    epp: "balance_performance",
    boost: null,
    noTurbo: "0",
    coreId: (c) => (c < 16 ? Math.floor(c / 2) * 4 : 32 + (c - 16)),
    pmu: { core: all.slice(0, 16), atom: all.slice(16) },
    hwmon: [{ name: "acpitz", files: { temp1_input: "27800" } }, { name: "coretemp", files }],
    rapl: { pl1W: 241, pl2W: 241 },
    governors: "performance powersave",
    epps: "default performance balance_performance balance_power power",
    bootId: "boot-1",
    ...over,
  };
}

/** A plain 6-core Intel without SMT or hybrid (an i5-9600K): one L3, coretemp, cpufreq without boost file. */
export function intelPlain(over: Partial<MachineSpec> = {}): MachineSpec {
  const all = [0, 1, 2, 3, 4, 5];
  const files: Record<string, string> = { temp1_input: "38000", temp1_label: "Package id 0" };
  all.forEach((c) => {
    files[`temp${c + 2}_input`] = String(36000 + c * 1000);
    files[`temp${c + 2}_label`] = `Core ${c}`;
  });
  return intelHybrid({
    model: "Intel(R) Core(TM) i5-9600K CPU @ 3.70GHz",
    ccx: [all],
    siblings: (c) => [c],
    freqKHz: () => 4_300_000,
    maxKHz: 4_600_000,
    maxKHzOf: undefined,
    noTurbo: "1",
    coreId: (c) => c,
    pmu: undefined,
    hwmon: [{ name: "coretemp", files }],
    ...over,
  });
}

/** Writes the tree under `root` (sys/…, proc/cpuinfo). */
export function writeTree(root: string, m: MachineSpec): void {
  const all = m.ccx.flat().sort((a, b) => a - b);
  const cpuDir = path.join(root, "sys/devices/system/cpu");
  put(path.join(cpuDir, "online"), list(all));
  if (m.boost !== null) put(path.join(cpuDir, "cpufreq/boost"), m.boost);
  if (m.noTurbo !== undefined) put(path.join(cpuDir, "intel_pstate/no_turbo"), m.noTurbo);
  if (m.pmu) {
    put(path.join(root, "sys/devices/cpu_core/cpus"), list(m.pmu.core));
    put(path.join(root, "sys/devices/cpu_atom/cpus"), list(m.pmu.atom));
  }
  for (const group of m.ccx) {
    for (const c of group) {
      const d = path.join(cpuDir, `cpu${c}`);
      put(path.join(d, "cache/index3/shared_cpu_list"), list(group));
      put(path.join(d, "topology/thread_siblings_list"), list(m.siblings(c)));
      if (m.coreId) put(path.join(d, "topology/core_id"), String(m.coreId(c)));
      const f = m.freqKHz?.(c);
      if (f === undefined) continue;
      const fd = path.join(d, "cpufreq");
      put(path.join(fd, "scaling_cur_freq"), String(f));
      const max = m.maxKHzOf?.(c) ?? m.maxKHz;
      put(path.join(fd, "cpuinfo_max_freq"), String(max));
      put(path.join(fd, "scaling_max_freq"), String(m.scalingMaxKHz ?? max));
      if (m.lowestNonlinearKHz !== undefined) put(path.join(fd, "amd_pstate_lowest_nonlinear_freq"), String(m.lowestNonlinearKHz));
      if (m.minKHz !== undefined) put(path.join(fd, "cpuinfo_min_freq"), String(m.minKHz));
      put(path.join(fd, "scaling_driver"), m.driver);
      put(path.join(fd, "scaling_governor"), m.governor);
      put(path.join(fd, "energy_performance_preference"), m.epp);
      if (m.rank) put(path.join(fd, "amd_pstate_prefcore_ranking"), String(m.rank(c)));
      if (m.governors !== undefined) put(path.join(fd, "scaling_available_governors"), m.governors);
      if (m.epps !== undefined) put(path.join(fd, "energy_performance_available_preferences"), m.epps);
    }
  }
  const cpuinfo = all
    .slice(0, 2)
    .map((c) => `processor\t: ${c}\nvendor_id\t: ${m.vendor}\ncpu family\t: ${m.family}\nmodel\t\t: 113\nmodel name\t: ${m.model}\n`)
    .join("\n");
  put(path.join(root, "proc/cpuinfo"), cpuinfo);
  if (m.rapl) {
    // Constraint numbers as the kernel has them on the 13900K: 0 long_term, 1 short_term, 2 peak_power.
    const zone = (dir: string, name: string, pl1: number, pl2: number) => {
      put(path.join(dir, "name"), name);
      put(path.join(dir, "constraint_0_name"), "long_term");
      put(path.join(dir, "constraint_0_power_limit_uw"), String(pl1 * 1_000_000));
      put(path.join(dir, "constraint_1_name"), "short_term");
      put(path.join(dir, "constraint_1_power_limit_uw"), String(pl2 * 1_000_000));
      put(path.join(dir, "constraint_2_name"), "peak_power");
      put(path.join(dir, "constraint_2_power_limit_uw"), "380000000");
      put(path.join(dir, "energy_uj"), "1000000");
      put(path.join(dir, "max_energy_range_uj"), "262143328850");
    };
    const pc = path.join(root, "sys/class/powercap");
    zone(path.join(pc, "intel-rapl:0"), "package-0", m.rapl.pl1W, m.rapl.pl2W);
    zone(path.join(pc, "intel-rapl:0:0"), "core", 0, 0);
    if (m.rapl.mmio) zone(path.join(pc, "intel-rapl-mmio:0"), "package-0", m.rapl.pl1W, m.rapl.pl2W);
  }
  if (m.bootId !== undefined) put(path.join(root, "proc/sys/kernel/random/boot_id"), m.bootId);
  const off = m.hwmonOffset ?? 0;
  m.hwmon.forEach((h, i) => {
    const d = path.join(root, `sys/class/hwmon/hwmon${i + off}`);
    put(path.join(d, "name"), h.name);
    for (const [f, v] of Object.entries(h.files)) put(path.join(d, f), v);
  });
}

/** A temp dir holding the tree; remove it with `cleanup()`. */
export function tempTree(m: MachineSpec = ryzen3900x()): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ma-cpu-"));
  writeTree(root, m);
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** Changes one cpu's current frequency in an existing tree. */
export function setFreq(root: string, cpu: number, khz: number): void {
  fs.writeFileSync(path.join(root, `sys/devices/system/cpu/cpu${cpu}/cpufreq/scaling_cur_freq`), `${khz}\n`);
}

export function setHwmon(root: string, index: number, file: string, value: string): void {
  fs.writeFileSync(path.join(root, `sys/class/hwmon/hwmon${index}`, file), `${value}\n`);
}

/** Reads one file of a tree, trimmed. */
export function readFile(root: string, rel: string): string {
  return fs.readFileSync(path.join(root, rel), "utf8").trim();
}

/**
 * The voltage helper (packaging/motherapp-cpu-voltage.sh) as a src/voltage.ts Runner, in memory.
 * `protect`: the BIOS's Undervolt Protection (offsets read back 0); `setUp: false`: sudo has no rule.
 */
export function fakeVoltage(opts: { protect?: boolean; setUp?: boolean } = {}) {
  const state = { core: 0, cache: 0, calls: [] as string[][] };
  const out = () => `core ${state.core}\ncache ${state.cache}\n`;
  const run = (args: string[]) => {
    state.calls.push(args);
    if (opts.setUp === false) return { status: 1, stdout: "", stderr: "sudo: a password is required\n" };
    if (args[0] === "read") return { status: 0, stdout: out(), stderr: "" };
    const mV = Number(args[1]);
    if (!opts.protect) state.core = state.cache = mV;
    if (state.core !== mV) {
      return { status: 3, stdout: out(), stderr: `cpu-voltage: the CPU didn't take ${mV} mV (it reads core 0 mV, cache 0 mV): turn off "Undervolt Protection" (and "IA CEP Support") in the BIOS\n` };
    }
    return { status: 0, stdout: out(), stderr: "" };
  };
  return { state, run };
}
