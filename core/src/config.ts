// ~/.config/motherapp/config.json
import * as fs from "node:fs";
import * as path from "node:path";

export interface ToolConfig {
  enabled: boolean;
}

export interface Config {
  /** Listen port on 127.0.0.1. Default 7323. */
  port: number;
  /** Per-tool settings; tools missing here use their manifest's defaultEnabled (default true). */
  tools: Record<string, ToolConfig>;
  /**
   * Sidebar order set on the Settings page (issue #20). Missing or empty: the default order
   * (manifest `order` hints, then alphabetical). See `toolOrder.ts` for the merge rules.
   */
  order?: string[];
}

export const DEFAULT_PORT = 7323;

export function defaultConfig(): Config {
  return { port: DEFAULT_PORT, tools: {} };
}

/** A saved `order`: strings only, first occurrence wins. Anything that isn't an array is ignored. */
export function normalizeOrder(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const v of raw) if (typeof v === "string" && v !== "" && !out.includes(v)) out.push(v);
  return out;
}

function normalize(raw: unknown): Config {
  const cfg = defaultConfig();
  if (typeof raw !== "object" || raw === null) return cfg;
  const r = raw as Record<string, unknown>;
  if (typeof r.port === "number" && Number.isInteger(r.port) && r.port >= 0 && r.port < 65536) cfg.port = r.port;
  if (typeof r.tools === "object" && r.tools !== null) {
    for (const [id, t] of Object.entries(r.tools as Record<string, unknown>)) {
      if (typeof t === "object" && t !== null && typeof (t as ToolConfig).enabled === "boolean") {
        cfg.tools[id] = { enabled: (t as ToolConfig).enabled };
      }
    }
  }
  const order = normalizeOrder(r.order);
  if (order) cfg.order = order;
  return cfg;
}

/** Reads the config, creating the file with defaults when it is missing. */
export function loadConfig(file: string): { config: Config; created: boolean; error?: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      return { config: defaultConfig(), created: false, error: (e as Error).message };
    }
    const config = defaultConfig();
    saveConfig(file, config);
    return { config, created: true };
  }
  try {
    return { config: normalize(JSON.parse(raw)), created: false };
  } catch (e) {
    // Keep the broken file untouched so the user can fix it; run with defaults.
    return { config: defaultConfig(), created: false, error: `invalid JSON: ${(e as Error).message}` };
  }
}

function writeAtomic(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/** Writes `config` as the whole file (temp file + rename). Used to create the default file. */
export function saveConfig(file: string, config: Config): void {
  writeAtomic(file, config);
}

/**
 * Changes the file in place: reads it as it is now, lets `patch` edit the parsed object, and
 * writes it back atomically. Every key `patch` doesn't touch is kept, including ones the core
 * doesn't know. A file that isn't a JSON object is never overwritten: this throws instead, so
 * a hand-edited typo isn't replaced with defaults. A missing file starts as `{}`.
 */
export function updateConfigFile(file: string, patch: (raw: Record<string, unknown>) => void): void {
  let raw: Record<string, unknown> = {};
  let text: string | undefined;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (text !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      throw new Error(`${file} is not valid JSON (${(e as Error).message}); fix or delete it, then try again`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${file} is not a JSON object; fix or delete it, then try again`);
    }
    raw = parsed as Record<string, unknown>;
  }
  patch(raw);
  writeAtomic(file, raw);
}
