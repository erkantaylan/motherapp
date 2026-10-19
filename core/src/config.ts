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
}

export const DEFAULT_PORT = 7323;

export function defaultConfig(): Config {
  return { port: DEFAULT_PORT, tools: {} };
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

export function saveConfig(file: string, config: Config): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n");
  fs.renameSync(tmp, file);
}
