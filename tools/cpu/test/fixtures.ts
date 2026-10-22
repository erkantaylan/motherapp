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
  scalingMaxKHz?: number;
  driver: string;
  governor: string;
  epp: string;
  /** Global boost file; null = absent. */
  boost: "0" | "1" | null;
  rank?: (cpu: number) => number;
  hwmon: HwmonSpec[];
  /** Extra hwmon dirs before the interesting ones, so their numbers don't match the machine's. */
  hwmonOffset?: number;
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

/** Writes the tree under `root` (sys/…, proc/cpuinfo). */
export function writeTree(root: string, m: MachineSpec): void {
  const all = m.ccx.flat().sort((a, b) => a - b);
  const cpuDir = path.join(root, "sys/devices/system/cpu");
  put(path.join(cpuDir, "online"), list(all));
  if (m.boost !== null) put(path.join(cpuDir, "cpufreq/boost"), m.boost);
  for (const group of m.ccx) {
    for (const c of group) {
      const d = path.join(cpuDir, `cpu${c}`);
      put(path.join(d, "cache/index3/shared_cpu_list"), list(group));
      put(path.join(d, "topology/thread_siblings_list"), list(m.siblings(c)));
      const f = m.freqKHz?.(c);
      if (f === undefined) continue;
      const fd = path.join(d, "cpufreq");
      put(path.join(fd, "scaling_cur_freq"), String(f));
      put(path.join(fd, "cpuinfo_max_freq"), String(m.maxKHz));
      put(path.join(fd, "scaling_max_freq"), String(m.scalingMaxKHz ?? m.maxKHz));
      put(path.join(fd, "scaling_driver"), m.driver);
      put(path.join(fd, "scaling_governor"), m.governor);
      put(path.join(fd, "energy_performance_preference"), m.epp);
      if (m.rank) put(path.join(fd, "amd_pstate_prefcore_ranking"), String(m.rank(c)));
    }
  }
  const cpuinfo = all
    .slice(0, 2)
    .map((c) => `processor\t: ${c}\nvendor_id\t: ${m.vendor}\ncpu family\t: ${m.family}\nmodel\t\t: 113\nmodel name\t: ${m.model}\n`)
    .join("\n");
  put(path.join(root, "proc/cpuinfo"), cpuinfo);
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
