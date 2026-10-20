// Test doubles: a scripted process runner (no PipeWire in CI) and manual timers.
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import type { Proc, Runner, SpawnOptions } from "../src/runner.ts";
import type { Timers } from "../src/monitor.ts";

export const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
export const dumpText = () => fs.readFileSync(path.join(fixtures, "pw-dump.json"), "utf8");
/** A SteelSeries Arctis Pro Wireless alone: one USB card with Chat and Game PCMs (issue #5). */
export const arctisText = () => fs.readFileSync(path.join(fixtures, "pw-dump-arctis.json"), "utf8");
export const monitorText = () => fs.readFileSync(path.join(fixtures, "pw-dump-monitor.txt"), "utf8");
/** The monitor fixture as parsed batches: [0] is the initial full dump. */
export function monitorBatches(): unknown[][] {
  return monitorText()
    .split(/\n(?=\[)/)
    .map((s) => JSON.parse(s) as unknown[]);
}

export class FakeProc extends EventEmitter implements Proc {
  readonly pid: number;
  readonly cmd: string;
  readonly args: string[];
  readonly env: NodeJS.ProcessEnv | undefined;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: string[] = [];
  exited = false;
  /** Exit as soon as a signal arrives (like a real process). Default true. */
  exitOnKill = true;
  private input: Buffer[] = [];

  constructor(pid: number, cmd: string, args: string[], env?: NodeJS.ProcessEnv) {
    super();
    this.pid = pid;
    this.cmd = cmd;
    this.args = args;
    this.env = env;
    this.stdin.on("data", (c: Buffer) => this.input.push(c));
  }

  get stdinData(): Buffer {
    return Buffer.concat(this.input);
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    if (this.exitOnKill) this.exit(null, signal);
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exited) return;
    this.exited = true;
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => this.emit("exit", code, signal));
  }

  fail(code: number, stderr: string): void {
    this.stderr.write(stderr);
    this.exit(code);
  }
}

export type Behaviour = (p: FakeProc) => void;

/** Records every spawn; `behave` decides what each process does (default: exit 0). */
export class FakeRunner implements Runner {
  procs: FakeProc[] = [];
  private nextPid = 9000;
  behave: Behaviour = (p) => p.exit(0);

  spawn(cmd: string, args: string[], opts: SpawnOptions = {}): Proc {
    const p = new FakeProc(this.nextPid++, cmd, args, opts.env);
    this.procs.push(p);
    setImmediate(() => this.behave(p));
    return p;
  }

  /** Command lines run so far, e.g. "wpctl set-volume 101 0.55". */
  lines(cmd?: string): string[] {
    return this.procs.filter((p) => !cmd || p.cmd === cmd).map((p) => [p.cmd, ...p.args].join(" "));
  }

  find(cmd: string): FakeProc[] {
    return this.procs.filter((p) => p.cmd === cmd);
  }
}

/** Timers advanced by hand. */
export class FakeTimers implements Timers {
  t = 0;
  private list: { at: number; fn: () => void; id: number }[] = [];
  private id = 0;
  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.id;
    this.list.push({ at: this.t + ms, fn, id });
    return id;
  }
  clearTimeout(h: unknown): void {
    this.list = this.list.filter((x) => x.id !== h);
  }
  pending(): number[] {
    return this.list.map((x) => x.at - this.t);
  }
  advance(ms: number): void {
    this.t += ms;
    const due = this.list.filter((x) => x.at <= this.t);
    this.list = this.list.filter((x) => x.at > this.t);
    for (const d of due) d.fn();
  }
}

export const tick = () => new Promise((r) => setImmediate(r));

export async function waitFor(pred: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A buffer of mono s16le samples at a constant amplitude. */
export function tone(samples: number, amplitude: number): Buffer {
  const b = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) b.writeInt16LE(i % 2 === 0 ? amplitude : -amplitude, i * 2);
  return b;
}
