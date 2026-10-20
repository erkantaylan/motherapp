// When the motherapp core runs the inbox tool, `inboxctl` goes through it (the WebSocket the
// page uses), like `brightctl` does (tools/brightness/src/coreClient.ts): one process owns the
// links, the listener and the tunnel, and the page sees every change.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const TOOL_ID = "inbox";

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

export interface CoreConnection {
  state: Record<string, unknown>;
  action(name: string, args?: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

type Msg = { id?: number; method?: string; params?: any; result?: unknown; error?: { message: string } };

/** Resolves undefined when the core isn't reachable or the inbox tool isn't running there. */
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
    let state: Record<string, unknown> | undefined;
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
      get state() {
        return state!;
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
        if (!running) finish(undefined);
      } else if (m.method === "snapshot" && m.params?.tool === TOOL_ID) {
        state = m.params.state ?? {};
      }
      if (running && state) finish(conn);
    });
  });
}
