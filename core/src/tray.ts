// The tray icon (DESIGN.md § 3 "Tray icon"): shows that motherapp runs and whether a tool is in
// trouble. Node has no D-Bus here, so the icon itself is a small Python helper
// (core/tray/motherapp-tray.py, GTK 3 + AyatanaAppIndicator3); this file starts it, feeds it
// and restarts it. Nothing in the core depends on it: no Python, no typelib, no tray host or a
// helper that keeps crashing is one warning in the log, and the core carries on.
//
// Protocol: JSON lines over the helper's stdio.
//   core -> helper   {"icon":"ok"|"warn","status":"6 tools running","muted":false}
//                    always the whole view; sent on start and whenever it changes
//   helper -> core   {"event":"ready"}                      the indicator exists
//                    {"event":"host","connected":bool}      a tray host shows it / none does
//                    {"event":"open"}                       "Open motherapp" clicked
//                    {"event":"mute","muted":bool}          "Mute notifications" (un)ticked
//                    {"event":"unavailable","reason":"…","retry":bool}   then it exits
//
// The helper is a plain child: it is in the service's cgroup (KillMode=mixed kills what the
// core leaves behind) and it exits by itself when its stdin closes, so it can't outlive the
// core outside systemd either. The icon vanishing when the service dies is intended.
//
// MOTHERAPP_TRAY=off: this core never starts the helper (a test core, a dev core). A core
// started under `node --test` is off unless MOTHERAPP_TRAY=on.
import { execFile, spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { LineDecoder } from "@motherapp/protocol";
import type { JsonObject, LogLevel, ToolInfo, TrayInfo } from "@motherapp/protocol";
import { RestartPolicy } from "./restartPolicy.ts";
import type { RestartPolicyOptions } from "./restartPolicy.ts";
import { realClock } from "./toolHost.ts";
import type { Clock } from "./toolHost.ts";

/** May this core show a tray icon at all? See the header. */
export function trayAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.MOTHERAPP_TRAY ?? "").toLowerCase();
  if (v === "off" || v === "0" || v === "false") return false;
  if (v === "on" || v === "1" || v === "true") return true;
  return env.NODE_TEST_CONTEXT === undefined;
}

// ---- what the icon says ----

export interface TrayView {
  icon: "ok" | "warn";
  /** The menu's status line. */
  status: string;
  /** The tick on "Mute notifications". */
  muted: boolean;
}

const NAME_MAX = 40;

/**
 * Turns the tool list into the icon and the status line. A tool is "in trouble" from the
 * moment it is down or failed until it runs again (or is disabled): while the core retries it
 * the status goes down -> starting -> down, and the icon must not blink through that.
 */
export class ToolHealth {
  private troubled = new Set<string>();

  update(tools: ToolInfo[]): Pick<TrayView, "icon" | "status"> {
    const enabled = tools.filter((t) => t.enabled);
    const seen = new Set(enabled.map((t) => t.id));
    for (const id of [...this.troubled]) if (!seen.has(id)) this.troubled.delete(id);
    for (const t of enabled) {
      if (t.status === "down" || t.status === "failed") this.troubled.add(t.id);
      else if (t.status === "running" || t.status === "stopped") this.troubled.delete(t.id);
    }
    const bad = enabled.filter((t) => this.troubled.has(t.id));
    if (bad.length === 1) {
      const t = bad[0]!;
      const name = t.title.length > NAME_MAX ? `${t.title.slice(0, NAME_MAX - 1)}…` : t.title;
      return { icon: "warn", status: t.status === "failed" ? `${name} keeps crashing` : `${name} has crashed` };
    }
    if (bad.length > 1) return { icon: "warn", status: `${bad.length} tools have crashed` };
    const running = enabled.filter((t) => t.status === "running").length;
    if (running > 0) return { icon: "ok", status: running === 1 ? "1 tool running" : `${running} tools running` };
    return { icon: "ok", status: enabled.length === 0 ? "No tools enabled" : "Starting…" };
  }
}

// ---- the session's environment ----

/**
 * What a desktop program needs and a unit started early in the login may lack: measured on
 * the target machine, the service had only XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS, while
 * `systemctl --user show-environment` had the display too (GNOME imports it later).
 */
const SESSION_VARS = ["WAYLAND_DISPLAY", "DISPLAY", "XAUTHORITY", "XDG_CURRENT_DESKTOP", "XDG_SESSION_TYPE", "XDG_DATA_DIRS", "DBUS_SESSION_BUS_ADDRESS"];

/** `systemctl --user show-environment` output; values systemd had to quote (`$'…'`) are skipped. */
export function parseShowEnvironment(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const value = line.slice(eq + 1);
    if (value.startsWith("$'")) continue;
    out[line.slice(0, eq)] = value;
  }
  return out;
}

export type ShowEnvironment = () => Promise<string>;

const realShowEnvironment: ShowEnvironment = () =>
  new Promise((resolve, reject) => {
    execFile("systemctl", ["--user", "show-environment"], { timeout: 3000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });

/** `env`, plus the session variables it lacks, when it has no display of its own. */
export async function sessionEnv(env: NodeJS.ProcessEnv = process.env, show: ShowEnvironment = realShowEnvironment): Promise<NodeJS.ProcessEnv> {
  if (env.WAYLAND_DISPLAY || env.DISPLAY) return env;
  let session: Record<string, string>;
  try {
    session = parseShowEnvironment(await show());
  } catch {
    return env; // no systemctl or no user manager: GTK still tries wayland-0 by itself
  }
  const out = { ...env };
  for (const k of SESSION_VARS) if (out[k] === undefined && session[k] !== undefined) out[k] = session[k];
  return out;
}

/**
 * The command for "Open motherapp". Under the unit it gets a scope of its own: a browser that
 * xdg-open starts would otherwise sit in the service's cgroup and be killed with it
 * (docs/lessons/2026-11-07-tmux-dashboard.md).
 */
export function openArgv(url: string, env: NodeJS.ProcessEnv): string[] {
  return [...(env.INVOCATION_ID ? ["systemd-run", "--user", "--scope", "--collect", "--quiet", "--"] : []), "xdg-open", url];
}

/** Opens `url` in the default browser of this computer. Never throws. */
export async function openInBrowser(url: string, warn: (msg: string) => void): Promise<void> {
  const env = await sessionEnv();
  const [cmd, ...args] = openArgv(url, env) as [string, ...string[]];
  try {
    const child = nodeSpawn(cmd, args, { env, stdio: "ignore", detached: true });
    child.on("error", (e) => warn(`can't open ${url}: ${cmd}: ${e.message}`));
    child.unref();
  } catch (e) {
    warn(`can't open ${url}: ${(e as Error).message}`);
  }
}

// ---- the supervisor ----

export type TraySpawn = (cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => ChildProcess;

const defaultSpawn: TraySpawn = (cmd, args, opts) => nodeSpawn(cmd, args, { env: opts.env, stdio: ["pipe", "pipe", "pipe"] });

/** 1, 2, 4, 8, 16, 30, 30 s, then give up: about a minute and a half of trying (a slow login). */
const DEFAULT_POLICY: RestartPolicyOptions = { maxCrashes: 8, windowMs: 300_000 };

export interface TrayOptions {
  /** False: never start the helper (`trayAllowed()`). */
  allowed: boolean;
  /** config.json `tray`. `save` throws when it can't be saved. */
  store: { get(): boolean; save(enabled: boolean): void };
  /** The helper's command line, e.g. `["python3", ".../motherapp-tray.py", ok.png, warning.png]`. */
  command: string[];
  view(): TrayView;
  onOpen(): void;
  /** The user ticked "Mute notifications" in the menu. May throw; the tick is re-synced after. */
  onMute(muted: boolean): void;
  log(level: LogLevel, msg: string, fields?: JsonObject): void;
  spawn?: TraySpawn;
  /** The environment the helper gets. Default: `sessionEnv()`. */
  env?: () => Promise<NodeJS.ProcessEnv>;
  clock?: Clock;
  policy?: RestartPolicyOptions;
  /** Between closing the helper's stdin + SIGTERM and SIGKILL. Default 2 s. */
  killGraceMs?: number;
}

export class Tray {
  private opts: TrayOptions;
  private clock: Clock;
  private policy: RestartPolicy;
  private child: ChildProcess | undefined;
  /** Bumped on every launch and every exit; events of an older helper are ignored. */
  private generation = 0;
  private state: TrayInfo["state"] = "off";
  private message: string | undefined;
  private started = false;
  private stopping = false;
  private ready = false;
  private lastSent: string | undefined;
  private unavailable: { reason: string; retry: boolean } | undefined;
  private stderrTail = "";
  private restartTimer: unknown;
  private exitWaiters: (() => void)[] = [];
  private warnedHost = false;
  private listeners = new Set<(info: TrayInfo) => void>();

  constructor(opts: TrayOptions) {
    this.opts = opts;
    this.clock = opts.clock ?? realClock;
    this.policy = new RestartPolicy(opts.policy ?? DEFAULT_POLICY);
  }

  info(): TrayInfo {
    const info: TrayInfo = { enabled: this.opts.store.get(), available: this.opts.allowed, state: this.state };
    if (this.message !== undefined) info.message = this.message;
    return info;
  }

  onChange(l: (info: TrayInfo) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** Called once the core is up. Shows the icon when the setting and the environment allow it. */
  start(): void {
    this.started = true;
    if (!this.opts.allowed) {
      this.opts.log("debug", "tray icon off for this core (MOTHERAPP_TRAY=off or started by a test)");
      return;
    }
    if (this.opts.store.get()) this.launch();
  }

  /** The Settings toggle: saved in config.json, applied at once. */
  async setEnabled(enabled: boolean): Promise<TrayInfo> {
    this.opts.store.save(enabled);
    this.opts.log("info", enabled ? "tray icon turned on" : "tray icon turned off");
    if (this.started && this.opts.allowed) {
      if (enabled) {
        // Also the way to retry after "failed": forget the crash history.
        this.policy.reset();
        if (!this.child && this.state !== "starting") this.launch();
      } else {
        await this.halt();
      }
    }
    const info = this.info();
    this.emit(info);
    return info;
  }

  /** The view may have changed (a tool's status, the mute switch): tell the helper if it did. */
  refresh(): void {
    if (!this.ready || !this.child) return;
    let line: string;
    try {
      line = JSON.stringify(this.opts.view());
    } catch {
      return;
    }
    if (line === this.lastSent) return;
    this.lastSent = line;
    this.child.stdin?.write(line + "\n");
  }

  /** Core shutdown: the icon goes away. */
  async stop(): Promise<void> {
    this.started = false;
    await this.halt();
  }

  private setState(state: TrayInfo["state"], message?: string): void {
    if (state === this.state && message === this.message) return;
    this.state = state;
    this.message = message;
    this.emit(this.info());
  }

  private emit(info: TrayInfo): void {
    for (const l of [...this.listeners]) {
      try {
        l(info);
      } catch {
        // a broken listener must not stop the others
      }
    }
  }

  private launch(): void {
    const gen = ++this.generation;
    this.stopping = false;
    this.unavailable = undefined;
    this.stderrTail = "";
    this.setState("starting");
    const go = (env: NodeJS.ProcessEnv) => {
      if (gen === this.generation) this.spawnChild(gen, env);
    };
    (this.opts.env ?? sessionEnv)().then(go, () => go(process.env));
  }

  private spawnChild(gen: number, env: NodeJS.ProcessEnv): void {
    const [cmd, ...args] = this.opts.command as [string, ...string[]];
    let child: ChildProcess;
    try {
      child = (this.opts.spawn ?? defaultSpawn)(cmd, args, { env });
    } catch (e) {
      this.onExit(gen, null, null, e as Error);
      return;
    }
    this.child = child;
    this.policy.recordStart(this.clock.now());
    const out = new LineDecoder();
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      for (const line of out.push(chunk)) if (gen === this.generation) this.onLine(line);
    });
    // GTK warns on stderr about all sorts of things; keep the end of it for a crash report only.
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (gen === this.generation) this.stderrTail = (this.stderrTail + chunk).slice(-2000);
    });
    child.stdin?.on("error", () => {
      // EPIPE when the helper dies; the exit handler deals with it
    });
    child.on("error", (e) => this.onExit(gen, null, null, e));
    child.on("exit", (code, signal) => this.onExit(gen, code, signal));
  }

  private onLine(line: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof msg !== "object" || msg === null) return;
    const m = msg as Record<string, unknown>;
    switch (m.event) {
      case "ready":
        this.ready = true;
        this.lastSent = undefined;
        this.setState("running");
        this.opts.log("info", "tray icon started");
        this.refresh();
        return;
      case "host":
        if (m.connected === true) {
          if (this.state === "running") this.setState("running");
        } else if (m.connected === false) {
          const text = "nothing on this desktop shows tray icons (on GNOME: the AppIndicator extension, Ubuntu package gnome-shell-extension-appindicator)";
          if (!this.warnedHost) {
            this.warnedHost = true;
            this.opts.log("warn", `Tray icon not visible: ${text}. It appears by itself once something does.`);
          }
          if (this.state === "running") this.setState("running", `Not visible: ${text}.`);
        }
        return;
      case "open":
        try {
          this.opts.onOpen();
        } catch (e) {
          this.opts.log("warn", `tray: open failed: ${(e as Error).message}`);
        }
        return;
      case "mute":
        if (typeof m.muted !== "boolean") return;
        // Whatever happens, the tick must show the real setting afterwards: the helper's idea
        // of it changed with the click, so the next view is sent even if it equals the last.
        this.lastSent = undefined;
        try {
          this.opts.onMute(m.muted);
        } catch (e) {
          this.opts.log("warn", `tray: couldn't change mute: ${(e as Error).message}`);
        }
        this.refresh();
        return;
      case "unavailable":
        this.unavailable = { reason: typeof m.reason === "string" ? m.reason.slice(0, 300) : "unknown reason", retry: m.retry === true };
        return;
      default:
        return;
    }
  }

  private onExit(gen: number, code: number | null, signal: NodeJS.Signals | null, error?: Error): void {
    if (gen !== this.generation) return;
    this.generation++; // ignore further events from this helper
    this.child = undefined;
    this.ready = false;
    this.lastSent = undefined;
    const waiters = this.exitWaiters;
    this.exitWaiters = [];
    if (this.stopping) {
      this.stopping = false;
      this.setState("off");
      for (const w of waiters) w();
      return;
    }
    const missing = (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
    const lastErr = this.stderrTail.trim().split("\n").pop()?.slice(0, 300);
    const how = missing
      ? `${this.opts.command[0]} isn't installed`
      : this.unavailable
        ? this.unavailable.reason
        : `the helper ${error ? `failed to start: ${error.message}` : signal ? `was killed by ${signal}` : `exited with code ${code}`}${lastErr ? ` (${lastErr})` : ""}`;
    if (missing || (this.unavailable && !this.unavailable.retry)) {
      this.opts.log("warn", `No tray icon: ${how}. Everything else works; \`motherapp doctor\` shows what to install.`);
      this.setState("failed", `${how}.`);
    } else {
      const decision = this.policy.recordCrash(this.clock.now());
      if (decision.giveUp) {
        this.opts.log("warn", `No tray icon: ${how}; gave up after ${decision.crashesInWindow} tries. Turn "Show tray icon" off and on in Settings, or restart motherapp, to try again.`);
        this.setState("failed", `${how}; gave up after ${decision.crashesInWindow} tries.`);
      } else {
        this.opts.log("debug", `tray helper stopped: ${how}; trying again in ${decision.delayMs / 1000} s`, { delayMs: decision.delayMs });
        this.setState("starting", `${how}; trying again.`);
        this.restartTimer = this.clock.setTimeout(() => {
          this.restartTimer = undefined;
          if (!this.child && this.started && this.opts.allowed && this.opts.store.get()) this.launch();
        }, decision.delayMs);
      }
    }
    for (const w of waiters) w();
  }

  /** Stops the helper and any pending retry; resolves when it is gone. */
  private halt(): Promise<void> {
    if (this.restartTimer !== undefined) {
      this.clock.clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    const child = this.child;
    if (!child) {
      this.generation++; // a launch still waiting for its environment is cancelled
      this.setState("off");
      return Promise.resolve();
    }
    this.stopping = true;
    const gen = this.generation;
    return new Promise((resolve) => {
      this.exitWaiters.push(resolve);
      child.stdin?.end(); // the helper quits on end-of-input
      child.kill("SIGTERM");
      const timer = setTimeout(() => {
        if (gen === this.generation && this.child === child) child.kill("SIGKILL");
      }, this.opts.killGraceMs ?? 2000);
      timer.unref();
    });
  }
}
