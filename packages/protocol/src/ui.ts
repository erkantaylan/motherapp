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
  /** The manifest's `wide`: the page gets the full width of a wide screen. */
  wide?: boolean;
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
  /** The latest GitHub release, compared with the running build's number (absent: no checker). */
  release?: ReleaseInfo;
}

/**
 * The latest GitHub release (tags `v<N>` on main), from the core's periodic check of
 * api.github.com (at start, every 6 h, and on demand). Cached; the last good answer is kept when
 * a later check fails, with `error` set.
 */
export interface ReleaseInfo {
  /** Its tag, e.g. "v3", or null when no check has succeeded yet. */
  latest: string | null;
  /** Its release page. */
  latestUrl: string | null;
  /** The latest release's number is higher than the running build's. */
  newer: boolean;
  /** When the last check finished (ISO 8601), or null before the first one. */
  checkedAt: string | null;
  /** Why the last check failed ("couldn't check: …" in the UI). */
  error?: string;
  /** `updateCheck: false` in config.json: no network check at all. */
  disabled?: boolean;
}

/**
 * Settings -> "Update now": `motherapp install`, run outside the service (a transient
 * `motherapp-update` systemd user unit) so it survives the restart it causes. Read back from
 * ~/.local/state/motherapp/update.log, so it is still there after that restart.
 */
export interface UpdateStatus {
  /** idle: no update has run (no log). done/failed: the last one finished. */
  state: "idle" | "running" | "done" | "failed";
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  /** The last lines of the log. */
  log: string;
  /** "v1-abc1234 → v2-def5678", or "already up to date (…)". */
  summary?: string;
  /** For "failed": the reason, e.g. motherapp's "refusing: the checkout has local changes". */
  message?: string;
}

// ---- network (DESIGN.md § 3 "Network", "Host names") ----

/** A network the user marked trusted on Settings (config.json `lan.trusted`). */
export interface TrustedNetwork {
  /** NetworkManager connection UUID. */
  uuid: string;
  /** Its NAME when it was trusted (shown only; the UUID and MAC decide). */
  name: string;
  /** MAC address of the default gateway when it was trusted, lowercase `aa:bb:cc:dd:ee:ff`. */
  gatewayMac: string;
}

/** The network holding the default route, as NetworkManager and `ip` see it. */
export interface ActiveNetwork {
  name?: string;
  uuid?: string;
  /** NetworkManager's TYPE, e.g. "802-3-ethernet", "802-11-wireless". */
  type?: string;
  device?: string;
  gatewayIp?: string;
  gatewayMac?: string;
  /** Why it can't be identified (then it never counts as trusted). */
  error?: string;
}

export interface NetworkInfo {
  /** The "Local network" switch (config.json `lan.enabled`). */
  lanEnabled: boolean;
  /** The core listens beyond loopback right now (switch on and a trusted network). */
  open: boolean;
  /** One line: "Open on Home", "Closed: not on a trusted network (Wired connection 1)", … */
  reason: string;
  /** The active network; null before the first look. */
  current: ActiveNetwork | null;
  /** The current network's UUID and gateway MAC match a trusted entry. */
  currentTrusted: boolean;
  trusted: TrustedNetwork[];
  /** URLs a LAN device can open while `open`, e.g. http://192.168.1.20:7323/. */
  addresses: string[];
  /** Accept `*.localhost` host names (portgate subdomains); config.json `localhostSubdomains`. */
  localhostSubdomains: boolean;
  /** This connection may change these settings (a loopback connection with a localhost name). */
  canChange: boolean;
}

// ---- notifications from tools (DESIGN.md § 3 "Notifications") ----

/** One notification a tool sent, as the core keeps it (the last 200, in memory only). */
export interface NotificationEntry {
  /** Monotonic sequence number within one core run. */
  seq: number;
  /** ISO 8601 timestamp. */
  ts: string;
  /** Tool id. */
  tool: string;
  /** The tool's display name when it was sent, e.g. "tmux". */
  toolTitle: string;
  /** The tool's icon as text (an emoji), when its manifest icon isn't a file. */
  toolIcon?: string;
  /** URL of the tool's icon when it is a file. */
  toolIconUrl?: string;
  /** The tool's kind id, e.g. "finished". */
  kind: string;
  /** The event, e.g. "Nebula finished". */
  title: string;
  body?: string;
  /** Recorded while "mute all" was on: no desktop popup and no sound went out. */
  muted?: boolean;
}

/** The sound name that means "play nothing". */
export const NO_SOUND = "none";

export interface NotificationKindSettings {
  id: string;
  label: string;
  enabled: boolean;
  /** The chosen sound: one of `NotificationSettings.sounds`, or "none". */
  sound: string;
  /** The manifest's default, for a "reset" in the UI. */
  defaultSound: string;
}

export interface NotificationToolSettings {
  id: string;
  title: string;
  icon?: string;
  iconUrl?: string;
  /** Off: nothing from this tool is delivered or recorded. */
  enabled: boolean;
  /** The kinds the tool's manifest declares, in that order. */
  kinds: NotificationKindSettings[];
}

/** What Settings shows and edits (config.json `notifications` merged with the manifests). */
export interface NotificationSettings {
  /** Mute all: no popups and no sounds; notifications are still recorded (`muted: true`). */
  muted: boolean;
  /** Every tool that declares notification kinds, in sidebar order. */
  tools: NotificationToolSettings[];
  /** The sound names that can be chosen besides "none" (the stock freedesktop sounds), sorted. */
  sounds: string[];
  /**
   * False when this core doesn't show popups or play sounds at all (MOTHERAPP_NOTIFY=off, or a
   * core started by a test). The history and the settings work as usual.
   */
  delivery: boolean;
}

// ---- tray icon (DESIGN.md § 3 "Tray icon") ----

/** The tray icon's setting and what became of it. */
export interface TrayInfo {
  /** The "Show tray icon" setting (config.json `tray`, default true). */
  enabled: boolean;
  /**
   * False when this core never shows one, whatever the setting says (MOTHERAPP_TRAY=off, or a
   * core started by a test). The setting can still be changed and is saved.
   */
  available: boolean;
  /**
   * off: not shown (turned off, or not `available`); starting: the helper is being started or
   * retried; running: the icon exists; failed: it can't be shown and the core stopped trying
   * (`message` says why; turning the setting off and on tries again).
   */
  state: "off" | "starting" | "running" | "failed";
  /** One line for the page: why it failed, is being retried, or isn't visible. */
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
  /**
   * Running build vs checkout, plus the latest release. Both are cached; `refresh` asks git
   * again, `checkRelease` asks GitHub again (Settings -> "Check for updates").
   */
  "version.get": { params: { refresh?: boolean; checkRelease?: boolean }; result: VersionInfo };
  /** Starts `motherapp install` outside the service. Fails when one is already running. */
  "update.start": { params: Record<string, never>; result: UpdateStatus };
  "update.status": { params: Record<string, never>; result: UpdateStatus };
  /** Network settings and state; `refresh` looks the active network up again. */
  "network.get": { params: { refresh?: boolean }; result: NetworkInfo };
  /** The changes below are refused unless `canChange` (loopback only, DESIGN.md § 4.3). */
  "network.setLan": { params: { enabled: boolean }; result: NetworkInfo };
  /** Trusts the current network (its UUID and gateway MAC); fails when it can't be identified. */
  "network.trust": { params: Record<string, never>; result: NetworkInfo };
  "network.untrust": { params: { uuid: string }; result: NetworkInfo };
  "network.setLocalhostSubdomains": { params: { enabled: boolean }; result: NetworkInfo };
  /**
   * Returns the notification history (oldest first, at most `limit`, default all 200) and starts
   * live `notification` pushes to this client. LAN clients may call it.
   */
  "notifications.subscribe": { params: { limit?: number }; result: { entries: NotificationEntry[] } };
  "notifications.unsubscribe": { params: Record<string, never>; result: null };
  "notifications.settings.get": { params: Record<string, never>; result: NotificationSettings };
  /**
   * The three changes below are saved in config.json (`notifications`), answer with the new
   * settings and push `notifications.settings` to every client. Like enabling a tool or
   * re-ordering, a LAN client may make them (all-or-none).
   */
  "notifications.setMuted": { params: { muted: boolean }; result: NotificationSettings };
  "notifications.setTool": { params: { tool: string; enabled: boolean }; result: NotificationSettings };
  /** `enabled` and `sound` are each optional; `sound` must be "none" or one of `sounds`. */
  "notifications.setKind": { params: { tool: string; kind: string; enabled?: boolean; sound?: string }; result: NotificationSettings };
  /**
   * Plays a sound on the computer the core runs on (the Settings play button). `sound` must be
   * one of `sounds`: a name, never a path. A new preview stops the one still playing.
   */
  "notifications.previewSound": { params: { sound: string }; result: null };
  "tray.get": { params: Record<string, never>; result: TrayInfo };
  /**
   * The "Show tray icon" toggle: saved in config.json (`tray`), applied at once, answered with
   * the new info and pushed to every client as `tray`. A LAN client may change it (all-or-none).
   */
  "tray.setEnabled": { params: { enabled: boolean }; result: TrayInfo };
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
  /** The version info changed (a periodic release check finished). */
  version: VersionInfo;
  /** A network setting or the LAN listener's state changed (`canChange` is per connection). */
  network: NetworkInfo;
  /** A tool notified. Only to clients that called `notifications.subscribe`. */
  notification: { entry: NotificationEntry };
  /** The notification settings changed (or a tool's title did). To every client. */
  "notifications.settings": NotificationSettings;
  /** The tray icon's setting or state changed. To every client. */
  tray: TrayInfo;
}
