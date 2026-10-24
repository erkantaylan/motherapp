// Undervolting (the user's call, 2026-10-23: the first overclocking step): a negative voltage
// offset for the core and cache planes, through the root helper packaging/motherapp-cpu-voltage.sh
// (installed as /usr/local/lib/motherapp/cpu-voltage, run with `sudo -n` under a sudoers rule
// for that one file). The tool itself never touches /dev/cpu/*/msr.
//
// Every call is a sudo run (and a line in the journal), so the offset is read once, then only
// again when it is set: nothing else changes it, and it resets to 0 at every reboot.
//
// Crash guard: before an offset is set, a "trial" is written to
// $XDG_STATE_HOME/motherapp/cpu-undervolt.json (the offset, this boot's id, the time). After
// TRIAL_MS on the same boot it is cleared. A tool start that finds a trial from another boot
// (the machine went down during the trial: a crash, or a restart within TRIAL_MS) turns it into
// "blocked": the offset isn't applied on its own again until the user applies a profile.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeAtomic } from "./settings.ts";

export const VOLTAGE_HELPER = "/usr/local/lib/motherapp/cpu-voltage";
/** Whole mV; never positive (no overvolting). The helper checks the same range. */
export const UNDERVOLT_RANGE: [number, number] = [-150, 0];
export const UNDERVOLT_STEP = 5;
export const TRIAL_MS = 10 * 60_000;

export const NO_VOLTAGE =
  "Undervolting needs the voltage helper: run `motherapp install` in a terminal and allow the \"CPU undervolt\" step (it asks for sudo once).";

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}
export type Runner = (args: string[]) => RunResult;

/** `sudo -n <helper>`, or $MOTHERAPP_CPU_VOLTAGE run directly (tests, a fixture machine). */
export function voltageCommand(env: NodeJS.ProcessEnv = process.env): string[] {
  return env.MOTHERAPP_CPU_VOLTAGE ? [env.MOTHERAPP_CPU_VOLTAGE] : ["sudo", "-n", VOLTAGE_HELPER];
}

export function spawnRunner(cmd: string[]): Runner {
  return (args) => {
    const r = spawnSync(cmd[0]!, [...cmd.slice(1), ...args], { encoding: "utf8", timeout: 10_000 });
    const out: RunResult = { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    if (r.error) out.error = r.error;
    return out;
  };
}

export interface Offsets {
  core: number;
  cache: number;
}

export interface VoltageState {
  offsets?: Offsets;
  /** Why the offsets can't be read or the last set didn't take. */
  problem?: string;
}

function parseOffsets(text: string): Offsets | undefined {
  const core = /^core (-?\d+)$/m.exec(text)?.[1];
  const cache = /^cache (-?\d+)$/m.exec(text)?.[1];
  return core === undefined || cache === undefined ? undefined : { core: Number(core), cache: Number(cache) };
}

/** The helper isn't installed, or sudo won't run it without a password. */
const notSetUp = (r: RunResult) =>
  r.error !== undefined || /password is required|a terminal is required|command not found|not allowed to execute|may not run sudo/.test(r.stderr);

export class Voltage {
  private run: Runner;
  private last: VoltageState | undefined;
  constructor(run: Runner) {
    this.run = run;
  }

  private call(args: string[]): VoltageState {
    const r = this.run(args);
    const offsets = parseOffsets(r.stdout);
    const out: VoltageState = {};
    if (offsets) out.offsets = offsets;
    if (r.status !== 0 || !offsets) {
      const msg = r.stderr.trim().replace(/^cpu-voltage: /gm, "");
      out.problem = notSetUp(r) ? NO_VOLTAGE : msg ? `Undervolt: ${msg}` : "Undervolt: the voltage helper gave no answer.";
    }
    return out;
  }

  /** The last reading; reads once if there is none yet. */
  state(): VoltageState {
    this.last ??= this.call(["read"]);
    return this.last;
  }

  refresh(): VoltageState {
    this.last = this.call(["read"]);
    return this.last;
  }

  /** Sets core and cache to `mV`; the new state is what the helper read back. */
  set(mV: number): VoltageState {
    const r = this.call(["set", String(mV)]);
    // Keep the old offsets when the helper couldn't even read them back.
    this.last = r.offsets ? r : { ...this.last, ...(r.problem ? { problem: r.problem } : {}) };
    return r;
  }
}

// ---- crash guard ----

export interface Guard {
  trial?: { mV: number; bootId?: string; at: number };
  blocked?: { mV: number; at: number };
}

export function guardFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "motherapp", "cpu-undervolt.json");
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function loadGuard(file: string): Guard {
  try {
    const v: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    const g: Guard = {};
    if (!isObj(v)) return g;
    if (isObj(v.trial) && num(v.trial.mV) && num(v.trial.at)) {
      g.trial = { mV: v.trial.mV, at: v.trial.at };
      if (typeof v.trial.bootId === "string") g.trial.bootId = v.trial.bootId;
    }
    if (isObj(v.blocked) && num(v.blocked.mV) && num(v.blocked.at)) g.blocked = { mV: v.blocked.mV, at: v.blocked.at };
    return g;
  } catch {
    return {};
  }
}

export function saveGuard(file: string, g: Guard): void {
  if (!g.trial && !g.blocked) {
    fs.rmSync(file, { force: true });
    return;
  }
  writeAtomic(file, JSON.stringify(g, null, 2) + "\n");
}

/** At start: a trial from another boot didn't survive it. Returns the guard as saved. */
export function checkCrash(file: string, boot: string | undefined): { guard: Guard; crashed?: number } {
  const g = loadGuard(file);
  if (!g.trial || g.trial.bootId === boot) return { guard: g };
  const crashed = g.trial.mV;
  const next: Guard = { blocked: { mV: crashed, at: g.trial.at } };
  saveGuard(file, next);
  return { guard: next, crashed };
}

/** Clears a trial on this boot that has run its course. Returns the mV that held, if any. */
export function endTrial(file: string, boot: string | undefined, now: number): number | undefined {
  const g = loadGuard(file);
  if (!g.trial || g.trial.bootId !== boot || now - g.trial.at < TRIAL_MS) return undefined;
  const held = g.trial.mV;
  delete g.trial;
  saveGuard(file, g);
  return held;
}

export const blockedText = (mV: number) =>
  `motherapp was trying an undervolt of ${mV} mV when the computer last went down (a crash, or a restart within ${TRIAL_MS / 60_000} minutes of setting it), so it didn't set it again. Lower the undervolt, or apply the profile again to retry.`;

export const trialText = (mV: number, until: string) =>
  `Trying ${mV} mV until ${until}: if the computer crashes or restarts before then, motherapp won't set it again on its own. A heavy load now (a benchmark, a compile) is the best test.`;
