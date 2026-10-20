// App-wide client state: tool infos, one ToolStore per tool, streams, progress, logs.
import type { JsonObject, JsonValue, LogEntry, RpcId, ToolInfo, UiNotifications, VersionInfo } from "@motherapp/protocol";
import { Connection } from "./connection.ts";
import { ToolStore } from "./store.ts";

type ProgressCb = (text: string, fraction?: number) => void;

export class App {
  readonly conn: Connection;
  /** Every tool in display order, as the core sends it. */
  tools: ToolInfo[] = [];
  /** The user has saved an order on Settings (so "Reset to default order" would change it). */
  orderSaved = false;
  /** True once the first `tools` notification arrived. */
  toolsLoaded = false;
  private stores = new Map<string, ToolStore>();
  private toolListeners = new Set<() => void>();
  private streamCbs = new Map<string, Set<(v: JsonValue) => void>>();
  private progressCbs = new Map<RpcId, ProgressCb>();
  private logListeners = new Set<(e: LogEntry) => void>();
  /** Running build vs checkout; asked for on every (re)connect, since a restart may bring a new build. */
  version: VersionInfo | undefined;
  /** The build that was running when this page loaded (its code is that build's until a reload). */
  loadedBuild: string | undefined;
  private versionListeners = new Set<() => void>();

  constructor(url: string) {
    this.conn = new Connection(url, (method, params) => this.onNotify(method, params));
    this.conn.onState((connected) => {
      if (!connected) for (const s of this.stores.values()) s.setDown(true);
      this.emitTools();
    });
    // Re-open streams after a reconnect.
    this.conn.onOpen(() => {
      for (const key of this.streamCbs.keys()) {
        const [tool, name] = key.split("\0") as [string, string];
        this.conn.request("stream.open", { tool, name }).catch(() => {});
      }
      this.refreshVersion().catch(() => {});
    });
  }

  /**
   * Asks the core for its version info; `refresh` makes it look the checkout up again,
   * `checkRelease` asks GitHub for the latest release again.
   */
  refreshVersion(refresh = false, checkRelease = false): Promise<VersionInfo> {
    return this.conn.request("version.get", checkRelease ? { refresh, checkRelease } : { refresh }).then((v) => {
      this.setVersion(v);
      return v;
    });
  }

  private setVersion(v: VersionInfo): void {
    this.loadedBuild ??= v.running.string;
    this.version = v;
    for (const l of [...this.versionListeners]) l();
  }

  onVersion(l: () => void): () => void {
    this.versionListeners.add(l);
    return () => this.versionListeners.delete(l);
  }

  start(): void {
    this.conn.connect();
  }

  store(tool: string): ToolStore {
    let s = this.stores.get(tool);
    if (!s) {
      s = new ToolStore();
      this.stores.set(tool, s);
    }
    return s;
  }

  info(tool: string): ToolInfo | undefined {
    return this.tools.find((t) => t.id === tool);
  }

  onTools(l: () => void): () => void {
    this.toolListeners.add(l);
    return () => this.toolListeners.delete(l);
  }

  onLog(l: (e: LogEntry) => void): () => void {
    this.logListeners.add(l);
    return () => this.logListeners.delete(l);
  }

  private emitTools(): void {
    for (const l of [...this.toolListeners]) l();
  }

  private onNotify<K extends keyof UiNotifications>(method: K, params: UiNotifications[K]): void {
    switch (method) {
      case "tools": {
        const p = params as UiNotifications["tools"];
        this.tools = p.tools; // already in display order (the user's order from Settings)
        this.orderSaved = p.orderSaved === true;
        this.toolsLoaded = true;
        for (const t of this.tools) this.store(t.id).setDown(t.status !== "running");
        this.emitTools();
        break;
      }
      case "snapshot": {
        const p = params as UiNotifications["snapshot"];
        const s = this.store(p.tool);
        s.reset(p.state, p.stale);
        s.setDown(this.info(p.tool)?.status !== "running");
        break;
      }
      case "state": {
        const p = params as UiNotifications["state"];
        this.store(p.tool).apply(p.changes);
        break;
      }
      case "stream": {
        const p = params as UiNotifications["stream"];
        const cbs = this.streamCbs.get(`${p.tool}\0${p.name}`);
        if (cbs) for (const cb of cbs) cb(p.value);
        break;
      }
      case "progress": {
        const p = params as UiNotifications["progress"];
        this.progressCbs.get(p.id)?.(p.text, p.fraction);
        break;
      }
      case "log": {
        const p = params as UiNotifications["log"];
        for (const l of this.logListeners) l(p.entry);
        break;
      }
      case "version":
        // A periodic release check finished ("v3 available").
        this.setVersion(params as UiNotifications["version"]);
        break;
    }
  }

  action(tool: string, name: string, args?: JsonObject, onProgress?: ProgressCb): Promise<JsonValue> {
    const params = args === undefined ? { tool, name } : { tool, name, args };
    const { id, result } = this.conn.start("action", params);
    if (onProgress) this.progressCbs.set(id, onProgress);
    return result.finally(() => this.progressCbs.delete(id));
  }

  /** Opens a stream (shared between callers); returns the close function. */
  openStream(tool: string, name: string, cb: (v: JsonValue) => void): () => void {
    const key = `${tool}\0${name}`;
    let cbs = this.streamCbs.get(key);
    if (!cbs) {
      cbs = new Set();
      this.streamCbs.set(key, cbs);
      this.conn.request("stream.open", { tool, name }).catch(() => {});
    }
    cbs.add(cb);
    return () => {
      const set = this.streamCbs.get(key);
      if (!set) return;
      set.delete(cb);
      if (set.size === 0) {
        this.streamCbs.delete(key);
        this.conn.request("stream.close", { tool, name }).catch(() => {});
      }
    };
  }
}
