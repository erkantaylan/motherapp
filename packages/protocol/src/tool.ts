// Core <-> tool contract (DESIGN.md § 4.6, § 4.7, § 4.12).
// Transport: the tool's `serve` process, JSON-RPC 2.0, one message per line on stdin/stdout.
// Requests go core -> tool; notifications go tool -> core.

import type { JsonObject, JsonValue, RpcId } from "./jsonrpc.ts";
import type { Widget } from "./layout.ts";

/** `tools/<id>/manifest.json`. `serve` and `page` are relative to the tool's directory. */
export interface ToolManifest {
  id: string;
  title: string;
  icon?: string;
  /** Command line that starts serve mode, e.g. ["node", "demo.ts", "serve"]. */
  serve: string[];
  /** Custom page module (TS or JS, a default-exported custom element class). */
  page?: string;
  /** Enabled when first discovered. Default true. */
  defaultEnabled?: boolean;
  /**
   * Default sidebar position hint (lower first), used until the user re-orders the tools on
   * the Settings page. Tools without one follow, alphabetically.
   */
  order?: number;
}

export type StateObject = JsonObject;

export type PageKind = "declarative" | "custom";

// ---- requests (core -> tool) ----

export type DescribeParams = Record<string, never> | undefined;
export interface DescribeResult {
  title: string;
  icon?: string;
  page: PageKind;
  /** Required for declarative pages. */
  layout?: Widget[];
}

export type StateGetParams = Record<string, never> | undefined;
export interface StateGetResult {
  state: StateObject;
  /** Paths whose values are not confirmed yet (a path covers everything below it). */
  stale?: string[];
}

export interface ActionParams {
  name: string;
  args?: JsonObject;
}
/** Any JSON value; failures are JSON-RPC errors `{ code, message }`. */
export type ActionResult = JsonValue;

export interface StreamOpenParams {
  /** Stream name, optionally with a parameter after the first "/" (e.g. "level/42"). */
  name: string;
}
export interface StreamCloseParams {
  name: string;
}

export interface ToolRequests {
  describe: { params: DescribeParams; result: DescribeResult };
  "state.get": { params: StateGetParams; result: StateGetResult };
  action: { params: ActionParams; result: ActionResult };
  "stream.open": { params: StreamOpenParams; result: null };
  "stream.close": { params: StreamCloseParams; result: null };
}

// ---- notifications (tool -> core) ----

/**
 * One state change. `value: null` deletes the key at `path` (state never stores null).
 * `stale: true` sets the value but marks it unconfirmed; any change without `stale` marks the
 * path (and everything below it) fresh.
 */
export interface StateChange {
  path: string;
  value: JsonValue;
  stale?: boolean;
}

export interface StateParams {
  changes: StateChange[];
}

export interface ProgressParams {
  /** JSON-RPC id of the `action` request this progress belongs to. */
  id: RpcId;
  text: string;
  /** 0..1 */
  fraction?: number;
}

export interface StreamParams {
  name: string;
  value: JsonValue;
}

export type LogLevel = "debug" | "info" | "warn" | "error";
export const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

export interface LogParams {
  level: LogLevel;
  msg: string;
  fields?: JsonObject;
}

export interface ToolNotifications {
  state: StateParams;
  progress: ProgressParams;
  stream: StreamParams;
  log: LogParams;
}

// ---- notifications (core -> tool) ----

/**
 * Whether anyone is looking at the tool's page: a browser tab that has it open and visible.
 * Sent on edges only: `true` when the first viewer arrives (and after a (re)start while
 * someone is watching), `false` a few seconds after the last one left. A tool starts
 * unwatched. Tools that poll should poll only while watched (docs/extension-contract.md § 3).
 * A tool may ignore it.
 */
export interface WatchParams {
  watching: boolean;
}

export interface CoreNotifications {
  watch: WatchParams;
}
