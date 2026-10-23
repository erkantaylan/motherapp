// Package power from RAPL: the change of the package zone's energy counter (energy_uj, µJ)
// between two reads, over the time between them. The kernel makes energy_uj root-only (a power
// side channel, CVE-2020-8694); motherapp-cpu-access.service gives the user's group read access
// to the package zones' counters, as it does write access to the limits.
import * as fs from "node:fs";
import * as path from "node:path";
import { SysReader } from "./sysfs.ts";

const POWERCAP_DIR = "sys/class/powercap";

export const NO_ENERGY_ACCESS =
  "Package power needs read access to the RAPL energy counter: run `motherapp install` and allow the \"CPU limits\" step.";

/** The first package zone with an energy counter (intel-rapl:0 before intel-rapl-mmio:0). */
export function energyZone(r: SysReader): string | undefined {
  return r
    .list(POWERCAP_DIR)
    .filter((z) => /^intel-rapl(-mmio)?:\d+$/.test(z))
    .sort((a, b) => Number(a.includes("mmio")) - Number(b.includes("mmio")) || a.localeCompare(b, undefined, { numeric: true }))
    .map((z) => `${POWERCAP_DIR}/${z}`)
    .find((z) => (r.text(`${z}/name`) ?? "").startsWith("package") && r.list(z).includes("energy_uj"));
}

export interface PowerReading {
  /** Watts over the last interval; absent on the first read (nothing to compare with). */
  watts?: number;
  /** Why there is no number at all (no zone, no access). */
  problem?: string;
}

export class PowerMeter {
  private last: { uj: number; ms: number } | undefined;
  private root: string;
  private r: SysReader;
  constructor(root: string) {
    this.root = root;
    this.r = new SysReader(root);
  }

  /** Forget the previous read, so a long unwatched gap isn't averaged into one number. */
  reset(): void {
    this.last = undefined;
  }

  read(nowMs: number): PowerReading {
    const zone = energyZone(this.r);
    if (!zone) return { problem: "No RAPL package zone: package power isn't available on this CPU." };
    let text: string;
    try {
      text = fs.readFileSync(path.join(this.root, zone, "energy_uj"), "utf8").trim();
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      return { problem: code === "EACCES" || code === "EPERM" ? NO_ENERGY_ACCESS : `Can't read /${zone}/energy_uj: ${(e as Error).message}` };
    }
    const uj = Number(text);
    if (!Number.isFinite(uj)) return { problem: `/${zone}/energy_uj isn't a number` };
    const prev = this.last;
    this.last = { uj, ms: nowMs };
    if (!prev || nowMs <= prev.ms) return {};
    let d = uj - prev.uj;
    if (d < 0) d += this.r.int(`${zone}/max_energy_range_uj`) ?? 0; // the counter wrapped
    if (d < 0) return {};
    return { watts: Math.round((d / ((nowMs - prev.ms) * 1000)) * 10) / 10 };
  }
}
