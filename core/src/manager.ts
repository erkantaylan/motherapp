// The manager: discovery, enabled set, one ToolHost per tool, events for the UI server.
// Holds no domain logic.
import { EventEmitter } from "node:events";
import type { JsonObject, JsonValue, ProgressParams, StateChange, ToolInfo, TrustedNetwork } from "@motherapp/protocol";
import { NotificationService } from "./notifications.ts";
import type { NotifyingTool } from "./notifications.ts";
import { deliveryEnabled, DesktopDelivery } from "./notifyDelivery.ts";
import type { Delivery } from "./notifyDelivery.ts";
import { defaultConfig, loadConfig, updateConfigFile } from "./config.ts";
import type { Config } from "./config.ts";
import type { LogService } from "./logService.ts";
import { discoverAllTools } from "./manifest.ts";
import type { DiscoveredTool } from "./manifest.ts";
import { defaultOrder, mergeOrder, orderToSaveAmong } from "./toolOrder.ts";
import type { OrderableTool } from "./toolOrder.ts";
import { ToolHost } from "./toolHost.ts";
import type { Clock, SpawnFn } from "./toolHost.ts";
import type { RestartPolicyOptions } from "./restartPolicy.ts";
import { ToolHealth, Tray, trayAllowed } from "./tray.ts";
import type { TrayOptions, TrayView } from "./tray.ts";
import { ErrorCode, RpcError } from "@motherapp/protocol";

export interface ManagerOptions {
  toolsDir: string;
  /**
   * A second folder of tools, outside the checkout (DESIGN.md § 4.8); it need not exist.
   * Without it only `toolsDir` is scanned, so a Manager built by a test never reads the
   * user's own folder; main.ts passes paths.ts `externalToolsDir()`.
   */
  externalToolsDir?: string;
  configFile: string;
  log: LogService;
  clock?: Clock;
  spawn?: SpawnFn;
  policy?: RestartPolicyOptions;
  actionTimeoutMs?: number;
  /** Debounce of the last viewer leaving a tool's page (ToolHost `unwatchDelayMs`). */
  unwatchDelayMs?: number;
  /**
   * Popups and sounds for tools' notifications. Default: the desktop (notify-send/gdbus and
   * pw-play), switched off by MOTHERAPP_NOTIFY=off and under `node --test`.
   */
  delivery?: Delivery;
  /** The popup's icon (a file path or an icon name). */
  notifyIcon?: string;
  /**
   * The tray icon (tray.ts). Without `command` there is no helper to start, so a Manager built
   * by a test never shows one; main.ts passes the real command and "Open motherapp".
   */
  tray?: Partial<Pick<TrayOptions, "allowed" | "command" | "onOpen" | "spawn" | "env" | "clock" | "policy" | "killGraceMs">>;
}

export interface ManagerEvents {
  tools: [];
  /** A tool's "On the network" setting changed (after the `tools` event for it). */
  onNetwork: [string];
  snapshot: [ToolHost];
  state: [ToolHost, StateChange[]];
  stream: [ToolHost, string, JsonValue];
}

const ICON_FILE_RE = /\.(svg|png)$/i;

export class Manager extends EventEmitter<ManagerEvents> {
  readonly hosts = new Map<string, ToolHost>();
  config: Config = defaultConfig();
  /** Tools' notifications: settings, history and delivery (DESIGN.md § 3 "Notifications"). */
  readonly notifications: NotificationService;
  /** The tray icon: running or not, and the "Show tray icon" setting (DESIGN.md § 3 "Tray icon"). */
  readonly tray: Tray;
  private health = new ToolHealth();
  private opts: ManagerOptions;

  constructor(opts: ManagerOptions) {
    super();
    this.opts = opts;
    const log = opts.log;
    this.notifications = new NotificationService({
      store: {
        get: () => this.config.notifications,
        save: (next) => {
          this.patchConfig((raw) => {
            raw.notifications = next;
          });
          this.config.notifications = next;
        },
      },
      tools: () => this.order().map((id) => this.notifyingTool(this.hosts.get(id)!)),
      delivery:
        opts.delivery ??
        new DesktopDelivery({
          enabled: deliveryEnabled(),
          ...(opts.notifyIcon !== undefined ? { icon: opts.notifyIcon } : {}),
          warn: (msg) => log.core("warn", msg),
        }),
      log: (level, msg, fields, tool) => log.core(level, msg, fields, tool),
    });
    this.tray = new Tray({
      ...opts.tray,
      allowed: opts.tray?.command !== undefined && (opts.tray.allowed ?? trayAllowed()),
      command: opts.tray?.command ?? [],
      onOpen: opts.tray?.onOpen ?? (() => undefined),
      store: {
        get: () => this.config.tray,
        save: (enabled) => {
          this.patchConfig((raw) => {
            raw.tray = enabled;
          });
          this.config.tray = enabled;
        },
      },
      view: () => this.trayView(),
      // The same switch as Settings -> "Mute all": pages hear of it through onSettings.
      onMute: (muted) => void this.notifications.setMuted(muted),
      log: (level, msg, fields) => log.core(level, msg, fields),
    });
    this.on("tools", () => this.tray.refresh());
    this.notifications.onSettings(() => this.tray.refresh());
  }

  /** What the tray icon shows: tool health, and the tick on "Mute notifications". */
  trayView(): TrayView {
    return { ...this.health.update(this.list()), muted: this.config.notifications.muted };
  }

  /** A tool as the notification service sees it: identity from the core, kinds from the manifest. */
  private notifyingTool(host: ToolHost): NotifyingTool {
    const { id, title, icon, iconUrl } = this.info(host);
    return { id, title, kinds: host.manifest.notifications ?? [], ...(icon !== undefined ? { icon } : {}), ...(iconUrl !== undefined ? { iconUrl } : {}) };
  }

  /** Loads config, discovers tools, starts the enabled ones. */
  init(): void {
    const log = this.opts.log;
    const { config, created, error } = loadConfig(this.opts.configFile);
    this.config = config;
    if (created) log.core("info", "created default config", { file: this.opts.configFile });
    if (error) log.core("error", `config unreadable, using defaults: ${error}`, { file: this.opts.configFile });

    const found = discoverAllTools(this.opts.toolsDir, this.opts.externalToolsDir);
    for (const e of found.errors) log.core("error", `skipping tool: ${e.error}`, { dir: e.dir });
    for (const t of found.tools) this.addHost(t);
    log.core("info", `discovered ${found.tools.length} tool(s)`, {
      dir: this.opts.toolsDir,
      tools: found.tools.map((t) => t.manifest.id),
      ...(this.opts.externalToolsDir !== undefined
        ? { externalDir: this.opts.externalToolsDir, external: found.tools.filter((t) => t.external).map((t) => t.manifest.id) }
        : {}),
    });
    for (const host of this.hosts.values()) if (this.isEnabled(host.id)) host.start();
  }

  private addHost(t: DiscoveredTool): void {
    const host = new ToolHost({
      manifest: t.manifest,
      dir: t.dir,
      log: this.opts.log,
      ...(this.opts.clock ? { clock: this.opts.clock } : {}),
      ...(this.opts.spawn ? { spawn: this.opts.spawn } : {}),
      ...(this.opts.policy ? { policy: this.opts.policy } : {}),
      ...(this.opts.actionTimeoutMs ? { actionTimeoutMs: this.opts.actionTimeoutMs } : {}),
      ...(this.opts.unwatchDelayMs !== undefined ? { unwatchDelayMs: this.opts.unwatchDelayMs } : {}),
      events: {
        status: () => this.emit("tools"),
        snapshot: (h) => this.emit("snapshot", h),
        changes: (h, c) => this.emit("state", h, c),
        stream: (h, n, v) => this.emit("stream", h, n, v),
        notify: (h, params) => void this.notifications.submit(this.notifyingTool(h), params),
      },
    });
    this.hosts.set(host.id, host);
  }

  isEnabled(id: string): boolean {
    const enabled = this.config.tools[id]?.enabled;
    if (enabled !== undefined) return enabled;
    return this.hosts.get(id)?.manifest.defaultEnabled ?? true;
  }

  host(id: string): ToolHost {
    const h = this.hosts.get(id);
    if (!h) throw new RpcError(ErrorCode.UnknownTool, `unknown tool: ${id}`);
    return h;
  }

  info(host: ToolHost): ToolInfo {
    const m = host.manifest;
    // The tool's own describe title wins once it has started (the CPU tool says "CPU - AMD" or
    // "CPU - Intel" after detecting the vendor); before that, and if it never starts, the manifest's.
    const title = host.describe?.title || m.title;
    const info: ToolInfo = { id: host.id, title, enabled: this.isEnabled(host.id), status: host.status };
    if (m.icon !== undefined) {
      if (ICON_FILE_RE.test(m.icon)) info.iconUrl = `/tools/${host.id}/${m.icon}`;
      else info.icon = m.icon;
    }
    if (m.wide) info.wide = true;
    if (host.statusText) info.statusText = host.statusText;
    if (host.restartAt !== undefined) info.restartAt = host.restartAt;
    if (host.describe) {
      info.page = host.describe.page;
      if (host.describe.page === "declarative" && host.describe.layout) info.layout = host.describe.layout;
      if (host.describe.page === "custom" && m.page) info.pageUrl = `/tools/${host.id}/${m.page}`;
    }
    return info;
  }

  private orderable(): OrderableTool[] {
    return [...this.hosts.values()].map((h) => (h.manifest.order === undefined ? { id: h.id } : { id: h.id, order: h.manifest.order }));
  }

  /** Tool ids in display order (issue #20; rules in toolOrder.ts). */
  order(): string[] {
    return mergeOrder(this.orderable(), this.config.order);
  }

  /** True when the user has saved an order (so "Reset to default order" has something to do). */
  get orderSaved(): boolean {
    return (this.config.order?.length ?? 0) > 0;
  }

  /** The default order of the tools a client sees (see `resetOrder`). */
  private defaultOrderAmong(sees: (id: string) => boolean): string[] {
    return defaultOrder(this.orderable().filter((t) => sees(t.id)));
  }

  /**
   * `orderSaved` for a client that sees only some of the tools: would its "Reset to default
   * order" move anything it can see?
   */
  orderSavedAmong(sees: (id: string) => boolean): boolean {
    const current = this.order();
    if (current.every(sees)) return this.orderSaved;
    return current.filter(sees).join("\0") !== this.defaultOrderAmong(sees).join("\0");
  }

  /** Every tool, in display order. */
  list(): ToolInfo[] {
    return this.order().map((id) => this.info(this.hosts.get(id)!));
  }

  /**
   * Saves a new order as config.json's `order` (other keys kept). Unknown ids are dropped, and
   * tools the request left out follow in their current order. With `sees` (a client that sees
   * only some of the tools), the others keep their places and can't be named.
   */
  setOrder(requested: unknown, sees: (id: string) => boolean = () => true): void {
    let order: string[];
    try {
      order = orderToSaveAmong(requested, this.order(), sees);
    } catch (e) {
      throw new RpcError(ErrorCode.InvalidParams, (e as Error).message);
    }
    this.patchConfig((raw) => {
      raw.order = order;
    });
    this.config.order = order;
    this.opts.log.core("info", "tool order changed", { order });
    this.emit("tools");
  }

  /**
   * Forgets the saved order: back to the manifest hints, then alphabetical. For a client that
   * sees only some of the tools, only those go back to their default order, in the places they
   * hold now; the others don't move (which is a saved order again).
   */
  resetOrder(sees: (id: string) => boolean = () => true): void {
    if (!this.order().every(sees)) return this.setOrder(this.defaultOrderAmong(sees), sees);
    this.patchConfig((raw) => {
      delete raw.order;
    });
    delete this.config.order;
    this.opts.log.core("info", "tool order reset to default", { order: this.order() });
    this.emit("tools");
  }

  /** The network part of the config, for lan.ts. */
  networkConfig(): { lan: { enabled: boolean; trusted: TrustedNetwork[] }; localhostSubdomains: boolean } {
    return { lan: this.config.lan, localhostSubdomains: this.config.localhostSubdomains };
  }

  /** Edits config.json in place (other keys kept); a failure becomes an error for the caller. */
  patchConfig(patch: (raw: Record<string, unknown>) => void): void {
    try {
      updateConfigFile(this.opts.configFile, patch);
    } catch (e) {
      this.opts.log.core("error", `cannot save config: ${(e as Error).message}`, { file: this.opts.configFile });
      throw new RpcError(ErrorCode.ActionFailed, `Not saved: ${(e as Error).message}`);
    }
  }

  // ---- network settings (lan.ts is the NetworkStore user; other keys are kept) ----

  private patchLan(patch: (lan: Record<string, unknown>) => void): void {
    this.patchConfig((raw) => {
      const lan = typeof raw.lan === "object" && raw.lan !== null && !Array.isArray(raw.lan) ? (raw.lan as Record<string, unknown>) : {};
      patch(lan);
      raw.lan = lan;
    });
  }

  setLanEnabled(enabled: boolean): void {
    this.patchLan((lan) => {
      lan.enabled = enabled;
    });
    this.config.lan = { ...this.config.lan, enabled };
  }

  setTrusted(trusted: TrustedNetwork[]): void {
    this.patchLan((lan) => {
      lan.trusted = trusted.map((t) => ({ uuid: t.uuid, name: t.name, gatewayMac: t.gatewayMac }));
    });
    this.config.lan = { ...this.config.lan, trusted: [...trusted] };
  }

  setLocalhostSubdomains(enabled: boolean): void {
    this.patchConfig((raw) => {
      raw.localhostSubdomains = enabled;
    });
    this.config.localhostSubdomains = enabled;
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const host = this.host(id);
    this.patchConfig((raw) => {
      const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
      const tools = isObj(raw.tools) ? raw.tools : {};
      const prev = tools[id];
      tools[id] = { ...(isObj(prev) ? prev : {}), enabled };
      raw.tools = tools;
    });
    this.config.tools[id] = { ...this.config.tools[id], enabled };
    this.opts.log.core("info", enabled ? "enabled" : "disabled", undefined, id);
    if (enabled) host.start();
    else await host.stop();
    this.emit("tools");
  }

  /**
   * The "On the network" setting (DESIGN.md § 3 "Network switch scope"): false means the tool
   * doesn't exist for a LAN client. Default true; server.ts applies it.
   */
  isOnNetwork(id: string): boolean {
    return this.config.tools[id]?.network !== false;
  }

  /** The tools that are off the network. */
  offNetwork(): Set<string> {
    const out = new Set<string>();
    for (const id of this.hosts.keys()) if (!this.isOnNetwork(id)) out.add(id);
    return out;
  }

  /** Saves it as config.json `tools.<id>.network` (only `false` is stored; other keys kept). */
  setOnNetwork(id: string, onNetwork: boolean): void {
    this.host(id);
    if (this.isOnNetwork(id) === onNetwork) return;
    this.patchConfig((raw) => {
      const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
      const tools = isObj(raw.tools) ? raw.tools : {};
      const prev = tools[id];
      const next: Record<string, unknown> = { ...(isObj(prev) ? prev : {}) };
      if (onNetwork) delete next.network;
      else next.network = false;
      if (Object.keys(next).length > 0) tools[id] = next;
      else delete tools[id];
      raw.tools = tools;
    });
    const next = { ...this.config.tools[id] };
    if (onNetwork) delete next.network;
    else next.network = false;
    if (Object.keys(next).length > 0) this.config.tools[id] = next;
    else delete this.config.tools[id];
    // Logged under the tool, so a LAN client's logs page doesn't show it while the tool is hidden.
    this.opts.log.core("info", onNetwork ? "on the network again" : "taken off the network: LAN clients no longer see this tool", undefined, id);
    this.emit("tools");
    this.emit("onNetwork", id);
  }

  restart(id: string): void {
    const host = this.host(id);
    if (!this.isEnabled(id)) throw new RpcError(ErrorCode.ToolUnavailable, `${host.manifest.title} is disabled`);
    host.restart();
  }

  /** Is this action one only this computer may call (the manifest's `localActions`)? */
  isLocalAction(id: string, name: string): boolean {
    return this.host(id).manifest.localActions?.includes(name) === true;
  }

  action(id: string, name: string, args: JsonObject | undefined, onProgress?: (p: ProgressParams) => void): Promise<JsonValue> {
    return this.host(id).action(name, args, onProgress);
  }

  async shutdown(): Promise<void> {
    await Promise.all([this.tray.stop(), ...[...this.hosts.values()].map((h) => h.stop())]);
  }
}
