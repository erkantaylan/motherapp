// Plain subcommands for terminals and scripts. They read sysfs and cpu.json themselves, every
// time, and never go through the core (whose cached state is stale while nobody watches).
// `use` writes sysfs and cpu.json directly too; a running service picks the change up.
import type { Writable } from "node:stream";
import {
  LIMIT_KEYS,
  access,
  applyProfile,
  bootId,
  formatValue,
  hasValues,
  label,
  loadIntelSettings,
  loadStock,
  presentKeys,
  readLimits,
  THERMALD,
  thermaldRunning,
  updateIntelSettings,
} from "./intel.ts";
import type { IntelSettings } from "./intel.ts";
import { AMD_ONLY, buildReport, formatProfiles, formatStatus, tuningSupported } from "./model.ts";
import { PROFILE_IDS, loadSettings, toFile } from "./settings.ts";
import type { ProfileId } from "./settings.ts";
import { TRIAL_MS } from "./voltage.ts";
import type { Voltage } from "./voltage.ts";
import { readSnapshot } from "./sysfs.ts";

export const USAGE = `usage: cpuctl <command> [options]

  status [--json]      CPU model, cpufreq driver/governor/EPP/boost, per-CCX and per-core
                       frequencies, temperatures (k10temp, asusec), read fresh from sysfs
  profiles [--json]    the underclock and overclock profiles and the active one, from
                       ~/.config/motherapp/cpu.json (created with the defaults if missing).
                       AMD Ryzen (family 0x17): ClockTuner for Ryzen values, shown only.
                       Intel: clock caps, turbo, governor, EPP and PL1/PL2
  limits [--json]      Intel: each limit now, at stock, and whether it can be written
                       (the undervolt is read through the voltage helper, with sudo -n)
  use <profile>        Intel: apply stock, underclock or overclock and make it the active
                       profile (needs the access install.sh sets up)
  serve                JSON-RPC serve mode (started by the motherapp core)

AMD: nothing here writes to the hardware or to sysfs.
MOTHERAPP_CPU_ROOT=<dir> reads <dir>/sys and <dir>/proc instead of / (for tests).
Exit codes: 0 ok, 1 nothing could be read, 2 usage error.`;

export interface CliIO {
  root: string;
  settingsFile: string;
  /** Intel: the stock snapshot (src/intel.ts stockFile). */
  stockFile: string;
  /** Intel: the undervolt helper and its crash guard (src/voltage.ts). */
  voltage?: Voltage;
  guardFile?: string;
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
        if (snap.vendor === "GenuineIntel") return intelProfiles(io, json);
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
      case "limits": {
        const json = jsonFlag(args);
        if (readSnapshot(io.root).vendor !== "GenuineIntel") throw new Error(INTEL_ONLY);
        const hw = readLimits(io.root, io.voltage);
        const stock = loadStock(io.stockFile, bootId(io.root));
        if (json) {
          line(io.stdout, JSON.stringify({ hybrid: hw.hybrid, access: access(hw), current: hw.current, stock: stock?.values ?? hw.current, stockFrom: stock ? "snapshot" : "now", writable: hw.writable, range: hw.range }, null, 2));
          return 0;
        }
        const keys = presentKeys(hw);
        const w = Math.max(...keys.map((k) => label(k, hw.hybrid).length));
        const st = stock?.values ?? hw.current;
        line(io.stdout, `${"".padEnd(w)}  ${"now".padEnd(20)}  ${"stock".padEnd(20)}  writable`);
        for (const k of keys) line(io.stdout, `${label(k, hw.hybrid).padEnd(w)}  ${formatValue(k, hw.current[k]).padEnd(20)}  ${formatValue(k, st[k]).padEnd(20)}  ${hw.writable[k] ? "yes" : "no"}`);
        line(io.stdout, "");
        line(io.stdout, stock ? `Stock = the values before motherapp first changed them this boot (${new Date(stock.takenAt).toLocaleString()}).` : "motherapp hasn't changed anything this boot: stock = now.");
        if (access(hw) !== "full") line(io.stdout, NO_WRITE);
        if (hw.voltageProblem) line(io.stdout, hw.voltageProblem.replaceAll("`", ""));
        if (thermaldRunning(io.root)) line(io.stdout, THERMALD.replaceAll("`", ""));
        return 0;
      }
      case "use": {
        const [which, ...rest] = args;
        if (rest.length || which === undefined || !["stock", ...PROFILE_IDS].includes(which)) throw new UsageError("use needs one of: stock, underclock, overclock");
        if (readSnapshot(io.root).vendor !== "GenuineIntel") throw new Error(INTEL_ONLY);
        const loaded = loadIntelSettings(io.settingsFile, { create: true });
        if (loaded.broken) throw new Error(loaded.problems.join(" "));
        const id = which === "stock" ? null : (which as ProfileId);
        const p = loaded.settings.profiles.find((x) => x.id === id);
        if (p && !hasValues(p)) throw new Error(`${p.name} has nothing set yet: edit ${io.settingsFile} or use the CPU page`);
        const r = applyProfile(io.root, io.stockFile, loaded.settings, id, Date.now(), {
          ...(io.voltage ? { voltage: io.voltage } : {}),
          ...(io.guardFile ? { guardFile: io.guardFile } : {}),
        });
        for (const c of r.changed) line(io.stdout, c);
        if (!r.changed.length && !r.problems.length) line(io.stdout, `${r.name}: nothing needed changing.`);
        for (const pr of r.problems) line(io.stderr, `cpuctl: ${pr}`);
        if (r.problems.length && !r.changed.length) return 1;
        if (loaded.settings.active !== id) updateIntelSettings(io.settingsFile, (s) => (s.active = id));
        line(io.stdout, `Active profile: ${r.name}.`);
        if (r.trial !== undefined) line(io.stdout, `Undervolt ${r.trial} mV is on trial for ${TRIAL_MS / 60_000} minutes: if the computer crashes or restarts before then, motherapp won't set it again on its own.`);
        return r.problems.length ? 1 : 0;
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

const INTEL_ONLY = "limits and use are for Intel CPUs only so far (AMD Ryzen profiles need the SMU, a later step)";
const NO_WRITE = "Some limits can't be written: run `motherapp install` in a terminal and allow the \"CPU limits\" step.";

function intelProfiles(io: CliIO, json: boolean): number {
  const loaded = loadIntelSettings(io.settingsFile, { create: true });
  const s: IntelSettings = loaded.settings;
  if (json) {
    const profiles: Record<string, unknown> = {};
    for (const { id, ...rest } of s.profiles) profiles[id] = rest;
    line(io.stdout, JSON.stringify({ file: io.settingsFile, active: s.active, applyOnStart: s.applyOnStart, profiles, problems: loaded.problems }, null, 2));
    return 0;
  }
  const hybrid = readLimits(io.root).hybrid; // no helper call: only the core layout
  line(io.stdout, `Profiles, from ${io.settingsFile}:`);
  line(io.stdout, "");
  for (const p of loaded.problems) line(io.stdout, `! ${p}`);
  if (loaded.problems.length) line(io.stdout, "");
  for (const p of s.profiles) {
    line(io.stdout, `${p.id.padEnd(10)}  ${p.name}${p.id === s.active ? "  (active)" : ""}`);
    const set = LIMIT_KEYS.filter((k) => p[k] !== undefined);
    if (!set.length) line(io.stdout, "    nothing set yet (all stock)");
    for (const k of set) line(io.stdout, `    ${label(k, hybrid)}: ${formatValue(k, p[k])}`);
    line(io.stdout, "");
  }
  const active = s.profiles.find((p) => p.id === s.active);
  line(io.stdout, active ? `Active profile: ${active.name}${s.applyOnStart ? ", applied when the tool starts" : ", not applied on start"}.` : "Active profile: none (stock).");
  line(io.stdout, "Everything a profile doesn't set stays at stock. `cpuctl use <profile>` applies one.");
  return 0;
}
