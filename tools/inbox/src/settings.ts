// ~/.config/motherapp/inbox.json. Every field is optional; missing ones take the defaults.
//   { "port": 7324, "sendDelayMs": 200, "verifyDelayMs": 600, "paneCommands": [] }
// The tunnel is always a cloudflared quick tunnel (the user's decision, 2026-10-20), so there
// is nothing to configure for it. An old `"tunnel"` field is ignored.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface Settings {
  /** The inbox listener's port on 127.0.0.1 (0 = any free port, for tests). */
  port: number;
  /** Wait between typing the text and pressing Enter. */
  sendDelayMs: number;
  /** Wait after Enter before checking that the input box cleared. */
  verifyDelayMs: number;
  /** Extra `pane_current_command` values that count as Claude (see panes.ts). */
  paneCommands: string[];
}

export const DEFAULT_PORT = 7324;

export function defaultSettings(): Settings {
  return { port: DEFAULT_PORT, sendDelayMs: 200, verifyDelayMs: 600, paneCommands: [] };
}

export function settingsFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "motherapp", "inbox.json");
}

const ms = (v: unknown, dflt: number) => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 10_000 ? v : dflt);

export function loadSettings(file: string, env: NodeJS.ProcessEnv = process.env): { settings: Settings; error?: string } {
  const s = defaultSettings();
  let error: string | undefined;
  try {
    const r = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    if (typeof r.port === "number" && Number.isInteger(r.port) && r.port >= 0 && r.port < 65536) s.port = r.port;
    s.sendDelayMs = ms(r.sendDelayMs, s.sendDelayMs);
    s.verifyDelayMs = ms(r.verifyDelayMs, s.verifyDelayMs);
    if (Array.isArray(r.paneCommands)) s.paneCommands = r.paneCommands.filter((c): c is string => typeof c === "string" && c !== "" && c !== "node");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") error = `cannot read ${file}: ${(e as Error).message}`;
  }
  const envPort = env.MOTHERAPP_INBOX_PORT;
  if (envPort !== undefined && envPort !== "" && Number.isInteger(Number(envPort))) s.port = Number(envPort);
  return error ? { settings: s, error } : { settings: s };
}
