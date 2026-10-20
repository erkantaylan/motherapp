// Test doubles: a scriptable backend (no monitors or /dev/i2c in CI) and small helpers.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { BackendError } from "../src/backend.ts";
import type { Backend, MonitorInfo, Reading } from "../src/backend.ts";

export const MSI: MonitorInfo = { bus: 1, connector: "DP-1", mfg: "MSI", model: "MSI G274QPF", serial: "CC2H683C00058" };
export const ACER: MonitorInfo = { bus: 3, connector: "DP-2", mfg: "ACR", model: "Acer X34 P", serial: "#ASM1Buw5LKnd" };
export const MSI_KEY = "MSI-MSI_G274QPF-CC2H683C00058";
export const ACER_KEY = "ACR-Acer_X34_P-ASM1Buw5LKnd";

interface FakeMonitor {
  info: MonitorInfo;
  value: number;
  max: number;
  /** Calls fail like a monitor that is switched off. */
  off?: boolean;
  /** Calls never return. */
  hang?: boolean;
}

export class FakeBackend implements Backend {
  readonly kind = "ddcutil" as const;
  description = "fake backend";
  monitors = new Map<number, FakeMonitor>();
  /** Buses visible to detect (default: all in `monitors`). */
  visible: Set<number> | undefined;
  calls: string[] = [];
  delayMs = 5;
  detectDelayMs = 5;
  detectError: string | undefined;
  /** Highest number of calls that ran at the same time on one bus. */
  maxConcurrentPerBus = 0;
  private running = new Map<number, number>();

  constructor(...monitors: { info: MonitorInfo; value: number; max?: number }[]) {
    for (const m of monitors) this.monitors.set(m.info.bus, { info: m.info, value: m.value, max: m.max ?? 100 });
  }

  mon(bus: number): FakeMonitor {
    return this.monitors.get(bus)!;
  }

  private async onBus<T>(bus: number, fn: (m: FakeMonitor) => T): Promise<T> {
    const n = (this.running.get(bus) ?? 0) + 1;
    this.running.set(bus, n);
    this.maxConcurrentPerBus = Math.max(this.maxConcurrentPerBus, n);
    try {
      const m = this.monitors.get(bus);
      if (m?.hang) await new Promise(() => {});
      await sleep(this.delayMs);
      if (!m || (this.visible && !this.visible.has(bus))) throw new BackendError("not reachable any more, unplugged or switched off?", { gone: true });
      if (m.off) throw new BackendError("no answer over DDC/CI, is it switched on?");
      return fn(m);
    } finally {
      this.running.set(bus, this.running.get(bus)! - 1);
    }
  }

  async detect(redetect: boolean): Promise<MonitorInfo[]> {
    this.calls.push(`detect${redetect ? " redetect" : ""}`);
    await sleep(this.detectDelayMs);
    if (this.detectError) throw new BackendError(this.detectError);
    return [...this.monitors.values()].filter((m) => !this.visible || this.visible.has(m.info.bus)).map((m) => ({ ...m.info }));
  }

  read(bus: number): Promise<Reading> {
    this.calls.push(`read ${bus}`);
    return this.onBus(bus, (m) => ({ current: m.value, max: m.max }));
  }

  write(bus: number, raw: number): Promise<void> {
    this.calls.push(`write ${bus} ${raw}`);
    return this.onBus(bus, (m) => {
      m.value = raw;
    });
  }

  async close(): Promise<void> {
    this.calls.push("close");
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
export const fixtures = path.join(here, "fixtures");

/** A `ddcutil` on a bin dir (put it first on PATH) backed by fake-ddcutil.ts and JSON files. */
export function fakeDdcutil(root: string, monitors: { bus: number; connector: string; mfg: string; model: string; serial: string; value: number; max?: number }[]) {
  const bin = path.join(root, "bin");
  const dir = path.join(root, "ddc");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  const script = `#!/bin/sh\nexport FAKE_DDC_DIR="${dir}"\nexec "${process.execPath}" --disable-warning=ExperimentalWarning "${path.join(here, "fake-ddcutil.ts")}" "$@"\n`;
  fs.writeFileSync(path.join(bin, "ddcutil"), script, { mode: 0o755 });
  for (const m of monitors) fs.writeFileSync(path.join(dir, `bus-${m.bus}.json`), JSON.stringify({ max: 100, ...m }));
  return {
    bin,
    dir,
    command: path.join(bin, "ddcutil"),
    calls: (): string[] =>
      fs.existsSync(path.join(dir, "calls.log"))
        ? fs.readFileSync(path.join(dir, "calls.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => (JSON.parse(l) as string[]).join(" "))
        : [],
    value: (bus: number): number => (JSON.parse(fs.readFileSync(path.join(dir, `bus-${bus}.json`), "utf8")) as { value: number }).value,
    patch: (bus: number, p: Record<string, unknown>) => {
      const f = path.join(dir, `bus-${bus}.json`);
      fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, "utf8")), ...p }));
    },
    unplug: (bus: number) => fs.rmSync(path.join(dir, `bus-${bus}.json`)),
  };
}

export const MACHINE_MONITORS = [
  { bus: 1, connector: "DP-1", mfg: "MSI", model: "MSI G274QPF", serial: "CC2H683C00058", value: 48 },
  { bus: 3, connector: "DP-2", mfg: "ACR", model: "Acer X34 P", serial: "#ASM1Buw5LKnd", value: 52 },
];

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(cond: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}
