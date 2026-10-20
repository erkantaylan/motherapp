// Test doubles: a scripted runner whose `tmux` answers from an in-memory server, and timers
// advanced by hand.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { Proc, Runner } from "../src/runner.ts";
import type { Timers } from "../src/service.ts";
import type { Session } from "../src/tmux.ts";

export class FakeProc extends EventEmitter implements Proc {
  readonly stdin = null;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly cmd: string;
  readonly args: string[];
  constructor(cmd: string, args: string[]) {
    super();
    this.cmd = cmd;
    this.args = args;
  }
  kill(): boolean {
    this.finish(null);
    return true;
  }
  finish(code: number | null, out = "", err = ""): void {
    this.stdout.end(out);
    this.stderr.end(err);
    setImmediate(() => this.emit("close", code, null));
  }
}

/** What `tmux list-sessions` sees: sessions, or one of the no-server / failure answers. */
export type FakeServer =
  | { sessions: Session[] }
  | { noServer: "stale-socket" | "no-socket" | "no-dir" }
  | { fail: string }
  | { missing: true };

export class FakeTmux implements Runner {
  calls: string[][] = [];
  server: FakeServer = { sessions: [] };
  socket = "/tmp/tmux-1000/default";

  spawn(cmd: string, args: string[]): Proc {
    if (cmd !== "tmux") throw new Error(`unexpected command ${cmd}`);
    const p = new FakeProc(cmd, args);
    this.calls.push(args);
    setImmediate(() => this.answer(p, args));
    return p;
  }

  /** The command lines run so far, without the leading -u. */
  lines(): string[] {
    return this.calls.map((a) => a.filter((x) => x !== "-u").join(" "));
  }

  private answer(p: FakeProc, args: string[]): void {
    const s = this.server;
    if ("missing" in s) {
      const e = Object.assign(new Error("spawn tmux ENOENT"), { code: "ENOENT" });
      p.emit("error", e);
      return;
    }
    if ("fail" in s) return p.finish(1, "", `${s.fail}\n`);
    if ("noServer" in s) {
      if (s.noServer === "stale-socket") return p.finish(1, "", `no server running on ${this.socket}\n`);
      return p.finish(1, "", `error connecting to ${this.socket} (No such file or directory)\n`);
    }
    const cmd = args.find((a) => !a.startsWith("-"));
    if (cmd === "list-sessions") {
      const out = s.sessions.map((x) => [x.id, x.name, x.windows, x.created, x.attached, x.activity, x.command, x.path].join("\t") + "\n").join("");
      return p.finish(0, out);
    }
    if (cmd === "kill-session") {
      const t = args[args.indexOf("-t") + 1]!;
      const i = s.sessions.findIndex((x) => (t.startsWith("=") ? x.name === t.slice(1) : x.id === t));
      if (i < 0) return p.finish(1, "", `can't find session: ${t.replace(/^=/, "")}\n`);
      s.sessions.splice(i, 1);
      return p.finish(0);
    }
    p.finish(1, "", `unknown command: ${cmd}\n`);
  }
}

export function session(id: number, name: string, more: Partial<Session> = {}): Session {
  return { id: `$${id}`, name, windows: 1, created: 1_700_000_000, attached: 0, activity: 1_700_000_000, command: "bash", path: "/home/u", ...more };
}

export class FakeTimers implements Timers {
  t = 1_700_000_000_000 + 3600_000;
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
  pending(): number {
    return this.list.length;
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
