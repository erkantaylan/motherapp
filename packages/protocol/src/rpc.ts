// Small runtime shared by the core, the tool SDK and the browser: newline framing and a
// transport-agnostic JSON-RPC 2.0 peer. No Node or DOM APIs.

import { ErrorCode } from "./jsonrpc.ts";
import type { RpcErrorObject, RpcId, RpcMessage, RpcResponse } from "./jsonrpc.ts";

/** Splits a character stream into lines. Keeps the incomplete tail until more data arrives. */
export class LineDecoder {
  private buf = "";

  /** Returns the complete, non-empty lines in `chunk` (plus any buffered prefix). */
  push(chunk: string): string[] {
    this.buf += chunk;
    const parts = this.buf.split("\n");
    this.buf = parts.pop() ?? "";
    return parts.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l)).filter((l) => l.trim() !== "");
  }

  /** Returns the unterminated tail (if any) and clears it. */
  flush(): string[] {
    const rest = this.buf;
    this.buf = "";
    return rest.trim() === "" ? [] : [rest];
  }
}

/** Serializes one message as a single line (JSON.stringify never emits raw newlines). */
export function encodeLine(msg: RpcMessage): string {
  return JSON.stringify(msg) + "\n";
}

export class RpcError extends Error {
  code: number;
  data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
  toObject(): RpcErrorObject {
    return this.data === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, data: this.data };
  }
  static from(obj: RpcErrorObject): RpcError {
    return new RpcError(obj.code, obj.message, obj.data);
  }
}

export interface RequestContext {
  id: RpcId;
}

export interface RpcPeerOptions {
  send(msg: RpcMessage): void;
  /** Return (or resolve) the result; throw an RpcError (or any Error -> ActionFailed). */
  onRequest?(method: string, params: unknown, ctx: RequestContext): unknown;
  onNotification?(method: string, params: unknown): void;
  /** Called for lines that are not valid JSON-RPC (after replying with a parse error if possible). */
  onInvalid?(raw: string, reason: string): void;
  /** Default request timeout in ms; 0 disables. Default 30000. */
  timeoutMs?: number;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

interface Pending {
  resolve(v: unknown): void;
  reject(e: unknown): void;
  timer?: unknown;
}

export interface StartedRequest {
  id: RpcId;
  result: Promise<unknown>;
}

export class RpcPeer {
  private opts: RpcPeerOptions;
  private nextId = 1;
  private pending = new Map<RpcId, Pending>();
  private closed: RpcErrorObject | null = null;

  constructor(opts: RpcPeerOptions) {
    this.opts = opts;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /** Sends a request; returns its id right away, so progress for it can be matched. */
  start(method: string, params?: unknown, timeoutMs?: number): StartedRequest {
    const id = this.nextId++;
    if (this.closed) return { id, result: Promise.reject(RpcError.from(this.closed)) };
    const result = new Promise<unknown>((resolve, reject) => {
      const p: Pending = { resolve, reject };
      const ms = timeoutMs ?? this.opts.timeoutMs ?? 30000;
      if (ms > 0) {
        const set = this.opts.setTimer ?? ((fn, t) => setTimeout(fn, t));
        p.timer = set(() => {
          this.pending.delete(id);
          reject(new RpcError(ErrorCode.Timeout, `${method}: no reply after ${ms} ms`));
        }, ms);
      }
      this.pending.set(id, p);
    });
    const msg: RpcMessage = params === undefined
      ? { jsonrpc: "2.0", id, method }
      : { jsonrpc: "2.0", id, method, params };
    try {
      this.opts.send(msg);
    } catch (e) {
      this.settle(id, { jsonrpc: "2.0", id, error: { code: ErrorCode.InternalError, message: String(e) } });
    }
    return { id, result };
  }

  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    return this.start(method, params, timeoutMs).result;
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.opts.send(params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params });
  }

  /** Rejects every pending request with `error`; later requests fail immediately. */
  close(error: RpcErrorObject): void {
    this.closed = error;
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      this.clear(p);
      p.reject(RpcError.from(error));
    }
  }

  receiveLine(line: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      this.opts.onInvalid?.(line, "not JSON");
      return;
    }
    this.receive(msg, line);
  }

  receive(msg: unknown, raw?: string): void {
    if (Array.isArray(msg)) {
      for (const m of msg) this.receive(m);
      return;
    }
    if (typeof msg !== "object" || msg === null || (msg as { jsonrpc?: unknown }).jsonrpc !== "2.0") {
      this.opts.onInvalid?.(raw ?? JSON.stringify(msg), "not a JSON-RPC 2.0 message");
      return;
    }
    const m = msg as Record<string, unknown>;
    if (typeof m.method === "string") {
      if ("id" in m && (typeof m.id === "number" || typeof m.id === "string")) {
        void this.handleRequest(m.id, m.method, m.params);
      } else {
        this.opts.onNotification?.(m.method, m.params);
      }
      return;
    }
    if ("result" in m || "error" in m) {
      this.settle(m.id as RpcId, m as unknown as RpcResponse);
      return;
    }
    this.opts.onInvalid?.(raw ?? JSON.stringify(msg), "neither request nor response");
  }

  private async handleRequest(id: RpcId, method: string, params: unknown): Promise<void> {
    if (!this.opts.onRequest) {
      this.reply(id, undefined, { code: ErrorCode.MethodNotFound, message: `method not found: ${method}` });
      return;
    }
    try {
      const result = await this.opts.onRequest(method, params, { id });
      this.reply(id, result === undefined ? null : result);
    } catch (e) {
      this.reply(id, undefined, toErrorObject(e));
    }
  }

  private reply(id: RpcId, result: unknown, error?: RpcErrorObject): void {
    if (this.closed) return;
    try {
      this.opts.send(error ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result });
    } catch {
      // transport gone; nothing to do
    }
  }

  private settle(id: RpcId, res: RpcResponse): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    this.clear(p);
    if ("error" in res) p.reject(RpcError.from(res.error));
    else p.resolve(res.result);
  }

  private clear(p: Pending): void {
    if (p.timer !== undefined) (this.opts.clearTimer ?? ((h) => clearTimeout(h as number)))(p.timer);
  }
}

export function toErrorObject(e: unknown): RpcErrorObject {
  if (e instanceof RpcError) return e.toObject();
  if (e instanceof Error) return { code: ErrorCode.ActionFailed, message: e.message };
  return { code: ErrorCode.ActionFailed, message: String(e) };
}
