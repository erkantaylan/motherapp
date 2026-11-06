// Test doubles: a scripted runner whose `tmux` answers from an in-memory server, and timers
// advanced by hand.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { Proc, Runner } from "../src/runner.ts";
import type { ClaudeDetails, ClaudeSource, ClaudeStatus } from "../src/claude.ts";
import type { Notifier } from "../src/notify.ts";
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

/** What `tmux list-panes` sees: sessions, or one of the no-server / failure answers. */
export type FakeServer =
  | { sessions: Session[] }
  | { noServer: "stale-socket" | "no-socket" | "no-dir" }
  | { fail: string }
  | { missing: true };

export class FakeTmux implements Runner {
  calls: string[][] = [];
  server: FakeServer = { sessions: [] };
  socket = "/tmp/tmux-1000/default";
  /** What `capture-pane` prints. */
  screen = "\x1b[31mhello\x1b[39m\n";

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
    if (cmd === "list-panes") return p.finish(0, paneLines(s.sessions));
    if (cmd === "capture-pane") {
      const t = args[args.indexOf("-t") + 1]!;
      if (!s.sessions.some((x) => `${x.id}:` === t)) return p.finish(1, "", `can't find session: ${t}\n`);
      return p.finish(0, this.screen);
    }
    if (cmd === "rename-session") {
      const t = args[args.indexOf("-t") + 1]!;
      const x = s.sessions.find((y) => y.id === t);
      if (!x) return p.finish(1, "", `can't find session: ${t}\n`);
      const name = args.at(-1)!.replaceAll("##", "#").replace(/[:.]/g, "_");
      if (s.sessions.some((y) => y !== x && y.name === name)) return p.finish(1, "", `duplicate session: ${name}\n`);
      x.name = name;
      return p.finish(0);
    }
    if (cmd === "display-message") {
      const t = args[args.indexOf("-t") + 1]!;
      const x = s.sessions.find((y) => y.id === t);
      return x ? p.finish(0, `${x.name}\n`) : p.finish(1, "", `can't find session: ${t}\n`);
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
  const command = more.command ?? "bash";
  const path = more.path ?? "/home/u";
  return {
    id: `$${id}`,
    name,
    windows: 1,
    created: 1_700_000_000,
    attached: 0,
    activity: 1_700_000_000,
    input: 1_700_000_000,
    command,
    path,
    panes: [{ id: `%${id}`, pid: 1000 + id, active: true, width: 80, height: 24, command, path }],
    ...more,
  };
}

/** `list-panes -a -F FORMAT` output for these sessions. */
export function paneLines(sessions: Session[]): string {
  return sessions
    .flatMap((x) =>
      x.panes.map((p) => [x.id, x.name, x.windows, x.created, x.attached, x.input, x.activity, 1, p.active ? 1 : 0, p.id, p.pid, p.width, p.height, p.command, p.path].join("\t") + "\n"),
    )
    .join("");
}

/** Claude's files, as a test sets them. */
export class FakeClaude implements ClaudeSource {
  panes = new Map<number, ClaudeStatus>();
  transcripts = new Map<string, ClaudeDetails>();
  agents: number | undefined = 0;
  forPanes(panePids: ReadonlySet<number>): Map<number, ClaudeStatus> {
    return new Map([...this.panes].filter(([pid]) => panePids.has(pid)));
  }
  details(sessionId: string): ClaudeDetails | undefined {
    return this.transcripts.get(sessionId);
  }
  runningAgents(): number | undefined {
    return this.agents;
  }
}

export class FakeNotifier implements Notifier {
  sent: string[] = [];
  send(name: string, word: string): void {
    this.sent.push(`${name}: ${word}`);
  }
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
