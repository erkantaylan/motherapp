// One tool's serve process: spawn, handshake (describe + state.get), state cache, action
// forwarding, stream ref-counting, viewer counting (`watch` edges), stderr capture and crash
// restarts (DESIGN.md § 4.6–4.9).
import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import * as path from "node:path";
import {
  ErrorCode,
  LOG_LEVELS,
  LineDecoder,
  RpcError,
  RpcPeer,
  StaleSet,
  applyChange,
} from "@motherapp/protocol";
import type {
  DescribeResult,
  JsonObject,
  JsonValue,
  LogLevel,
  LogParams,
  ProgressParams,
  RpcId,
  StateChange,
  StateGetResult,
  StateObject,
  StateParams,
  StreamParams,
  ToolManifest,
  ToolStatus,
} from "@motherapp/protocol";
import type { LogService } from "./logService.ts";
import { RestartPolicy } from "./restartPolicy.ts";
import type { RestartPolicyOptions } from "./restartPolicy.ts";

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export type SpawnFn = (cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcess;

export interface ToolHostEvents {
  status(host: ToolHost): void;
  snapshot(host: ToolHost): void;
  changes(host: ToolHost, changes: StateChange[]): void;
  stream(host: ToolHost, name: string, value: JsonValue): void;
}

export interface ToolHostOptions {
  manifest: ToolManifest;
  dir: string;
  log: LogService;
  events: ToolHostEvents;
  clock?: Clock;
  spawn?: SpawnFn;
  policy?: RestartPolicyOptions;
  /** Timeout for describe and state.get. Default 10 s. */
  handshakeTimeoutMs?: number;
  /** Timeout for actions. Default 30 s. */
  actionTimeoutMs?: number;
  /** Grace period between SIGTERM and SIGKILL when stopping. Default 3 s. */
  killGraceMs?: number;
  /** How long the last viewer must be gone before the tool hears `watch {watching: false}`. Default 5 s. */
  unwatchDelayMs?: number;
}

export const UNWATCH_DELAY_MS = 5000;

const defaultSpawn: SpawnFn = (cmd, args, opts) =>
  nodeSpawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"] });

/** Resolves the serve command: "node" means the Node running the core; "./x" is tool-relative. */
export function resolveCommand(serve: string[], dir: string, execPath = process.execPath): { cmd: string; args: string[] } {
  const [first, ...rest] = serve;
  if (first === "node") return { cmd: execPath, args: ["--disable-warning=ExperimentalWarning", ...rest] };
  const cmd = first!.includes("/") ? path.resolve(dir, first!) : first!;
  return { cmd, args: rest };
}

export class ToolHost {
  readonly id: string;
  readonly manifest: ToolManifest;
  readonly dir: string;
  status: ToolStatus = "stopped";
  statusText: string | undefined;
  restartAt: number | undefined;
  describe: DescribeResult | undefined;
  /** Cached latest full state; survives crashes (shown stale while the tool is down). */
  state: StateObject = {};
  stale = new StaleSet();
  hasSnapshot = false;

  private opts: ToolHostOptions;
  private clock: Clock;
  private policy: RestartPolicy;
  private child: ChildProcess | undefined;
  private peer: RpcPeer | undefined;
  private generation = 0;
  private restartTimer: unknown;
  /** Why the current child is being killed on purpose. */
  private intent: "stop" | "restart" | null = null;
  private exitWaiters: (() => void)[] = [];
  private streamRefs = new Map<string, number>();
  private progress = new Map<RpcId, (p: ProgressParams) => void>();
  /** Visible browser tabs showing this tool's page. */
  private viewers = 0;
  /** What the current process was last told (it starts unwatched). */
  private watchSent = false;
  private unwatchTimer: unknown;

  constructor(opts: ToolHostOptions) {
    this.opts = opts;
    this.id = opts.manifest.id;
    this.manifest = opts.manifest;
    this.dir = opts.dir;
    this.clock = opts.clock ?? realClock;
    this.policy = new RestartPolicy(opts.policy);
  }

  get running(): boolean {
    return this.status === "running";
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  private log(level: LogLevel, msg: string, fields?: JsonObject): void {
    this.opts.log.core(level, msg, fields, this.id);
  }

  private setStatus(status: ToolStatus, text?: string): void {
    this.status = status;
    this.statusText = text;
    if (status !== "down") this.restartAt = undefined;
    this.opts.events.status(this);
  }

  /** Starts the tool if it isn't running or scheduled. */
  start(): void {
    if (this.child) return;
    this.cancelRestartTimer();
    this.spawnChild();
  }

  /** Manual restart: clears the crash history (the way out of `failed`). */
  restart(): void {
    this.policy.reset();
    this.cancelRestartTimer();
    this.log("info", "restart requested");
    if (this.child) {
      this.intent = "restart";
      this.child.kill("SIGTERM");
      this.scheduleKill(this.generation);
    } else {
      this.spawnChild();
    }
  }

  /** Stops the tool (disable or shutdown). Resolves once the process has exited. */
  stop(): Promise<void> {
    this.cancelRestartTimer();
    this.cancelUnwatchTimer();
    if (!this.child) {
      if (this.status !== "stopped") this.setStatus("stopped");
      return Promise.resolve();
    }
    this.intent = "stop";
    const done = new Promise<void>((resolve) => this.exitWaiters.push(resolve));
    this.child.kill("SIGTERM");
    this.scheduleKill(this.generation);
    return done;
  }

  private scheduleKill(gen: number): void {
    const t = setTimeout(() => {
      if (gen === this.generation && this.child) this.child.kill("SIGKILL");
    }, this.opts.killGraceMs ?? 3000);
    t.unref();
  }

  private cancelRestartTimer(): void {
    if (this.restartTimer !== undefined) this.clock.clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
  }

  private spawnChild(): void {
    const gen = ++this.generation;
    this.intent = null;
    const { cmd, args } = resolveCommand(this.manifest.serve, this.dir);
    this.setStatus("starting");
    this.log("info", "starting", { cmd: [cmd, ...args].join(" ") });
    let child: ChildProcess;
    try {
      child = (this.opts.spawn ?? defaultSpawn)(cmd, args, {
        cwd: this.dir,
        env: { ...process.env, MOTHERAPP_TOOL_ID: this.id },
      });
    } catch (e) {
      this.onExit(gen, null, null, e as Error);
      return;
    }
    this.child = child;
    this.policy.recordStart(this.clock.now());

    const peer = new RpcPeer({
      send: (msg) => {
        child.stdin?.write(JSON.stringify(msg) + "\n");
      },
      onNotification: (method, params) => {
        if (gen === this.generation) this.onNotification(method, params);
      },
      onInvalid: (raw, reason) => this.log("warn", `ignoring tool output (${reason})`, { line: raw.slice(0, 500) }),
      timeoutMs: this.opts.actionTimeoutMs ?? 30_000,
    });
    this.peer = peer;

    const out = new LineDecoder();
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      for (const line of out.push(chunk)) peer.receiveLine(line);
    });
    const err = new LineDecoder();
    const writeErr = (lines: string[]) => {
      for (const line of lines) this.opts.log.add(this.id, "stderr", "error", line);
    };
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => writeErr(err.push(chunk)));
    child.stderr?.on("end", () => writeErr(err.flush()));
    child.stdin?.on("error", () => {
      // EPIPE when the tool dies; the exit handler deals with it
    });
    child.on("error", (e) => this.onExit(gen, null, null, e));
    child.on("exit", (code, signal) => this.onExit(gen, code, signal));

    void this.handshake(gen, peer);
  }

  private async handshake(gen: number, peer: RpcPeer): Promise<void> {
    const timeout = this.opts.handshakeTimeoutMs ?? 10_000;
    try {
      const d = (await peer.request("describe", undefined, timeout)) as DescribeResult;
      if (typeof d !== "object" || d === null || (d.page !== "declarative" && d.page !== "custom")) {
        throw new Error("describe: invalid result");
      }
      const snap = (await peer.request("state.get", undefined, timeout)) as StateGetResult;
      if (typeof snap !== "object" || snap === null || typeof snap.state !== "object" || snap.state === null) {
        throw new Error("state.get: invalid result");
      }
      if (gen !== this.generation) return;
      this.describe = d;
      this.state = snap.state;
      this.stale.reset(Array.isArray(snap.stale) ? snap.stale.filter((p) => typeof p === "string") : []);
      this.hasSnapshot = true;
      this.setStatus("running");
      this.log("info", "started", { pid: this.child?.pid ?? null });
      this.opts.events.snapshot(this);
      for (const [name, n] of this.streamRefs) if (n > 0) this.sendStream("stream.open", name);
      this.watchSent = false;
      if (this.viewers > 0) this.sendWatch(true);
    } catch (e) {
      if (gen !== this.generation || !this.child) return;
      this.log("error", `handshake failed: ${(e as Error).message}`);
      this.child.kill("SIGKILL"); // counted as a crash by onExit
    }
  }

  private onExit(gen: number, code: number | null, signal: NodeJS.Signals | null, error?: Error): void {
    if (gen !== this.generation) return;
    this.generation++; // ignore further events from this child
    this.child = undefined;
    this.peer?.close({ code: ErrorCode.ToolUnavailable, message: "tool exited" });
    this.peer = undefined;
    this.progress.clear();
    this.watchSent = false; // the next process starts unwatched
    const how = error ? `failed to start: ${error.message}` : signal ? `killed by ${signal}` : `exited with code ${code}`;
    const intent = this.intent;
    this.intent = null;

    if (intent === "stop") {
      this.log("info", `stopped (${how})`);
      this.setStatus("stopped");
    } else if (intent === "restart") {
      this.log("info", `stopped for restart (${how})`);
      this.spawnChild();
    } else {
      const now = this.clock.now();
      const decision = this.policy.recordCrash(now);
      if (decision.giveUp) {
        this.log("error", `crashed (${how}); giving up after ${decision.crashesInWindow} crashes in ${this.policy.windowMs / 1000} s`);
        this.setStatus("failed", `${how}; gave up after ${decision.crashesInWindow} crashes`);
      } else {
        this.log("error", `crashed (${how}); restarting in ${decision.delayMs / 1000} s`, { delayMs: decision.delayMs });
        this.restartAt = now + decision.delayMs;
        this.status = "down";
        this.statusText = `${how}; restarting in ${decision.delayMs / 1000} s`;
        this.opts.events.status(this);
        this.restartTimer = this.clock.setTimeout(() => {
          this.restartTimer = undefined;
          if (!this.child) this.spawnChild();
        }, decision.delayMs);
      }
    }
    const waiters = this.exitWaiters;
    this.exitWaiters = [];
    for (const w of waiters) w();
  }

  private onNotification(method: string, params: unknown): void {
    switch (method) {
      case "state": {
        const changes = (params as StateParams | undefined)?.changes;
        if (!Array.isArray(changes)) return;
        const valid = changes.filter((c): c is StateChange => typeof c === "object" && c !== null && typeof c.path === "string" && "value" in c);
        for (const c of valid) {
          applyChange(this.state, c);
          this.stale.apply(c);
        }
        if (this.running && valid.length > 0) this.opts.events.changes(this, valid);
        return;
      }
      case "progress": {
        const p = params as ProgressParams | undefined;
        if (p && p.id !== undefined) this.progress.get(p.id)?.(p);
        return;
      }
      case "stream": {
        const p = params as StreamParams | undefined;
        if (p && typeof p.name === "string" && (this.streamRefs.get(p.name) ?? 0) > 0) {
          this.opts.events.stream(this, p.name, p.value);
        }
        return;
      }
      case "log": {
        const p = params as LogParams | undefined;
        if (!p || typeof p.msg !== "string") return;
        const level = LOG_LEVELS.includes(p.level) ? p.level : "info";
        const fields = typeof p.fields === "object" && p.fields !== null && !Array.isArray(p.fields) ? p.fields : undefined;
        this.opts.log.add(this.id, "tool", level, p.msg, fields);
        return;
      }
      default:
        this.log("debug", `ignoring unknown notification "${method}"`);
    }
  }

  /** Forwards an action. Rejects with ToolUnavailable unless the tool is running. */
  action(name: string, args: JsonObject | undefined, onProgress?: (p: ProgressParams) => void): Promise<JsonValue> {
    if (!this.running || !this.peer) {
      return Promise.reject(new RpcError(ErrorCode.ToolUnavailable, `${this.manifest.title} is ${this.status}`));
    }
    const started = this.peer.start("action", args === undefined ? { name } : { name, args });
    if (onProgress) this.progress.set(started.id, onProgress);
    return started.result.finally(() => this.progress.delete(started.id)) as Promise<JsonValue>;
  }

  openStream(name: string): void {
    const n = (this.streamRefs.get(name) ?? 0) + 1;
    this.streamRefs.set(name, n);
    if (n === 1 && this.running) this.sendStream("stream.open", name);
  }

  closeStream(name: string): void {
    const n = (this.streamRefs.get(name) ?? 0) - 1;
    if (n > 0) {
      this.streamRefs.set(name, n);
      return;
    }
    this.streamRefs.delete(name);
    if (n === 0 && this.running) this.sendStream("stream.close", name);
  }

  /** Number of viewers right now (visible tabs on this tool's page). */
  get viewerCount(): number {
    return this.viewers;
  }

  /** True when the tool was told it is watched (the 1→0 edge waits for the debounce). */
  get watched(): boolean {
    return this.watchSent;
  }

  /** A visible tab opened this tool's page. 0→1 tells the tool at once. */
  addViewer(): void {
    this.viewers++;
    this.cancelUnwatchTimer();
    if (this.viewers === 1) this.sendWatch(true);
  }

  /**
   * A tab left the page, was hidden or closed. 1→0 tells the tool only after the debounce, so a
   * quick tab switch doesn't stop and restart its polling.
   */
  removeViewer(): void {
    if (this.viewers === 0) return;
    this.viewers--;
    if (this.viewers > 0 || !this.watchSent) return;
    this.cancelUnwatchTimer();
    this.unwatchTimer = this.clock.setTimeout(() => {
      this.unwatchTimer = undefined;
      if (this.viewers === 0) this.sendWatch(false);
    }, this.opts.unwatchDelayMs ?? UNWATCH_DELAY_MS);
  }

  private cancelUnwatchTimer(): void {
    if (this.unwatchTimer !== undefined) this.clock.clearTimeout(this.unwatchTimer);
    this.unwatchTimer = undefined;
  }

  private sendWatch(watching: boolean): void {
    if (watching === this.watchSent || !this.running || !this.peer) return;
    this.watchSent = watching;
    this.peer.notify("watch", { watching });
    this.log("debug", watching ? "watched" : "unwatched");
  }

  private sendStream(method: "stream.open" | "stream.close", name: string): void {
    this.peer?.request(method, { name }).catch((e: Error) => this.log("warn", `${method} ${name}: ${e.message}`));
  }
}
