// What a LAN client is shown of the things that name tools, when some tools are off the network
// (DESIGN.md § 3 "Network switch scope"; the setting is manager.ts `isOnNetwork`, and server.ts
// decides per connection). Pure functions.
import type { JsonValue, LogEntry, NotificationSettings } from "@motherapp/protocol";

function mentions(v: JsonValue | undefined, ids: ReadonlySet<string>): boolean {
  if (typeof v === "string") return ids.has(v);
  if (Array.isArray(v)) return v.some((x) => mentions(x, ids));
  if (typeof v === "object" && v !== null) return Object.entries(v).some(([k, x]) => ids.has(k) || mentions(x, ids));
  return false;
}

/**
 * May a client that can't see the tools in `hidden` get this log entry? Not an entry of one of
 * those tools, and not one of the core's own that names one: as a whole word in the message
 * ('external tool id "x" is taken…') or as a value or key anywhere in its fields ("discovered 7
 * tool(s)" lists every id, "tool order changed" too). The whole entry is left out, not cut:
 * erring towards hiding is the safe side.
 */
export function logEntryVisible(entry: LogEntry, hidden: ReadonlySet<string>): boolean {
  if (hidden.size === 0) return true;
  if (entry.tool !== "core") return !hidden.has(entry.tool);
  if (mentions(entry.fields, hidden)) return false;
  // Tool ids are [a-z0-9_-]+ (manifest.ts), so that is what a "word" is here.
  for (const word of entry.msg.split(/[^a-z0-9_-]+/)) if (hidden.has(word)) return false;
  return true;
}

/** The notification settings without the rows of tools the client can't see. */
export function visibleNotificationSettings(s: NotificationSettings, sees: (id: string) => boolean): NotificationSettings {
  return s.tools.every((t) => sees(t.id)) ? s : { ...s, tools: s.tools.filter((t) => sees(t.id)) };
}

/** The newest `limit` of `items` (all of them without a limit), as RingBuffer.toArray counts. */
export function newest<T>(items: T[], limit: number | undefined): T[] {
  if (limit === undefined) return items;
  const n = Math.floor(Math.min(limit, items.length));
  return n > 0 ? items.slice(items.length - n) : [];
}
