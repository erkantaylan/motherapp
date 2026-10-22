// Plain subcommands for terminals and scripts. They read sysfs and cpu.json themselves, every
// time, and never go through the core (whose cached state is stale while nobody watches).
import type { Writable } from "node:stream";
import { AMD_ONLY, buildReport, formatProfiles, formatStatus, tuningSupported } from "./model.ts";
import { loadSettings, toFile } from "./settings.ts";
import { readSnapshot } from "./sysfs.ts";

export const USAGE = `usage: cpuctl <command> [options]

  status [--json]      CPU model, cpufreq driver/governor/EPP/boost, per-CCX and per-core
                       frequencies, temperatures (k10temp, asusec), read fresh from sysfs
  profiles [--json]    the underclock and overclock profiles and the active one, from
                       ~/.config/motherapp/cpu.json (created with the defaults if missing);
                       applying them isn't available yet. AMD Ryzen (family 0x17) only
  serve                JSON-RPC serve mode (started by the motherapp core)

Read-only: nothing here writes to the hardware or to sysfs.
MOTHERAPP_CPU_ROOT=<dir> reads <dir>/sys and <dir>/proc instead of / (for tests).
Exit codes: 0 ok, 1 nothing could be read, 2 usage error.`;

export interface CliIO {
  root: string;
  settingsFile: string;
  stdout: Writable;
  stderr: Writable;
}

class UsageError extends Error {}

const line = (out: Writable, s = "") => out.write(s + "\n");

function jsonFlag(args: string[]): boolean {
  const bad = args.find((a) => a !== "--json");
  if (bad !== undefined) throw new UsageError(`unknown option "${bad}"`);
  return args.includes("--json");
}

export async function runCli(argv: string[], io: CliIO): Promise<number> {
  const [cmd, ...args] = argv;
  try {
    switch (cmd) {
      case "status": {
        const json = jsonFlag(args);
        const report = buildReport(readSnapshot(io.root));
        line(io.stdout, json ? JSON.stringify(report, null, 2) : formatStatus(report));
        return report.threads === 0 ? 1 : 0;
      }
      case "profiles": {
        const json = jsonFlag(args);
        const snap = readSnapshot(io.root);
        if (!tuningSupported(snap.vendor, snap.family)) {
          // No cpu.json on other CPUs: it is neither read nor created.
          line(io.stdout, json ? JSON.stringify({ supported: false, reason: AMD_ONLY }, null, 2) : AMD_ONLY);
          return 0;
        }
        const loaded = loadSettings(io.settingsFile, { create: true });
        const ccxCount = snap.ccx.length || undefined;
        if (json) {
          // The file's shape (profiles keyed by id), plus where it is and what was wrong with it.
          const out = { file: io.settingsFile, ...(toFile(loaded.settings) as object), problems: loaded.problems, applyAvailable: false };
          line(io.stdout, JSON.stringify(out, null, 2));
        } else {
          line(io.stdout, formatProfiles(io.settingsFile, loaded.settings, loaded.problems, ccxCount));
        }
        return 0;
      }
      case undefined:
      case "help":
      case "-h":
      case "--help":
        line(cmd === undefined ? io.stderr : io.stdout, USAGE);
        return cmd === undefined ? 2 : 0;
      default:
        throw new UsageError(`unknown command "${cmd}"`);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      line(io.stderr, `cpuctl: ${e.message}\n\n${USAGE}`);
      return 2;
    }
    line(io.stderr, `cpuctl: ${(e as Error).message}`);
    return 1;
  }
}
