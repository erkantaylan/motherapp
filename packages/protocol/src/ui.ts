// Browser <-> core contract over the WebSocket at /ws (JSON-RPC 2.0, one message per frame).
// The core pushes `tools` and one `snapshot` per tool right after connecting, then deltas.

import type { JsonObject, JsonValue, RpcId } from "./jsonrpc.ts";
import type { Widget } from "./layout.ts";
import type { LogLevel, PageKind, StateChange, StateObject } from "./tool.ts";

/**
 * stopped: disabled or not started; starting: spawned, waiting for describe/state.get;
 * running; down: exited, restart scheduled; failed: gave up (5 crashes in 2 min), needs a
 * manual restart.
 */
export type ToolStatus = "stopped" | "starting" | "running" | "down" | "failed";

export interface ToolInfo {
  id: string;
  title: string;
  icon?: string;
  /** URL of the icon when the manifest icon is a file (.svg/.png); otherwise use `icon` as text. */
  iconUrl?: string;
  enabled: boolean;
  status: ToolStatus;
  /** Human-readable detail for the status (last exit, next restart). */
  statusText?: string;
  /** Epoch ms of the scheduled restart while `down`. */
  restartAt?: number;
  /** Known after the first successful describe. */
  page?: PageKind;
  layout?: Widget[];
  /** Module URL for custom pages. */
  pageUrl?: string;
}

export interface LogEntry {
  /** Monotonic sequence number within one core run. */
  seq: number;
  /** ISO 8601 timestamp. */
  ts: string;
  level: LogLevel;
  /** Tool id, or "core" for entries about the core itself. */
  tool: string;
  /** Who wrote it: the core (about a tool or itself), the tool's `log` notification, or its stderr. */
  src: "core" | "tool" | "stderr";
  msg: string;
  fields?: JsonObject;
}

// ---- requests (browser -> core) ----

export interface UiRequests {
  action: { params: { tool: string; name: string; args?: JsonObject }; result: JsonValue };
  "stream.open": { params: { tool: string; name: string }; result: null };
  "stream.close": { params: { tool: string; name: string }; result: null };
  /** Returns the backlog (oldest first) and starts live `log` notifications to this client. */
  "logs.subscribe": { params: { limit?: number }; result: { entries: LogEntry[] } };
  "logs.unsubscribe": { params: Record<string, never>; result: null };
  /** Manual restart; also the way out of `failed`. */
  "tool.restart": { params: { tool: string }; result: null };
  "tool.setEnabled": { params: { tool: string; enabled: boolean }; result: null };
}

// ---- notifications (core -> browser) ----

export interface UiNotifications {
  tools: { tools: ToolInfo[] };
  /** Full cached state of one tool (on connect and after the tool (re)starts). */
  snapshot: { tool: string; state: StateObject; stale: string[] };
  state: { tool: string; changes: StateChange[] };
  stream: { tool: string; name: string; value: JsonValue };
  /** `id` is the id of the browser's own `action` request. */
  progress: { tool: string; id: RpcId; text: string; fraction?: number };
  log: { entry: LogEntry };
}
