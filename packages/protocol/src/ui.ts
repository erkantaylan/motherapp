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

// ---- version (DESIGN.md § 3 "Version scheme") ----

/** What the running core was built from (build-info.json). */
export interface BuildInfo {
  /** The hand-bumped number from VERSION, or "?". */
  version: string;
  /** Short git hash, or "unknown". */
  hash: string;
  dirty: boolean;
  /** ISO 8601, or null when unknown. */
  builtAt: string | null;
  /** v<version>-<hash>[-dirty], e.g. "v1-abc1234". */
  string: string;
  /** Why the info is unknown (build-info.json missing or broken). */
  error?: string;
}

/** Where the checkout's HEAD is now (cached by the core, refreshed on demand). */
export interface CheckoutInfo {
  /** Full commit hash, or null when git couldn't tell. */
  hash: string | null;
  short: string | null;
  version: string;
  /** v<version>-<short>, or null. */
  string: string | null;
  checkedAt: string;
  error?: string;
}

export interface VersionInfo {
  running: BuildInfo;
  checkout: CheckoutInfo;
  /** behind: the checkout has moved on since this build (run `motherapp install`). */
  status: "current" | "behind" | "unknown";
  /** For "behind": "running v1-abc1234, checkout is at v1-def5678, run `motherapp install`". */
  message?: string;
}

// ---- requests (browser -> core) ----

export interface UiRequests {
  action: { params: { tool: string; name: string; args?: JsonObject }; result: JsonValue };
  "stream.open": { params: { tool: string; name: string }; result: null };
  "stream.close": { params: { tool: string; name: string }; result: null };
  /**
   * The tool whose page this tab shows while the tab is visible, or null (another page, a
   * hidden tab). Replaces the tab's previous value; closing the socket counts as null. The
   * core turns the viewer count into `watch` edges for the tool.
   */
  "tool.watch": { params: { tool: string | null }; result: null };
  /** Returns the backlog (oldest first) and starts live `log` notifications to this client. */
  "logs.subscribe": { params: { limit?: number }; result: { entries: LogEntry[] } };
  "logs.unsubscribe": { params: Record<string, never>; result: null };
  /** Manual restart; also the way out of `failed`. */
  "tool.restart": { params: { tool: string }; result: null };
  "tool.setEnabled": { params: { tool: string; enabled: boolean }; result: null };
  /**
   * Saves the sidebar order (config.json `order`). Unknown ids are dropped; tools left out
   * follow in their current order. Every client then gets a `tools` notification.
   */
  "tools.setOrder": { params: { order: string[] }; result: null };
  /** Forgets the saved order (back to manifest `order` hints, then alphabetical). */
  "tools.resetOrder": { params: Record<string, never>; result: null };
  /** Running build vs checkout. The checkout is cached; `refresh` asks git again. */
  "version.get": { params: { refresh?: boolean }; result: VersionInfo };
}

// ---- notifications (core -> browser) ----

export interface UiNotifications {
  /**
   * Every tool, in display order (the user's order from Settings, else the default). Sent on
   * connect and to every client whenever a tool, its status or the order changes.
   * `orderSaved`: the user has saved an order (so "Reset to default order" would change it).
   */
  tools: { tools: ToolInfo[]; orderSaved?: boolean };
  /** Full cached state of one tool (on connect and after the tool (re)starts). */
  snapshot: { tool: string; state: StateObject; stale: string[] };
  state: { tool: string; changes: StateChange[] };
  stream: { tool: string; name: string; value: JsonValue };
  /** `id` is the id of the browser's own `action` request. */
  progress: { tool: string; id: RpcId; text: string; fraction?: number };
  log: { entry: LogEntry };
}
