// The inbox's own HTTP listener, on 127.0.0.1 only. cloudflared forwards to this port and to
// nothing else, so this is everything the tunnel exposes:
//   GET  /inbox/<token>   the skill (Markdown)
//   POST /inbox/<token>   deliver a message
// Every other path or method, and every unknown/revoked/expired token, gets the same
// 404, byte for byte. The token is checked before anything else (rate limit, body, JSON), so
// those other answers are only ever seen by a holder of a live token.
//
// Never logged: the request URL (it holds the token). X-Forwarded-* and the Host header are
// never read, and nothing here depends on who the client claims to be; Cf-Connecting-IP and
// User-Agent are only recorded in the delivery log (describeSender).
import * as http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Largest request body accepted. This is the only size limit on a message (there is no
 * per-link length option); the agent's skill states it.
 */
export const BODY_CAP = 32 * 1024;

export interface MessageBody {
  text: string;
  ref?: unknown;
}

/**
 * Who sent it, as cloudflared reports it (`Cf-Connecting-IP`) plus the `User-Agent`, for the
 * delivery log only (issue #16: through the tunnel every request comes from 127.0.0.1). Cleaned
 * and short; client-controlled, so never used for any decision.
 */
export function describeSender(headers: http.IncomingHttpHeaders): string {
  const one = (v: string | string[] | undefined, max: number) =>
    String(Array.isArray(v) ? v[0] : (v ?? ""))
      .replace(/[^\x20-\x7e]/g, "")
      .trim()
      .slice(0, max);
  const ip = one(headers["cf-connecting-ip"], 64);
  const ua = one(headers["user-agent"], 120);
  return [ip && `ip ${ip}`, ua && `ua ${ua}`].filter(Boolean).join(", ");
}

export interface Reply {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}

export interface InboxBackend {
  /** The id of the live link for this token, or undefined. Must not throw. */
  lookup(token: string): string | undefined;
  skill(linkId: string): string;
  /** Counts a message attempt; 0 if allowed, else ms until the next is. */
  rateLimit(linkId: string): number;
  message(linkId: string, body: MessageBody, from: string): Promise<Reply>;
  /** Called for unexpected errors (never with the URL or token). */
  onError?(msg: string): void;
}

const BASE_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
};

const NOT_FOUND = JSON.stringify({ error: "not found" }) + "\n";

function sendJson(res: http.ServerResponse, status: number, body: Record<string, unknown>, extra: Record<string, string> = {}): void {
  const data = JSON.stringify(body) + "\n";
  res.writeHead(status, { ...BASE_HEADERS, "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(data), ...extra });
  res.end(data);
}

/** The one 404. Closes the connection, since the request body (if any) is left unread. */
function notFound(res: http.ServerResponse): void {
  res.writeHead(404, { ...BASE_HEADERS, "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(NOT_FOUND), connection: "close" });
  res.end(NOT_FOUND);
}

/** `/inbox/<token>` → token; anything else → undefined. The query string is ignored. */
export function tokenFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const q = url.indexOf("?");
  const p = q < 0 ? url : url.slice(0, q);
  const m = /^\/inbox\/([A-Za-z0-9_-]{1,128})\/?$/.exec(p);
  return m ? m[1] : undefined;
}

function readBody(req: http.IncomingMessage, cap: number): Promise<Buffer | "too large"> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > cap) {
      resolve("too large");
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on("data", (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > cap) {
        done = true;
        resolve("too large");
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!done) resolve(Buffer.concat(chunks));
      done = true;
    });
    req.on("error", (e) => {
      if (!done) reject(e);
      done = true;
    });
  });
}

export function inboxHandler(backend: InboxBackend) {
  return async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    try {
      const token = tokenFromUrl(req.url);
      const method = req.method ?? "";
      if (token === undefined || (method !== "GET" && method !== "HEAD" && method !== "POST")) return notFound(res);
      const linkId = backend.lookup(token);
      if (linkId === undefined) return notFound(res);

      if (method === "GET" || method === "HEAD") {
        const md = backend.skill(linkId);
        res.writeHead(200, { ...BASE_HEADERS, "content-type": "text/markdown; charset=utf-8", "content-length": Buffer.byteLength(md) });
        res.end(method === "HEAD" ? undefined : md);
        return;
      }

      const wait = backend.rateLimit(linkId);
      if (wait > 0) {
        const secs = Math.max(1, Math.ceil(wait / 1000));
        return sendJson(res, 429, { error: "too many messages", retryAfter: secs }, { "retry-after": String(secs), connection: "close" });
      }
      const raw = await readBody(req, BODY_CAP);
      if (raw === "too large") return sendJson(res, 413, { error: `body larger than ${BODY_CAP} bytes` }, { connection: "close" });
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString("utf8"));
      } catch {
        return sendJson(res, 400, { error: "body must be JSON: {\"text\": \"...\", \"ref\": \"#10\"}" });
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || typeof (parsed as MessageBody).text !== "string") {
        return sendJson(res, 400, { error: "\"text\" must be a string" });
      }
      const reply = await backend.message(linkId, parsed as MessageBody, describeSender(req.headers));
      sendJson(res, reply.status, reply.body, reply.headers);
    } catch (e) {
      backend.onError?.(`inbox request failed: ${(e as Error).message}`);
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
      else res.destroy();
    }
  };
}

export interface InboxServer {
  port: number;
  close(): Promise<void>;
}

/** Listens on 127.0.0.1:<port> (0 = any free port). */
export function startInboxServer(backend: InboxBackend, port: number): Promise<InboxServer> {
  const handler = inboxHandler(backend);
  const server = http.createServer({ maxHeaderSize: 8192, requestTimeout: 15_000, headersTimeout: 10_000 }, (req, res) => void handler(req, res));
  server.keepAliveTimeout = 5000;
  server.maxConnections = 64;
  server.maxHeadersCount = 64;
  // Malformed requests: answer 400 without logging what was sent.
  server.on("clientError", (_e, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
    else socket.destroy();
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      server.on("error", (e) => backend.onError?.(`inbox listener: ${e.message}`));
      resolve({
        port: (server.address() as AddressInfo).port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}
