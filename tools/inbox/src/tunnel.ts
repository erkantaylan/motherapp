// cloudflared as a child of the inbox serve process, pointed only at the inbox listener:
// always a quick tunnel, `cloudflared tunnel --no-autoupdate --url http://127.0.0.1:<port>`
// (no account; the user's decision, 2026-10-20: never named tunnels). The
// `https://<random>.trycloudflare.com` URL is parsed from its output. It changes every time
// cloudflared restarts, which breaks links made before.
//
// Started on demand, stopped when no active links remain, restarted with backoff
// (1 s, 2 s, 4 s … 30 s; reset after a run of 60 s) when it exits on its own.
// cloudflared's own output is not forwarded to the log; only state changes are.
import type { Proc, Runner } from "../../tmux/src/runner.ts";

export type TunnelStatus = "stopped" | "starting" | "running" | "restarting" | "failed";

export interface TunnelInfo {
  status: TunnelStatus;
  /** Public host, once known. */
  host: string;
  /** cloudflared reported a registered connection. */
  connected: boolean;
  error: string;
}

export interface TunnelTimers {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
}

export interface TunnelLog {
  info(msg: string, fields?: Record<string, string | number | boolean>): void;
  warn(msg: string, fields?: Record<string, string | number | boolean>): void;
}

export interface TunnelOptions {
  runner: Runner;
  timers: TunnelTimers;
  port: number;
  log: TunnelLog;
  onChange: (info: TunnelInfo) => void;
  /** The cloudflared command. Default "cloudflared". */
  command?: string;
}

const QUICK_URL = /https:\/\/([a-z0-9-]+\.trycloudflare\.com)\b/;
const CONNECTED = /Registered tunnel connection/i;
const ERROR_LINE = /\bERR\b|error|failed/i;

/** The quick-tunnel host in a line of cloudflared output, if any. */
export function parseQuickHost(line: string): string | undefined {
  const m = QUICK_URL.exec(line);
  return m && m[1] !== "api.trycloudflare.com" ? m[1] : undefined;
}

/** Replaces whatever follows `/inbox/` with `…`. */
export function redactPaths(s: string): string {
  return s.replace(/\/inbox\/[^\s"'&?#]*/g, "/inbox/…");
}

export const BACKOFF_MAX_MS = 30_000;

export class Tunnel {
  private opts: TunnelOptions;
  private proc: Proc | undefined;
  private wanted = false;
  private restartTimer: unknown;
  private attempts = 0;
  private startedAt = 0;
  private gen = 0;
  private state: TunnelInfo;
  private waiters: (() => void)[] = [];

  constructor(opts: TunnelOptions) {
    this.opts = opts;
    this.state = { status: "stopped", host: "", connected: false, error: "" };
  }

  info(): TunnelInfo {
    return { ...this.state };
  }

  get running(): boolean {
    return this.proc !== undefined;
  }

  private update(patch: Partial<TunnelInfo>): void {
    this.state = { ...this.state, ...patch };
    this.opts.onChange(this.info());
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  /** Starts cloudflared unless it is running or about to restart. */
  start(): void {
    this.wanted = true;
    if (this.proc || this.restartTimer !== undefined) return;
    this.spawn();
  }

  stop(): void {
    this.wanted = false;
    if (this.restartTimer !== undefined) this.opts.timers.clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    this.attempts = 0;
    const p = this.proc;
    this.proc = undefined;
    this.gen++;
    p?.kill("SIGTERM");
    if (this.state.status !== "stopped" || this.state.host) {
      if (p) this.opts.log.info("tunnel stopped");
      this.update({ status: "stopped", host: "", connected: false, error: "" });
    }
  }

  /** A new port: restarts cloudflared if it was running. */
  reconfigure(port: number): void {
    const was = this.wanted;
    this.stop();
    this.opts = { ...this.opts, port };
    this.update({ host: "", error: "" });
    if (was) this.start();
  }

  /** Resolves with the public host once it is known; rejects after `timeoutMs` or on failure. */
  waitForHost(timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        done = true;
        reject(new Error(this.state.error ? `the tunnel didn't come up: ${this.state.error}` : `the tunnel didn't come up within ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      timer.unref?.();
      let done = false;
      const check = () => {
        if (done) return;
        if (this.state.host && this.state.status === "running") {
          done = true;
          clearTimeout(timer);
          resolve(this.state.host);
        } else if (this.state.status === "failed" || this.state.status === "stopped") {
          done = true;
          clearTimeout(timer);
          reject(new Error(`the tunnel didn't come up: ${this.state.error || this.state.status}`));
        } else {
          this.waiters.push(check);
        }
      };
      check();
    });
  }

  private args(): string[] {
    return ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${this.opts.port}`];
  }

  private spawn(): void {
    const gen = ++this.gen;
    const cmd = this.opts.command ?? "cloudflared";
    let proc: Proc;
    try {
      proc = this.opts.runner.spawn(cmd, this.args());
    } catch (e) {
      this.onExit(gen, `cannot start ${cmd}: ${(e as Error).message}`);
      return;
    }
    this.proc = proc;
    this.startedAt = this.opts.timers.now();
    this.update({ status: "starting", host: "", connected: false, error: "" });
    this.opts.log.info("tunnel starting");
    let buf = "";
    const onData = (chunk: string) => {
      if (gen !== this.gen) return;
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop()!;
      if (buf.length > 64 * 1024) buf = "";
      for (const line of lines) this.onLine(line);
    };
    proc.stdout?.setEncoding("utf8");
    proc.stderr?.setEncoding("utf8");
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    proc.on("error", (e) => {
      const why = (e as NodeJS.ErrnoException).code === "ENOENT" ? `${cmd} not found (is cloudflared installed?)` : `cannot run ${cmd}: ${e.message}`;
      this.onExit(gen, why);
    });
    proc.on("close", (code, signal) => this.onExit(gen, `cloudflared exited (${signal ?? `code ${code}`})`));
  }

  private onLine(raw: string): void {
    // cloudflared may name a request path in an error; a path can hold a token.
    const line = redactPaths(raw);
    const patch: Partial<TunnelInfo> = {};
    if (!this.state.host) {
      const host = parseQuickHost(line);
      if (host) patch.host = host;
    }
    if (CONNECTED.test(line) && !this.state.connected) patch.connected = true;
    else if (ERROR_LINE.test(line) && !this.state.connected) patch.error = line.replace(/^\S+\s+(?:ERR|WRN|INF)\s+/, "").trim().slice(0, 300);
    const host = patch.host ?? this.state.host;
    // Running once the URL is known (it is printed before the connection registers).
    if (host !== "" && this.state.status !== "running") {
      patch.status = "running";
      this.opts.log.info("tunnel up", { host });
    }
    if (Object.keys(patch).length > 0) this.update(patch);
  }

  private onExit(gen: number, why: string): void {
    if (gen !== this.gen) return;
    this.gen++;
    this.proc = undefined;
    if (!this.wanted) return;
    const now = this.opts.timers.now();
    if (now - this.startedAt >= 60_000) this.attempts = 0;
    const delay = Math.min(BACKOFF_MAX_MS, 1000 * 2 ** this.attempts++);
    this.opts.log.warn(`tunnel down: ${why}; restarting in ${delay / 1000} s`);
    this.update({
      status: "restarting",
      host: "",
      connected: false,
      error: this.state.error ? `${why}: ${this.state.error}` : why,
    });
    this.restartTimer = this.opts.timers.setTimeout(() => {
      this.restartTimer = undefined;
      if (this.wanted && !this.proc) this.spawn();
    }, delay);
  }
}
