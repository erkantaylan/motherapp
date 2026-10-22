// The manager: discovery, enabled set, one ToolHost per tool, events for the UI server.
// Holds no domain logic.
import { EventEmitter } from "node:events";
import type { JsonObject, JsonValue, ProgressParams, StateChange, ToolInfo, TrustedNetwork } from "@motherapp/protocol";
import { defaultConfig, loadConfig, updateConfigFile } from "./config.ts";
import type { Config } from "./config.ts";
import type { LogService } from "./logService.ts";
import { discoverTools } from "./manifest.ts";
import type { DiscoveredTool } from "./manifest.ts";
import { mergeOrder, orderToSave } from "./toolOrder.ts";
import { ToolHost } from "./toolHost.ts";
import type { Clock, SpawnFn } from "./toolHost.ts";
import type { RestartPolicyOptions } from "./restartPolicy.ts";
import { ErrorCode, RpcError } from "@motherapp/protocol";

export interface ManagerOptions {
  toolsDir: string;
  configFile: string;
  log: LogService;
  clock?: Clock;
  spawn?: SpawnFn;
  policy?: RestartPolicyOptions;
  actionTimeoutMs?: number;
  /** Debounce of the last viewer leaving a tool's page (ToolHost `unwatchDelayMs`). */
  unwatchDelayMs?: number;
}

export interface ManagerEvents {
  tools: [];
  snapshot: [ToolHost];
  state: [ToolHost, StateChange[]];
  stream: [ToolHost, string, JsonValue];
}

const ICON_FILE_RE = /\.(svg|png)$/i;

export class Manager extends EventEmitter<ManagerEvents> {
  readonly hosts = new Map<string, ToolHost>();
  config: Config = defaultConfig();
  private opts: ManagerOptions;

  constructor(opts: ManagerOptions) {
    super();
    this.opts = opts;
  }

  /** Loads config, discovers tools, starts the enabled ones. */
  init(): void {
    const log = this.opts.log;
    const { config, created, error } = loadConfig(this.opts.configFile);
    this.config = config;
    if (created) log.core("info", "created default config", { file: this.opts.configFile });
    if (error) log.core("error", `config unreadable, using defaults: ${error}`, { file: this.opts.configFile });

    const found = discoverTools(this.opts.toolsDir);
    for (const e of found.errors) log.core("error", `skipping tool: ${e.error}`, { dir: e.dir });
    for (const t of found.tools) this.addHost(t);
    log.core("info", `discovered ${found.tools.length} tool(s)`, {
      dir: this.opts.toolsDir,
      tools: found.tools.map((t) => t.manifest.id),
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
      },
    });
    this.hosts.set(host.id, host);
  }

  isEnabled(id: string): boolean {
    const t = this.config.tools[id];
    if (t) return t.enabled;
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
    if (host.statusText) info.statusText = host.statusText;
    if (host.restartAt !== undefined) info.restartAt = host.restartAt;
    if (host.describe) {
      info.page = host.describe.page;
      if (host.describe.page === "declarative" && host.describe.layout) info.layout = host.describe.layout;
      if (host.describe.page === "custom" && m.page) info.pageUrl = `/tools/${host.id}/${m.page}`;
    }
    return info;
  }

  /** Tool ids in display order (issue #20; rules in toolOrder.ts). */
  order(): string[] {
    const tools = [...this.hosts.values()].map((h) => (h.manifest.order === undefined ? { id: h.id } : { id: h.id, order: h.manifest.order }));
    return mergeOrder(tools, this.config.order);
  }

  /** True when the user has saved an order (so "Reset to default order" has something to do). */
  get orderSaved(): boolean {
    return (this.config.order?.length ?? 0) > 0;
  }

  /** Every tool, in display order. */
  list(): ToolInfo[] {
    return this.order().map((id) => this.info(this.hosts.get(id)!));
  }

  /**
   * Saves a new order as config.json's `order` (other keys kept). Unknown ids are dropped, and
   * tools the request left out follow in their current order.
   */
  setOrder(requested: unknown): void {
    let order: string[];
    try {
      order = orderToSave(requested, this.order());
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

  /** Forgets the saved order: back to the manifest hints, then alphabetical. */
  resetOrder(): void {
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
    this.config.tools[id] = { enabled };
    this.opts.log.core("info", enabled ? "enabled" : "disabled", undefined, id);
    if (enabled) host.start();
    else await host.stop();
    this.emit("tools");
  }

  restart(id: string): void {
    const host = this.host(id);
    if (!this.isEnabled(id)) throw new RpcError(ErrorCode.ToolUnavailable, `${host.manifest.title} is disabled`);
    host.restart();
  }

  action(id: string, name: string, args: JsonObject | undefined, onProgress?: (p: ProgressParams) => void): Promise<JsonValue> {
    return this.host(id).action(name, args, onProgress);
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.hosts.values()].map((h) => h.stop()));
  }
}
