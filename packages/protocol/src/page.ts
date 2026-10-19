/// <reference lib="dom" />
// Custom page API (DESIGN.md § 4.1). Browser-only, so it is a separate entry point:
//   import type { PageContext, PageElement } from "@motherapp/protocol/page";
//
// A custom page module (manifest `page`) default-exports a custom element class. The shell
// defines it as `ma-page-<tool id>`, sets `ctx` on the instance, then attaches it. Use the
// shared CSS variables (--fg, --bg, --muted, --accent, --border, --surface, ...) for theme.

import type { JsonObject, JsonValue } from "./jsonrpc.ts";
import type { Widget } from "./layout.ts";
import type { ToolInfo } from "./ui.ts";

export interface PageContext {
  readonly toolId: string;
  /** Current tool info (status etc.). */
  info(): ToolInfo | undefined;
  /** Cached value at `path` ("" for the whole state). */
  get(path?: string): JsonValue | undefined;
  /** True when the value is stale (tool marked it, the tool is down, or the UI is disconnected). */
  isStale(path: string): boolean;
  /** Called with the current value now and after every change at, above or below `path`. */
  subscribe(path: string, cb: (value: JsonValue | undefined) => void): () => void;
  action(name: string, args?: JsonObject, onProgress?: (text: string, fraction?: number) => void): Promise<JsonValue>;
  /** Opens a tool stream; returns the close function. */
  openStream(name: string, cb: (value: JsonValue) => void): () => void;
  /** Renders declarative widgets into `container`; returns a cleanup function. */
  render(widgets: Widget[], container: HTMLElement): () => void;
}

export interface PageElement extends HTMLElement {
  ctx?: PageContext;
}
