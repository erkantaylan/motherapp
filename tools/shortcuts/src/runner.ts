// Every gsettings/dconf call goes through a Runner, so tests can swap in fakes. Same pattern
// as tools/tmux/src/runner.ts, plus extra environment per call.
import { spawn as nodeSpawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";

/** The part of a ChildProcess the tool uses. */
export interface Proc {
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "close", fn: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "error", fn: (err: Error) => void): this;
}

export interface Runner {
  spawn(cmd: string, args: string[], env?: NodeJS.ProcessEnv): Proc;
}

export class RealRunner implements Runner {
  spawn(cmd: string, args: string[], env?: NodeJS.ProcessEnv): Proc {
    return nodeSpawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
  }
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** A command that couldn't be started (e.g. dconf isn't installed). */
export class SpawnError extends Error {
  readonly missing: boolean;
  constructor(message: string, missing: boolean) {
    super(message);
    this.missing = missing;
  }
}

/** Runs a command to completion. Resolves on any exit code; rejects only if it can't start. */
export function run(runner: Runner, cmd: string, args: string[], env?: NodeJS.ProcessEnv, timeoutMs = 10_000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    let proc: Proc;
    const fail = (e: Error) => {
      const missing = (e as NodeJS.ErrnoException).code === "ENOENT";
      reject(new SpawnError(missing ? `${cmd} not found (is it installed?)` : `cannot run ${cmd}: ${e.message}`, missing));
    };
    try {
      proc = runner.spawn(cmd, args, env);
    } catch (e) {
      fail(e as Error);
      return;
    }
    let out = "";
    let err = "";
    let settled = false;
    proc.stdout?.setEncoding("utf8");
    proc.stderr?.setEncoding("utf8");
    proc.stdout?.on("data", (c: string) => (out += c));
    proc.stderr?.on("data", (c: string) => {
      if (err.length < 64 * 1024) err += c;
    });
    const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
    timer.unref?.();
    proc.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fail(e);
    });
    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: out, stderr: err });
    });
  });
}
