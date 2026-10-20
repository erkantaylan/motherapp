// When the motherapp core is running with the brightness tool, `brightctl` goes through it
// (the same WebSocket the page uses) instead of opening the monitors itself. That keeps one
// owner of the I2C buses (ddcutil 1.4 has no cross-process locking), reuses the serve
// process's cached detection (no 1 s detect per key press), and the page sees the change.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const TOOL_ID = "brightness";

/** The core's port: $MOTHERAPP_PORT, else config.json's `port`, else 7323. */
export function corePort(env: NodeJS.ProcessEnv = process.env): number {
  if (env.MOTHERAPP_PORT) return Number(env.MOTHERAPP_PORT);
  const dir = path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "motherapp");
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8")) as { port?: unknown };
    if (typeof cfg.port === "number" && Number.isInteger(cfg.port) && cfg.port > 0) return cfg.port;
  } catch {
    // no config yet
  }
  return 7323;
}

export interface Snapshot {
  state: Record<string, unknown>;
  stale: string[];
}

export interface CoreConnection {
  snapshot: Snapshot;
  action(name: string, args?: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

type Msg = { id?: number; method?: string; params?: any; result?: unknown; error?: { message: string } };

/**
 * Connects to the core and waits for the brightness tool's snapshot. Resolves undefined when
 * the core isn't reachable or the tool isn't running there, so the caller can go direct.
 */
export function connectCore(port: number, timeoutMs = 2000): Promise<CoreConnection | undefined> {
  return new Promise((resolve) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    } catch {
      resolve(undefined);
      return;
    }
    let done = false;
    let running = false;
    let snapshot: Snapshot | undefined;
    const replies = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
    let nextId = 1;
    const finish = (v: CoreConnection | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (!v) ws.close();
      resolve(v);
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    const conn: CoreConnection = {
      get snapshot() {
        return snapshot!;
      },
      action(name, args = {}) {
        const id = nextId++;
        ws.send(JSON.stringify({ jsonrpc: "2.0", id, method: "action", params: { tool: TOOL_ID, name, args } }));
        return new Promise((res, rej) => replies.set(id, { resolve: res, reject: rej }));
      },
      close: () => ws.close(),
    };
    ws.addEventListener("error", () => finish(undefined));
    ws.addEventListener("close", () => {
      finish(undefined);
      for (const r of replies.values()) r.reject(new Error("the connection to motherapp closed"));
      replies.clear();
    });
    ws.addEventListener("message", (ev) => {
      let m: Msg;
      try {
        m = JSON.parse(String(ev.data)) as Msg;
      } catch {
        return;
      }
      if (m.id !== undefined && replies.has(m.id)) {
        const r = replies.get(m.id)!;
        replies.delete(m.id);
        if (m.error) r.reject(new Error(m.error.message));
        else r.resolve(m.result);
        return;
      }
      if (m.method === "tools") {
        const t = (m.params?.tools as { id: string; status: string }[] | undefined)?.find((x) => x.id === TOOL_ID);
        running = t?.status === "running";
        // Disabled, crashed or still starting: talk to the monitors directly instead.
        if (!running) finish(undefined);
      } else if (m.method === "snapshot" && m.params?.tool === TOOL_ID) {
        snapshot = { state: m.params.state ?? {}, stale: m.params.stale ?? [] };
      }
      if (running && snapshot) finish(conn);
    });
  });
}

export function isStalePath(stale: string[], p: string): boolean {
  return stale.some((s) => s === "" || s === p || p.startsWith(s + "."));
}
