// Every external command the audio tool runs goes through a Runner, so tests can replace
// PipeWire (which a cloud container doesn't have) with scripted fakes.
import { spawn as nodeSpawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";

/** The part of a ChildProcess the tool uses. */
export interface Proc {
  readonly pid?: number | undefined;
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "exit", fn: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "error", fn: (err: Error) => void): this;
  once(event: "exit", fn: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

export interface SpawnOptions {
  env?: NodeJS.ProcessEnv;
}

export interface Runner {
  spawn(cmd: string, args: string[], opts?: SpawnOptions): Proc;
}

/** Spawns real processes and kills whatever is still running when this process exits. */
export class RealRunner implements Runner {
  private live = new Set<Proc>();

  constructor() {
    process.once("exit", () => this.killAll());
  }

  spawn(cmd: string, args: string[], opts: SpawnOptions = {}): Proc {
    const child = nodeSpawn(cmd, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...opts.env },
    });
    this.live.add(child);
    child.once("exit", () => this.live.delete(child));
    child.once("error", () => this.live.delete(child));
    return child;
  }

  killAll(): void {
    for (const p of this.live) p.kill("SIGTERM");
    this.live.clear();
  }
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: string;
}

export interface RunOptions extends SpawnOptions {
  /** Written to stdin, which is then closed. */
  input?: Buffer | string;
  /** Kill the command (SIGKILL) after this many ms. */
  timeoutMs?: number;
  /** Called with the pid right after the spawn. */
  onPid?: (pid: number) => void;
  /** Names the command in error messages, e.g. "wpctl set-volume". Default: the command. */
  label?: string;
}

/** A failed command, with a message written for the person looking at the failed dot. */
export class CommandError extends Error {
  readonly result: RunResult | undefined;
  constructor(message: string, result?: RunResult) {
    super(message);
    this.name = "CommandError";
    this.result = result;
  }
}

const HINTS: Record<string, string> = {
  wpctl: "is WirePlumber installed?",
  "pw-dump": "is PipeWire installed?",
  "pw-play": "is pipewire-bin installed?",
  "pw-record": "is pipewire-bin installed?",
};

/** Message for a spawn error (mostly ENOENT: the command isn't installed). */
export function spawnErrorMessage(cmd: string, err: Error): string {
  if ((err as NodeJS.ErrnoException).code === "ENOENT") {
    return `${cmd} not found${HINTS[cmd] ? ` (${HINTS[cmd]})` : ""}`;
  }
  return `cannot run ${cmd}: ${err.message}`;
}

/** First useful line of stderr, trimmed to something that fits on a tooltip. */
export function stderrSummary(stderr: string): string {
  const lines = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const line = lines.find((l) => /error|fail|not|invalid|cannot|unknown/i.test(l)) ?? lines[0] ?? "";
  return line.length > 200 ? line.slice(0, 200) + "…" : line;
}

/** Runs a command to completion. Rejects with a CommandError on spawn failure or non-zero exit. */
export function runCommand(runner: Runner, cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    let proc: Proc;
    try {
      proc = runner.spawn(cmd, args, opts.env ? { env: opts.env } : {});
    } catch (e) {
      reject(new CommandError(spawnErrorMessage(cmd, e as Error)));
      return;
    }
    if (proc.pid !== undefined) opts.onPid?.(proc.pid);
    const out: Buffer[] = [];
    let err = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    proc.stdout?.on("data", (c: Buffer | string) => out.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    proc.stderr?.on("data", (c: Buffer | string) => {
      if (err.length < 64 * 1024) err += String(c);
    });
    proc.on("error", (e) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(new CommandError(spawnErrorMessage(cmd, e)));
    });
    proc.on("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      // Let the stdio streams drain their last chunks before resolving.
      setImmediate(() => {
        const result: RunResult = { code, signal, stdout: Buffer.concat(out), stderr: err };
        if (code === 0) {
          resolve(result);
          return;
        }
        const why = stderrSummary(err) || (signal ? `killed by ${signal}` : `exit code ${code}`);
        reject(new CommandError(`${opts.label ?? cmd} failed: ${why}`, result));
      });
    });
    if (opts.timeoutMs) {
      timer = setTimeout(() => proc.kill("SIGKILL"), opts.timeoutMs);
      timer.unref?.();
    }
    if (proc.stdin) {
      proc.stdin.on("error", () => {}); // EPIPE if the command exits early; the exit code tells the story
      if (opts.input !== undefined) proc.stdin.end(opts.input);
      else proc.stdin.end();
    }
  });
}
