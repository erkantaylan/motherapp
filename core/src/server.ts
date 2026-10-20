// HTTP + WebSocket server on 127.0.0.1 (DESIGN.md § 3: localhost only by default).
//   /ws               JSON-RPC channel to the browser (see @motherapp/protocol ui.ts)
//   /tools/<id>/...   files of a tool (custom page modules; .ts is served type-stripped)
//   /api/status       JSON for `motherapp status`: version info and each tool's state
//                     (?refresh=1 looks the checkout up again)
//   everything else   the built frontend (web/dist), index.html as fallback
import * as fs from "node:fs";
import * as http from "node:http";
import { stripTypeScriptTypes } from "node:module";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import { ErrorCode, RpcError, RpcPeer } from "@motherapp/protocol";
import type { JsonObject, UiNotifications, UiRequests } from "@motherapp/protocol";
import type { LogService } from "./logService.ts";
import type { Manager } from "./manager.ts";
import type { VersionSource } from "./version.ts";

export interface ServerOptions {
  manager: Manager;
  log: LogService;
  webDir: string;
  port: number;
  host?: string;
  /** Build and checkout info for `version.get` and /api/status. */
  version?: VersionSource;
}

export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

const TOOL_FILE_EXT = new Set([".ts", ".js", ".mjs", ".css", ".svg", ".png"]);
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function hostnameOf(hostHeader: string | undefined): string | undefined {
  if (!hostHeader) return undefined;
  try {
    return new URL(`http://${hostHeader}`).hostname;
  } catch {
    return undefined;
  }
}

/**
 * Guards against DNS rebinding (Host must be a loopback name) and cross-site WebSocket use
 * (a browser Origin, when present, must be a loopback origin).
 */
export function isAllowedRequest(headers: http.IncomingHttpHeaders): boolean {
  const host = hostnameOf(headers.host);
  if (!host || !LOCAL_HOSTNAMES.has(host)) return false;
  const origin = headers.origin;
  if (origin === undefined) return true;
  try {
    return LOCAL_HOSTNAMES.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/** Resolves `rel` inside `root`; undefined if it escapes. */
function safeJoin(root: string, rel: string): string | undefined {
  const full = path.resolve(root, "." + path.posix.normalize("/" + rel));
  return full === root || full.startsWith(root + path.sep) ? full : undefined;
}

function send(res: http.ServerResponse, status: number, body: string | Buffer, type = "text/plain; charset=utf-8"): void {
  res.writeHead(status, { "content-type": type, "cache-control": "no-cache", "x-content-type-options": "nosniff" });
  res.end(body);
}

export function startServer(opts: ServerOptions): Promise<RunningServer> {
  const { manager, log, webDir, version } = opts;
  const clients = new Set<Client>();

  const handleHttp = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    if (!isAllowedRequest(req.headers)) return send(res, 403, "forbidden");
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "method not allowed");
    let pathname: string;
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://x");
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return send(res, 400, "bad request");
    }

    if (pathname === "/api/status") {
      const refresh = url.searchParams.get("refresh") === "1";
      const tools = manager.list().map(({ id, title, enabled, status, statusText }) => ({ id, title, enabled, status, ...(statusText ? { statusText } : {}) }));
      void (version ? version.get(refresh) : Promise.resolve(null)).then(
        (v) => send(res, 200, JSON.stringify({ version: v, tools }) + "\n", MIME[".json"]),
        (e: Error) => send(res, 500, e.message),
      );
      return;
    }

    const toolMatch = /^\/tools\/([^/]+)\/(.+)$/.exec(pathname);
    if (toolMatch) {
      const host = manager.hosts.get(toolMatch[1]!);
      const file = host ? safeJoin(host.dir, toolMatch[2]!) : undefined;
      const ext = file ? path.extname(file) : "";
      if (!host || !file || !TOOL_FILE_EXT.has(ext) || !fs.existsSync(file)) return send(res, 404, "not found");
      try {
        let body: string | Buffer = fs.readFileSync(file);
        if (ext === ".ts") body = stripTypeScriptTypes(body.toString("utf8"), { mode: "strip" });
        return send(res, 200, body, MIME[ext]);
      } catch (e) {
        log.core("error", `cannot serve ${pathname}: ${(e as Error).message}`, undefined, host.id);
        return send(res, 500, (e as Error).message);
      }
    }

    let file = safeJoin(webDir, pathname);
    if (file && fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
    if (!file || !fs.existsSync(file)) {
      if (path.extname(pathname) !== "") return send(res, 404, "not found");
      file = path.join(webDir, "index.html"); // client-side routes
    }
    if (!fs.existsSync(file)) {
      return send(res, 503, "motherapp: frontend not built. Run `npm run build` (or use `npm run dev`).");
    }
    send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] ?? "application/octet-stream");
  };

  const server = http.createServer(handleHttp);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  server.on("upgrade", (req, socket, head) => {
    const pathname = new URL(req.url ?? "/", "http://x").pathname;
    if (pathname !== "/ws" || !isAllowedRequest(req.headers)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const client = new Client(ws, manager, log, version);
      clients.add(client);
      ws.on("close", () => {
        client.dispose();
        clients.delete(client);
      });
    });
  });

  const broadcast = <K extends keyof UiNotifications>(method: K, params: UiNotifications[K]) => {
    for (const c of clients) c.notify(method, params);
  };
  manager.on("tools", () => broadcast("tools", toolsNotification(manager)));
  manager.on("snapshot", (h) => broadcast("snapshot", { tool: h.id, state: h.state, stale: h.stale.list() }));
  manager.on("state", (h, changes) => broadcast("state", { tool: h.id, changes }));
  manager.on("stream", (h, name, value) => {
    for (const c of clients) if (c.hasStream(h.id, name)) c.notify("stream", { tool: h.id, name, value });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host ?? "127.0.0.1", () => {
      server.off("error", reject);
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            for (const c of clients) c.close();
            wss.close();
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}

function toolsNotification(manager: Manager): UiNotifications["tools"] {
  return { tools: manager.list(), orderSaved: manager.orderSaved };
}

/** One browser connection. */
class Client {
  private ws: WebSocket;
  private manager: Manager;
  private log: LogService;
  private peer: RpcPeer;
  private streams = new Set<string>();
  /** The tool whose page this tab shows while visible (`tool.watch`). */
  private watching: string | undefined;
  private unsubscribeLogs: (() => void) | undefined;
  private version: VersionSource | undefined;

  constructor(ws: WebSocket, manager: Manager, log: LogService, version?: VersionSource) {
    this.ws = ws;
    this.manager = manager;
    this.log = log;
    this.version = version;
    this.peer = new RpcPeer({
      send: (msg) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
      },
      onRequest: (method, params, ctx) => this.handle(method, (params ?? {}) as Record<string, unknown>, ctx.id),
      timeoutMs: 0,
    });
    ws.on("message", (data) => this.peer.receiveLine(data.toString()));
    this.notify("tools", toolsNotification(manager));
    for (const h of manager.hosts.values()) {
      if (h.hasSnapshot) this.notify("snapshot", { tool: h.id, state: h.state, stale: h.stale.list() });
    }
  }

  notify<K extends keyof UiNotifications>(method: K, params: UiNotifications[K]): void {
    this.peer.notify(method, params);
  }

  hasStream(tool: string, name: string): boolean {
    return this.streams.has(`${tool}\0${name}`);
  }

  private async handle(method: string, p: Record<string, unknown>, id: number | string): Promise<unknown> {
    const str = (k: string): string => {
      const v = p[k];
      if (typeof v !== "string") throw new RpcError(ErrorCode.InvalidParams, `${method}: "${k}" must be a string`);
      return v;
    };
    switch (method as keyof UiRequests) {
      case "action": {
        const tool = str("tool");
        const args = typeof p.args === "object" && p.args !== null ? (p.args as JsonObject) : undefined;
        return this.manager.action(tool, str("name"), args, (pr) => {
          const n: UiNotifications["progress"] = { tool, id, text: pr.text };
          if (pr.fraction !== undefined) n.fraction = pr.fraction;
          this.notify("progress", n);
        });
      }
      case "stream.open": {
        const tool = str("tool");
        const name = str("name");
        const key = `${tool}\0${name}`;
        const host = this.manager.host(tool);
        if (!this.streams.has(key)) {
          this.streams.add(key);
          host.openStream(name);
        }
        return null;
      }
      case "stream.close": {
        const tool = str("tool");
        const name = str("name");
        const key = `${tool}\0${name}`;
        if (this.streams.delete(key)) this.manager.hosts.get(tool)?.closeStream(name);
        return null;
      }
      case "tool.watch": {
        const tool = p.tool;
        if (tool !== null && typeof tool !== "string") throw new RpcError(ErrorCode.InvalidParams, `${method}: "tool" must be a string or null`);
        if (tool !== null) this.manager.host(tool); // unknown tool -> error, nothing changes
        this.setWatching(tool ?? undefined);
        return null;
      }
      case "logs.subscribe": {
        this.unsubscribeLogs?.();
        const limit = typeof p.limit === "number" ? p.limit : undefined;
        const entries = this.log.backlog(limit);
        // Subscribe after taking the backlog; both happen synchronously, so nothing is lost.
        this.unsubscribeLogs = this.log.subscribe((entry) => this.notify("log", { entry }));
        return { entries };
      }
      case "logs.unsubscribe":
        this.unsubscribeLogs?.();
        this.unsubscribeLogs = undefined;
        return null;
      case "tool.restart":
        this.manager.restart(str("tool"));
        return null;
      case "tool.setEnabled": {
        if (typeof p.enabled !== "boolean") throw new RpcError(ErrorCode.InvalidParams, "enabled must be a boolean");
        await this.manager.setEnabled(str("tool"), p.enabled);
        return null;
      }
      case "tools.setOrder":
        this.manager.setOrder(p.order);
        return null;
      case "tools.resetOrder":
        this.manager.resetOrder();
        return null;
      case "version.get":
        if (!this.version) throw new RpcError(ErrorCode.MethodNotFound, "version info not available");
        return this.version.get(p.refresh === true);
      default:
        throw new RpcError(ErrorCode.MethodNotFound, `method not found: ${method}`);
    }
  }

  private setWatching(tool: string | undefined): void {
    if (tool === this.watching) return;
    const before = this.watching;
    this.watching = tool;
    if (tool !== undefined) this.manager.hosts.get(tool)?.addViewer();
    if (before !== undefined) this.manager.hosts.get(before)?.removeViewer();
  }

  dispose(): void {
    this.setWatching(undefined);
    this.unsubscribeLogs?.();
    this.unsubscribeLogs = undefined;
    for (const key of this.streams) {
      const [tool, name] = key.split("\0") as [string, string];
      this.manager.hosts.get(tool)?.closeStream(name);
    }
    this.streams.clear();
    this.peer.close({ code: ErrorCode.InternalError, message: "connection closed" });
  }

  close(): void {
    this.ws.close();
  }
}
