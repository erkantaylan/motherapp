// Tool SDK: implements `<tool> serve` (DESIGN.md § 4.6, § 4.7, § 4.12).
// See docs/extension-contract.md for the contract and an example.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Readable, Writable } from "node:stream";
import {
  ErrorCode,
  LineDecoder,
  RpcError,
  RpcPeer,
  StaleSet,
  applyChange,
  getPath,
  splitPath,
} from "@motherapp/protocol";
import type {
  ActionParams,
  DescribeResult,
  JsonObject,
  JsonValue,
  LogLevel,
  PageKind,
  RpcId,
  StateChange,
  StateGetResult,
  StateObject,
  StreamOpenParams,
  Widget,
} from "@motherapp/protocol";

export { RpcError, ErrorCode };
export type { JsonObject, JsonValue, Widget, StateObject };

export interface ToolOptions {
  id: string;
  title: string;
  icon?: string;
  page?: PageKind;
  layout?: Widget[];
  /** Values used when nothing is persisted yet. */
  initialState?: StateObject;
  /** Save last-known state to `$XDG_STATE_HOME/motherapp/<id>.json`. Default true. */
  persist?: boolean;
  /** Override the directory holding `<id>.json` (default `$XDG_STATE_HOME/motherapp`). */
  stateDir?: string;
  /** Debounce for state writes in ms. Default 500. */
  persistDelayMs?: number;
  /** Route console.log/info/debug/warn to `log` notifications while serving. Default true. */
  captureConsole?: boolean;
  /** Streams for testing; default process.stdin / process.stdout. */
  input?: Readable;
  output?: Writable;
}

export interface ActionContext {
  /** JSON-RPC id of this action request. */
  id: RpcId;
  /** Sends a `progress` notification for this action. */
  progress(text: string, fraction?: number): void;
}

export type ActionHandler = (args: JsonObject, ctx: ActionContext) => JsonValue | void | Promise<JsonValue | void>;

export interface StreamContext {
  /** Full stream name as opened, e.g. "level/42". */
  name: string;
  /** Part after the first "/", if any ("42"). */
  param?: string;
  emit(value: JsonValue): void;
}

/** Start producing values; return a function that stops. */
export type StreamHandler = (ctx: StreamContext) => (() => void) | void;

export interface Logger {
  debug(msg: string, fields?: JsonObject): void;
  info(msg: string, fields?: JsonObject): void;
  warn(msg: string, fields?: JsonObject): void;
  error(msg: string, fields?: JsonObject): void;
}

export function defaultStateDir(): string {
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(base, "motherapp");
}

interface PersistedFile {
  version: 1;
  state: StateObject;
}

export class Tool {
  readonly id: string;
  readonly log: Logger;
  private opts: ToolOptions;
  private state: StateObject;
  private stale = new StaleSet();
  private actions = new Map<string, ActionHandler>();
  private streams = new Map<string, StreamHandler>();
  private openStreams = new Map<string, () => void>();
  private pendingChanges: StateChange[] = [];
  private flushScheduled = false;
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private peer: RpcPeer | undefined;
  private out: Writable | undefined;
  private stopped = false;
  private loadError: string | undefined;
  private sweptTmp: string[] = [];
  private isWatched = false;
  private watchListeners = new Set<(watching: boolean) => void>();

  constructor(opts: ToolOptions) {
    this.opts = opts;
    this.id = opts.id;
    this.state = structuredClone(opts.initialState ?? {});
    const write = (level: LogLevel) => (msg: string, fields?: JsonObject) => this.sendLog(level, msg, fields);
    this.log = { debug: write("debug"), info: write("info"), warn: write("warn"), error: write("error") };
    if (opts.persist !== false) this.load();
  }

  /** Path of the persisted state file, or undefined when persistence is off. */
  get stateFile(): string | undefined {
    if (this.opts.persist === false) return undefined;
    return path.join(this.opts.stateDir ?? defaultStateDir(), `${this.id}.json`);
  }

  // ---- state ----

  get(p = ""): JsonValue | undefined {
    return getPath(this.state, p);
  }

  /** Sets a value and publishes it. Without `stale: true` the path becomes fresh. */
  set(p: string, value: JsonValue, opts: { stale?: boolean } = {}): void {
    if (splitPath(p).length === 0) throw new Error("set: path must not be empty");
    const change: StateChange = { path: p, value: structuredClone(value) };
    if (opts.stale) change.stale = true;
    this.change(change);
  }

  /** Removes the key at `p`. */
  delete(p: string): void {
    this.change({ path: p, value: null });
  }

  /** Marks a value unconfirmed (e.g. not re-read from hardware yet). */
  markStale(p: string): void {
    const value = this.get(p);
    this.change({ path: p, value: value === undefined ? null : value, stale: true });
  }

  /** Confirms the current value without changing it. */
  markFresh(p: string): void {
    if (!this.stale.isStale(p)) return;
    const value = this.get(p);
    this.change({ path: p, value: value === undefined ? null : value });
  }

  isStale(p: string): boolean {
    return this.stale.isStale(p);
  }

  /** The `state.get` reply: a copy of the full state and the stale paths. */
  snapshot(): StateGetResult {
    return { state: structuredClone(this.state), stale: this.stale.list() };
  }

  private change(c: StateChange): void {
    applyChange(this.state, c);
    this.stale.apply(c);
    this.pendingChanges.push(c);
    this.scheduleFlush();
    this.schedulePersist();
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      const changes = this.pendingChanges;
      this.pendingChanges = [];
      if (this.peer && changes.length > 0) this.peer.notify("state", { changes });
    });
  }

  // ---- registration ----

  action(name: string, handler: ActionHandler): this {
    this.actions.set(name, handler);
    return this;
  }

  /** Registers a stream. "level" also matches "level/<param>". */
  stream(name: string, handler: StreamHandler): this {
    this.streams.set(name, handler);
    return this;
  }

  // ---- persistence ----

  private load(): void {
    const file = this.stateFile;
    if (!file) return;
    // Leftovers of a save that was killed between write and rename (#29).
    const swept = sweepTmpFiles(path.dirname(file), path.basename(file));
    if (swept.length > 0) this.sweptTmp = swept;
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      return; // first run
    }
    try {
      const parsed = JSON.parse(raw) as PersistedFile;
      if (typeof parsed.state !== "object" || parsed.state === null) throw new Error("no state object");
      for (const [k, v] of Object.entries(parsed.state)) {
        this.state[k] = v;
        this.stale.mark(k);
      }
    } catch (e) {
      this.loadError = `ignoring unreadable state file ${file}: ${(e as Error).message}`;
    }
  }

  private schedulePersist(): void {
    if (this.opts.persist === false || this.stopped) return;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      this.save();
    }, this.opts.persistDelayMs ?? 500);
    this.persistTimer.unref?.();
  }

  /** Writes the state file now (atomically). */
  save(): void {
    const file = this.stateFile;
    if (!file) return;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      const data: PersistedFile = { version: 1, state: this.state };
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
      fs.renameSync(tmp, file);
    } catch (e) {
      process.stderr.write(`${this.id}: cannot save state: ${(e as Error).message}\n`);
    }
  }

  // ---- logging ----

  private sendLog(level: LogLevel, msg: string, fields?: JsonObject): void {
    if (this.peer) {
      this.peer.notify("log", fields ? { level, msg, fields } : { level, msg });
    } else {
      const extra = fields ? " " + JSON.stringify(fields) : "";
      process.stderr.write(`[${level}] ${msg}${extra}\n`);
    }
  }

  // ---- serve ----

  /**
   * Runs serve mode: JSON-RPC over stdin/stdout until stdin closes or SIGTERM/SIGINT.
   * Resolves after shutdown (state saved, streams closed).
   */
  serve(): Promise<void> {
    const input = this.opts.input ?? process.stdin;
    const output = this.opts.output ?? process.stdout;
    this.out = output;
    const decoder = new LineDecoder();
    this.peer = new RpcPeer({
      send: (msg) => {
        output.write(JSON.stringify(msg) + "\n");
      },
      onRequest: (method, params, ctx) => this.handle(method, params, ctx.id),
      onNotification: (method, params) => this.onNotification(method, params),
      onInvalid: (raw, reason) => process.stderr.write(`${this.id}: ignoring input (${reason}): ${raw.slice(0, 200)}\n`),
      timeoutMs: 0,
    });
    if (this.opts.captureConsole !== false) this.captureConsole();
    if (this.loadError) this.log.warn(this.loadError);
    if (this.sweptTmp.length > 0) this.log.info("removed leftover temp state files", { files: this.sweptTmp });
    // Changes made before serve() are part of the first state.get; don't resend them.
    this.pendingChanges = [];

    return new Promise<void>((resolve) => {
      const done = () => {
        this.shutdown();
        resolve();
      };
      input.setEncoding?.("utf8");
      input.on("data", (chunk: string | Buffer) => {
        for (const line of decoder.push(String(chunk))) this.peer?.receiveLine(line);
      });
      input.on("end", done);
      input.on("close", done);
      if (input === process.stdin) {
        // `on`, not `once`: with `once` the listener is gone after the first signal, Node
        // restores the default action, and a second SIGTERM (systemd's to the whole cgroup
        // plus the core's own) killed the tool in the middle of its final save, leaving an
        // empty `<id>.json.<pid>.tmp` behind (#29). Repeats are ignored while shutting down.
        let stopping = false;
        const onSignal = () => {
          if (stopping) return;
          stopping = true;
          done();
          process.exit(0);
        };
        process.on("SIGTERM", onSignal);
        process.on("SIGINT", onSignal);
      }
    });
  }

  private shutdown(): void {
    if (this.stopped) return;
    for (const stop of this.openStreams.values()) {
      try {
        stop();
      } catch {
        // ignore
      }
    }
    this.openStreams.clear();
    this.save();
    this.stopped = true;
  }

  // ---- watching ----

  /**
   * True while a visible browser tab shows this tool's page (the core's `watch` notification).
   * Poll only while this is true; actions and CLIs read fresh on their own.
   */
  get watching(): boolean {
    return this.isWatched;
  }

  /** Called on every change of `watching` (edges only). Returns a function that unsubscribes. */
  onWatch(listener: (watching: boolean) => void): () => void {
    this.watchListeners.add(listener);
    return () => this.watchListeners.delete(listener);
  }

  private onNotification(method: string, params: unknown): void {
    if (method !== "watch") return; // unknown notifications from the core are ignored
    const w = (params as { watching?: unknown } | undefined)?.watching;
    if (typeof w !== "boolean" || w === this.isWatched || this.stopped) return;
    this.isWatched = w;
    for (const l of [...this.watchListeners]) {
      try {
        l(w);
      } catch (e) {
        this.log.error(`watch listener failed: ${(e as Error).message}`);
      }
    }
  }

  private async handle(method: string, params: unknown, id: RpcId): Promise<unknown> {
    switch (method) {
      case "describe": {
        const d: DescribeResult = { title: this.opts.title, page: this.opts.page ?? "declarative" };
        if (this.opts.icon !== undefined) d.icon = this.opts.icon;
        if (this.opts.layout !== undefined) d.layout = this.opts.layout;
        return d;
      }
      case "state.get":
        return this.snapshot();
      case "action": {
        const p = params as ActionParams | undefined;
        if (!p || typeof p.name !== "string") throw new RpcError(ErrorCode.InvalidParams, "action: missing name");
        const handler = this.actions.get(p.name);
        if (!handler) throw new RpcError(ErrorCode.MethodNotFound, `unknown action: ${p.name}`);
        const ctx: ActionContext = {
          id,
          progress: (text, fraction) =>
            this.peer?.notify("progress", fraction === undefined ? { id, text } : { id, text, fraction }),
        };
        const result = await handler(p.args ?? {}, ctx);
        return result === undefined ? null : result;
      }
      case "stream.open": {
        const name = (params as StreamOpenParams | undefined)?.name;
        if (typeof name !== "string") throw new RpcError(ErrorCode.InvalidParams, "stream.open: missing name");
        if (this.openStreams.has(name)) return null;
        const slash = name.indexOf("/");
        const base = slash < 0 ? name : name.slice(0, slash);
        const handler = this.streams.get(name) ?? this.streams.get(base);
        if (!handler) throw new RpcError(ErrorCode.MethodNotFound, `unknown stream: ${name}`);
        const sctx: StreamContext = {
          name,
          emit: (value) => {
            if (this.openStreams.has(name)) this.peer?.notify("stream", { name, value });
          },
        };
        if (slash >= 0 && !this.streams.has(name)) sctx.param = name.slice(slash + 1);
        this.openStreams.set(name, () => {});
        const stop = handler(sctx);
        this.openStreams.set(name, stop ?? (() => {}));
        return null;
      }
      case "stream.close": {
        const name = (params as { name?: unknown } | undefined)?.name;
        if (typeof name !== "string") throw new RpcError(ErrorCode.InvalidParams, "stream.close: missing name");
        const stop = this.openStreams.get(name);
        this.openStreams.delete(name);
        stop?.();
        return null;
      }
      default:
        throw new RpcError(ErrorCode.MethodNotFound, `method not found: ${method}`);
    }
  }

  private captureConsole(): void {
    const fmt = (args: unknown[]) => args.map((a) => (typeof a === "string" ? a : safeJson(a))).join(" ");
    console.log = (...a: unknown[]) => this.log.info(fmt(a));
    console.info = (...a: unknown[]) => this.log.info(fmt(a));
    console.debug = (...a: unknown[]) => this.log.debug(fmt(a));
    console.warn = (...a: unknown[]) => this.log.warn(fmt(a));
    // console.error keeps writing to stderr, which the core records as level "error".
  }

  /** True once serve() has been called (useful for code shared with the plain CLI). */
  get serving(): boolean {
    return this.out !== undefined;
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

export function createTool(opts: ToolOptions): Tool {
  return new Tool(opts);
}

/**
 * For plain CLI subcommands, never for `serve` (there stdout is the JSON-RPC channel and the
 * core handles a dead pipe). When the reader goes away early (`audioctl list | head -1`), the
 * next write fails with EPIPE, and an unhandled stream `error` would end the CLI with a stack
 * trace and exit 1. Exit 0 quietly instead, like a coreutils tool killed by SIGPIPE does in a
 * pipeline. Any other stream error is still thrown. Defaults to process.stdout and stderr.
 */
export function exitOnBrokenPipe(...streams: Writable[]): void {
  const list = streams.length > 0 ? streams : [process.stdout, process.stderr];
  for (const s of list) {
    s.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "EPIPE") process.exit(0);
      throw e;
    });
  }
}

/** Matches `<base>.<pid>.tmp` and `<base>.<pid>.<hex>.tmp`, the temp names of atomic writes. */
function tmpPattern(base: string): RegExp {
  return new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.\\d+(?:\\.[0-9a-f]+)?\\.tmp$`);
}

/**
 * Removes temp files that an interrupted atomic write of `dir/<base>` left behind
 * (`<base>.<pid>.tmp`, `<base>.<pid>.<hex>.tmp`) once they are older than `maxAgeMs` (a younger
 * one may belong to a write in progress). Returns the names removed. Never throws.
 */
export function sweepTmpFiles(dir: string, base: string, maxAgeMs = 60_000, now = Date.now()): string[] {
  const re = tmpPattern(base);
  const removed: string[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (!re.test(name)) continue;
    const p = path.join(dir, name);
    try {
      const st = fs.lstatSync(p);
      if (!st.isFile() || now - st.mtimeMs < maxAgeMs) continue;
      fs.unlinkSync(p);
      removed.push(name);
    } catch {
      // gone already, or not ours to remove
    }
  }
  return removed;
}

/** Reads a tool's persisted state without starting it (for plain CLI subcommands). */
export function readPersistedState(id: string, stateDir = defaultStateDir()): StateObject | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(stateDir, `${id}.json`), "utf8")) as PersistedFile;
    return parsed.state;
  } catch {
    return undefined;
  }
}
