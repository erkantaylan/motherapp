// The manager: discovery, enabled set, one ToolHost per tool, events for the UI server.
// Holds no domain logic.
import { EventEmitter } from "node:events";
import type { JsonObject, JsonValue, ProgressParams, StateChange, ToolInfo } from "@motherapp/protocol";
import { loadConfig, saveConfig } from "./config.ts";
import type { Config } from "./config.ts";
import type { LogService } from "./logService.ts";
import { discoverTools } from "./manifest.ts";
import type { DiscoveredTool } from "./manifest.ts";
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
  config: Config = { port: 0, tools: {} };
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
    const info: ToolInfo = { id: host.id, title: m.title, enabled: this.isEnabled(host.id), status: host.status };
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

  list(): ToolInfo[] {
    return [...this.hosts.values()].map((h) => this.info(h));
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const host = this.host(id);
    this.config.tools[id] = { enabled };
    saveConfig(this.opts.configFile, this.config);
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
