// Logs page filter. DOM-free.
import { LOG_LEVELS } from "@motherapp/protocol";
import type { LogEntry, LogLevel } from "@motherapp/protocol";

export interface LogFilter {
  /** Tool id, or "" for all. */
  tool: string;
  /** Minimum level. */
  level: LogLevel;
  /** Case-insensitive substring of msg, tool or fields. */
  text: string;
}

export const defaultFilter: LogFilter = { tool: "", level: "debug", text: "" };

export function matches(e: LogEntry, f: LogFilter): boolean {
  if (f.tool && e.tool !== f.tool) return false;
  if (LOG_LEVELS.indexOf(e.level) < LOG_LEVELS.indexOf(f.level)) return false;
  if (f.text) {
    const needle = f.text.toLowerCase();
    const hay = `${e.tool} ${e.msg} ${e.fields ? JSON.stringify(e.fields) : ""}`.toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  return true;
}
