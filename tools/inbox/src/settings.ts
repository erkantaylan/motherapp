// ~/.config/motherapp/inbox.json. Every field is optional; missing ones take the defaults.
//   { "port": 7324,
//     "tunnel": { "mode": "quick" } | { "mode": "named", "name": "motherapp", "hostname": "inbox.example.com" },
//     "sendDelayMs": 200, "verifyDelayMs": 600, "paneCommands": [] }
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type TunnelSettings = { mode: "quick" } | { mode: "named"; name: string; hostname: string };

export interface Settings {
  /** The inbox listener's port on 127.0.0.1 (0 = any free port, for tests). */
  port: number;
  tunnel: TunnelSettings;
  /** Wait between typing the text and pressing Enter. */
  sendDelayMs: number;
  /** Wait after Enter before checking that the input box cleared. */
  verifyDelayMs: number;
  /** Extra `pane_current_command` values that count as Claude (see panes.ts). */
  paneCommands: string[];
}

export const DEFAULT_PORT = 7324;

export function defaultSettings(): Settings {
  return { port: DEFAULT_PORT, tunnel: { mode: "quick" }, sendDelayMs: 200, verifyDelayMs: 600, paneCommands: [] };
}

export function settingsFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "motherapp", "inbox.json");
}

const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Validates tunnel settings from the page; throws a message for people. */
export function tunnelSettings(raw: unknown): TunnelSettings {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  if (r.mode === undefined || r.mode === "quick") return { mode: "quick" };
  if (r.mode !== "named") throw new Error('tunnel mode must be "quick" or "named"');
  const name = typeof r.name === "string" ? r.name.trim() : "";
  const hostname = typeof r.hostname === "string" ? r.hostname.trim().toLowerCase() : "";
  if (!NAME_RE.test(name)) throw new Error("a named tunnel needs its name (letters, digits, . _ -), as in `cloudflared tunnel list`");
  if (!HOST_RE.test(hostname)) throw new Error("a named tunnel needs a hostname like inbox.example.com");
  return { mode: "named", name, hostname };
}

const ms = (v: unknown, dflt: number) => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 10_000 ? v : dflt);

export function loadSettings(file: string, env: NodeJS.ProcessEnv = process.env): { settings: Settings; error?: string } {
  const s = defaultSettings();
  let error: string | undefined;
  try {
    const r = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    if (typeof r.port === "number" && Number.isInteger(r.port) && r.port >= 0 && r.port < 65536) s.port = r.port;
    try {
      s.tunnel = tunnelSettings(r.tunnel);
    } catch (e) {
      error = `${file}: ${(e as Error).message}; using a quick tunnel`;
    }
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

/** Writes only the tunnel part, keeping whatever else the user put in the file. */
export function saveTunnelSettings(file: string, tunnel: TunnelSettings): void {
  let r: Record<string, unknown> = {};
  try {
    r = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    // new file
  }
  r.tunnel = tunnel;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(r, null, 2) + "\n");
  fs.renameSync(tmp, file);
}
