// Fallback backend over the ddcutil command, used when libddcutil can't be loaded. Each call
// is a process (~0.5 s for a read with --bus on the machine, ~1 s for detect). Output formats
// are the ones ddcutil 1.4.1 printed on the machine (machine-facts/raw-output.txt).
import { spawn } from "node:child_process";
import { BackendError } from "./backend.ts";
import type { Backend, MonitorInfo, Reading } from "./backend.ts";
import { stripCard } from "./sysfs.ts";

export interface CliBackendOptions {
  /** Command to run. Default "ddcutil" (looked up on PATH). */
  command?: string;
  /** Kill a ddcutil call after this long. Default 6 s (detect: 12 s). */
  timeoutMs?: number;
  /** Environment for ddcutil (PATH lookup included). Default process.env. */
  env?: NodeJS.ProcessEnv;
}

interface Result {
  code: number | null;
  out: string;
}

function run(cmd: string, args: string[], timeoutMs: number, env: NodeJS.ProcessEnv = process.env): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...env, LC_ALL: "C" } });
    let out = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8").on("data", (c: string) => (out += c));
    child.stderr.setEncoding("utf8").on("data", (c: string) => (out += c));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      const code = (e as NodeJS.ErrnoException).code;
      reject(new BackendError(code === "ENOENT" ? `${cmd} not found (install the ddcutil package)` : `cannot run ${cmd}: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new BackendError(`no answer: ddcutil took longer than ${timeoutMs / 1000} s`));
      else resolve({ code, out });
    });
  });
}

/** Parses `ddcutil detect --brief`. Only "Display N" blocks count; "Invalid display" ones don't. */
export function parseDetect(text: string): MonitorInfo[] {
  const out: MonitorInfo[] = [];
  for (const block of text.split(/\n(?=\S)/)) {
    if (!/^Display \d+/.test(block)) continue;
    const field = (name: string) => block.match(new RegExp(`^\\s*${name}:\\s*(.*)$`, "m"))?.[1]?.trim();
    const bus = field("I2C bus")?.match(/i2c-(\d+)/)?.[1];
    if (bus === undefined) continue;
    const info: MonitorInfo = { bus: Number(bus), mfg: "", model: "", serial: "" };
    const monitor = field("Monitor");
    if (monitor) {
      // MFG:model:serial. The model may contain ':', the mfg id and the serial don't.
      const first = monitor.indexOf(":");
      const last = monitor.lastIndexOf(":");
      if (first >= 0 && last > first) {
        info.mfg = monitor.slice(0, first);
        info.model = monitor.slice(first + 1, last);
        info.serial = monitor.slice(last + 1);
      } else {
        info.model = monitor;
      }
    }
    const connector = field("DRM connector");
    if (connector && connector !== "Not found") info.connector = stripCard(connector);
    out.push(info);
  }
  return out;
}

/** Parses `ddcutil getvcp 10`: "... current value =    48, max value =   100" (or --brief "VCP 10 C 48 100"). */
export function parseGetvcp(text: string): Reading | undefined {
  const m = text.match(/current value\s*=\s*(\d+),\s*max value\s*=\s*(\d+)/) ?? text.match(/^VCP 10 C (\d+) (\d+)/m);
  return m ? { current: Number(m[1]), max: Number(m[2]) } : undefined;
}

/** The useful line of a failed ddcutil call, as a BackendError. */
export function cliError(out: string, code: number | null): BackendError {
  const line = out.split("\n").map((l) => l.trim()).find(Boolean) ?? `exit code ${code}`;
  const short = line.length > 160 ? line.slice(0, 160) + "…" : line;
  if (/not found|no monitor detected|does not exist|no such file|invalid display/i.test(out)) {
    return new BackendError(`not reachable any more, unplugged or switched off? (ddcutil: ${short})`, { gone: true });
  }
  if (/ddc communication failed|retries|null response|no response|i\/o error/i.test(out)) {
    return new BackendError(`no answer over DDC/CI, is it switched on? (ddcutil: ${short})`);
  }
  return new BackendError(`ddcutil failed: ${short}`);
}

export class CliBackend implements Backend {
  readonly kind = "ddcutil" as const;
  description = "ddcutil command";
  private cmd: string;
  private timeoutMs: number;
  private env: NodeJS.ProcessEnv;

  constructor(opts: CliBackendOptions = {}) {
    this.cmd = opts.command ?? "ddcutil";
    this.timeoutMs = opts.timeoutMs ?? 6000;
    this.env = opts.env ?? process.env;
  }

  /** Reads `ddcutil --version` for the description; resolves even if ddcutil is missing. */
  async probe(): Promise<string | undefined> {
    try {
      const r = await run(this.cmd, ["--version"], 5000, this.env);
      const v = r.out.match(/ddcutil\s+(\d+\.\d+\.\d+\S*)/)?.[1];
      if (v) this.description = `ddcutil ${v} command`;
      return undefined;
    } catch (e) {
      return (e as Error).message;
    }
  }

  async detect(_redetect: boolean): Promise<MonitorInfo[]> {
    const r = await run(this.cmd, ["detect", "--brief"], this.timeoutMs * 2, this.env);
    if (r.code !== 0) throw cliError(r.out, r.code);
    return parseDetect(r.out);
  }

  async read(bus: number): Promise<Reading> {
    const r = await run(this.cmd, ["--bus", String(bus), "getvcp", "10"], this.timeoutMs, this.env);
    const v = r.code === 0 ? parseGetvcp(r.out) : undefined;
    if (!v) throw cliError(r.out, r.code);
    return v;
  }

  async write(bus: number, raw: number): Promise<void> {
    const r = await run(this.cmd, ["--bus", String(bus), "setvcp", "10", String(Math.round(raw))], this.timeoutMs, this.env);
    if (r.code !== 0) throw cliError(r.out, r.code);
  }

  async close(): Promise<void> {}
}
