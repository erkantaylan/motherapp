// ~/.config/motherapp/cpu.json on AMD Ryzen (Intel has its own profile shape, src/intel.ts):
// the user's two overclock profiles and which one is chosen (the user's call, 2026-10-22). Read-only for now: a later step applies the active profile
// through the SMU, re-applying it whenever the tool starts (at login, with the service).
//
//   { "version": 1,
//     "active": null,                // "underclock" | "overclock" | null (null = stock, untouched)
//     "applyOnStart": true,          // re-apply the active profile when the tool starts
//     "profiles": {
//       "underclock": { "name": "Underclock", "ccx": null, "vcore": null },
//       "overclock":  { "name": "Overclock (CTR)", "ccx": [4250, 4250, 4125, 4100], "vcore": 1.25,
//                       "cinebenchR20": 6916, "powerW": 137 } } }
//
// `ccx` holds one frequency in MHz per CCX, CCX1 first; `vcore` is in volts; `null` means "not
// set yet" (the underclock values aren't known yet, so none are made up). `cinebenchR20` and
// `powerW` are what the profile measured when it was validated (optional). A missing file is
// created with the defaults; a broken one is never overwritten.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const PROFILE_IDS = ["underclock", "overclock"] as const;
export type ProfileId = (typeof PROFILE_IDS)[number];

export interface Profile {
  id: ProfileId;
  name: string;
  /** MHz per CCX, CCX1 first; null = not set yet. */
  ccx: number[] | null;
  /** Volts; null = not set yet. */
  vcore: number | null;
  cinebenchR20?: number;
  powerW?: number;
}

export interface Settings {
  version: 1;
  /** The chosen profile; null = stock settings, nothing applied. */
  active: ProfileId | null;
  /** Re-apply the active profile when the tool starts (not implemented yet). */
  applyOnStart: boolean;
  /** Always both, underclock first. */
  profiles: Profile[];
}

export interface Loaded {
  settings: Settings;
  /** The file was missing and has just been written with the defaults. */
  created?: boolean;
  /** Why the file (or parts of it) couldn't be used, worded for the page. */
  problems: string[];
}

const DEFAULT_NAMES: Record<ProfileId, string> = { underclock: "Underclock", overclock: "Overclock (CTR)" };

const unset = (id: ProfileId): Profile => ({ id, name: DEFAULT_NAMES[id], ccx: null, vcore: null });

/** The overclock profile is the one the user validated with ClockTuner for Ryzen on Windows. */
export function defaultSettings(): Settings {
  return {
    version: 1,
    active: null,
    applyOnStart: true,
    profiles: [unset("underclock"), { id: "overclock", name: DEFAULT_NAMES.overclock, ccx: [4250, 4250, 4125, 4100], vcore: 1.25, cinebenchR20: 6916, powerW: 137 }],
  };
}

/** Both values are known, so a later step could apply it. */
export const isComplete = (p: Profile): boolean => p.ccx !== null && p.vcore !== null;

export function settingsFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "motherapp", "cpu.json");
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;

/** Validates one profile. Bad fields become "not set" and are reported, so nothing invented is shown. */
export function parseProfile(id: ProfileId, v: unknown, problems: string[]): Profile {
  const p = unset(id);
  if (v === undefined || v === null) return p;
  if (!isObj(v)) {
    problems.push(`"${id}" is not an object`);
    return p;
  }
  if (typeof v.name === "string" && v.name.trim() !== "") p.name = v.name.trim();
  if (Array.isArray(v.ccx) && v.ccx.length > 0 && v.ccx.length <= 16 && v.ccx.every((f) => num(f, 400, 7000))) p.ccx = v.ccx as number[];
  else if (v.ccx !== null && v.ccx !== undefined) problems.push(`"${id}": "ccx" must be null or list 1 to 16 frequencies in MHz (400-7000)`);
  if (num(v.vcore, 0.5, 2)) p.vcore = v.vcore;
  else if (v.vcore !== null && v.vcore !== undefined) problems.push(`"${id}": "vcore" must be null or volts (0.5-2.0)`);
  if (num(v.cinebenchR20, 0, 1e6)) p.cinebenchR20 = v.cinebenchR20;
  if (num(v.powerW, 0, 2000)) p.powerW = v.powerW;
  return p;
}

export function parseSettings(raw: unknown): { settings: Settings; problems: string[] } {
  const problems: string[] = [];
  const settings: Settings = { version: 1, active: null, applyOnStart: true, profiles: PROFILE_IDS.map(unset) };
  if (!isObj(raw)) return { settings, problems: ["it isn't a JSON object"] };
  const profiles = raw.profiles;
  if (profiles !== undefined && !isObj(profiles)) problems.push('"profiles" must be an object with "underclock" and "overclock"');
  const src = isObj(profiles) ? profiles : {};
  settings.profiles = PROFILE_IDS.map((id) => parseProfile(id, src[id], problems));
  for (const k of Object.keys(src)) if (!(PROFILE_IDS as readonly string[]).includes(k)) problems.push(`profile "${k}" ignored: only "underclock" and "overclock" exist`);
  if (raw.active === null || raw.active === undefined) settings.active = null;
  else if (typeof raw.active === "string" && (PROFILE_IDS as readonly string[]).includes(raw.active)) settings.active = raw.active as ProfileId;
  else problems.push(`"active" must be "underclock", "overclock" or null; treated as null`);
  if (typeof raw.applyOnStart === "boolean") settings.applyOnStart = raw.applyOnStart;
  else if (raw.applyOnStart !== undefined) problems.push('"applyOnStart" must be true or false; treated as true');
  const active = settings.profiles.find((p) => p.id === settings.active);
  if (active && !isComplete(active)) problems.push(`the active profile "${active.id}" has no values yet`);
  return { settings, problems };
}

/** The file's JSON shape (profiles as an object keyed by id). */
export function toFile(s: Settings): unknown {
  const profiles: Record<string, unknown> = {};
  for (const { id, ...rest } of s.profiles) profiles[id] = rest;
  return { version: s.version, active: s.active, applyOnStart: s.applyOnStart, profiles };
}

/** Pretty JSON for hand editing, with number lists on one line (`"ccx": [4250, 4250, 4125, 4100]`). */
export function formatSettings(s: Settings): string {
  return JSON.stringify(toFile(s), null, 2).replace(/\[\s+(-?[\d.]+(?:,\s+-?[\d.]+)*)\s+\]/g, (_m, nums: string) => `[${nums.split(/,\s+/).join(", ")}]`) + "\n";
}

/** Writes `data` atomically (temp file + rename), creating the directory. */
export function writeAtomic(file: string, data: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

/**
 * Reads the settings file. With `create`, a missing file is written with the defaults first.
 * A file that can't be parsed is reported and left alone (both profiles shown as not set).
 */
export function loadSettings(file: string, opts: { create?: boolean } = {}): Loaded {
  const empty = (): Settings => ({ version: 1, active: null, applyOnStart: true, profiles: PROFILE_IDS.map(unset) });
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") return { settings: empty(), problems: [`Can't read ${file}: ${(e as Error).message}`] };
    const settings = defaultSettings();
    if (!opts.create) return { settings, problems: [] };
    try {
      writeAtomic(file, formatSettings(settings));
      return { settings, created: true, problems: [] };
    } catch (w) {
      return { settings, problems: [`Can't create ${file}: ${(w as Error).message}`] };
    }
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { settings: empty(), problems: [`${file} isn't valid JSON (${(e as Error).message}): fix or delete it`] };
  }
  const { settings, problems } = parseSettings(raw);
  return { settings, problems: problems.map((p) => `${file}: ${p}`) };
}
