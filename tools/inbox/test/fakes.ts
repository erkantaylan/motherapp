// Test doubles: a scripted `tmux` with Claude-like panes, a scripted `cloudflared`, timers
// advanced by hand, and a harness that runs the service with the SDK's serve over streams so
// every log line and state change it emits can be inspected.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { createTool } from "@motherapp/tool-sdk";
import type { Tool } from "@motherapp/tool-sdk";
import { FakeProc, FakeTimers } from "../../tmux/test/fakes.ts";
import type { Proc, Runner } from "../../tmux/src/runner.ts";
import { TmuxPanes } from "../src/panes.ts";
import { INITIAL_STATE, InboxService } from "../src/service.ts";
import type { ServiceOptions } from "../src/service.ts";
import { defaultSettings } from "../src/settings.ts";
import type { Settings } from "../src/settings.ts";
import { Store } from "../src/store.ts";

export { FakeTimers };

export interface FakePane {
  id: string;
  session: string;
  window: number;
  index: number;
  pid: number;
  inMode: boolean;
  attached: number;
  command: string;
  path: string;
  /** What is in Claude's input box. */
  input: string;
  /** Claude is mid-turn (spinner shown). */
  working: boolean;
  /** A permission dialog replaces the input box. */
  dialog: boolean;
  /** Lone Enters to ignore (to make the retry happen). */
  swallowEnters: number;
  /** Keys typed with -l go nowhere (as if a dialog took them). */
  eatText: boolean;
  /** Lines submitted with Enter. */
  submitted: string[];
}

export function claudePane(n: number, more: Partial<FakePane> = {}): FakePane {
  return {
    id: `%${n}`,
    session: "motherapp",
    window: 0,
    index: n,
    pid: 1000 + n,
    inMode: false,
    attached: 1,
    command: "claude",
    path: "/home/u/Desktop/projects/motherapp",
    input: "",
    working: false,
    dialog: false,
    swallowEnters: 0,
    eatText: false,
    submitted: [],
    ...more,
  };
}

/** The screen of a fake pane, shaped like Claude Code 2.x. */
export function screenOf(p: FakePane): string {
  const rule = "─".repeat(60);
  if (p.command !== "claude") return "user@host:~$ \n";
  if (p.dialog) return ["● I need to run a command.", "", " Bash command", "   rm -rf build", " Do you want to proceed?", " ❯ 1. Yes", "   2. No", ""].join("\n");
  return [
    "> earlier message",
    "",
    "● Earlier answer.",
    "",
    ...(p.working ? ["✻ Thinking… (3s · esc to interrupt)", ""] : []),
    rule,
    `> ${p.input}`,
    rule,
    "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
    "",
    "",
  ].join("\n");
}

export class FakeTmux implements Runner {
  panes: FakePane[] = [];
  calls: string[][] = [];
  noServer = false;
  /** Fail list-panes with this stderr. */
  fail: string | undefined;

  spawn(cmd: string, args: string[]): Proc {
    if (cmd !== "tmux") throw new Error(`unexpected command ${cmd}`);
    const p = new FakeProc(cmd, args);
    const a = args.filter((x) => x !== "-u");
    if (a[0] === "-S") a.splice(0, 2);
    this.calls.push(a);
    setImmediate(() => this.answer(p, a));
    return p;
  }

  /** The send-keys calls, as arrays of their arguments after the target. */
  sends(): string[][] {
    return this.calls.filter((c) => c[0] === "send-keys").map((c) => c.slice(3));
  }

  private find(t: string): FakePane | undefined {
    return this.panes.find((p) => p.id === t);
  }

  private answer(proc: FakeProc, a: string[]): void {
    if (this.noServer) return proc.finish(1, "", "no server running on /tmp/tmux-1000/default\n");
    const cmd = a[0];
    const target = a[a.indexOf("-t") + 1] ?? "";
    if (cmd === "list-panes") {
      if (this.fail) return proc.finish(1, "", this.fail + "\n");
      const out = this.panes
        .map((p) => [p.id, p.session, p.window, p.index, p.pid, p.inMode ? 1 : 0, p.attached, p.command, p.path].join("\t") + "\n")
        .join("");
      return proc.finish(0, out);
    }
    const p = this.find(target);
    if (!p) return proc.finish(1, "", `can't find pane: ${target}\n`);
    if (cmd === "capture-pane") return proc.finish(0, screenOf(p));
    if (cmd === "send-keys") {
      const rest = a.slice(3);
      if (rest[0] === "-l") {
        let text = rest[1] === "--" ? rest[2]! : rest[1]!;
        // tmux 3.4: a trailing "\;" becomes ";", a bare trailing ";" is a separator.
        if (text.endsWith("\\;")) text = text.slice(0, -2) + ";";
        else if (text.endsWith(";")) text = text.slice(0, -1);
        if (!p.eatText && !p.dialog) p.input += text.replace(/\n/g, "↵");
        return proc.finish(0);
      }
      if (rest.length === 1 && rest[0] === "Enter") {
        if (p.swallowEnters > 0) p.swallowEnters--;
        else if (p.input !== "") {
          p.submitted.push(p.input);
          p.input = "";
        }
        return proc.finish(0);
      }
      return proc.finish(1, "", "unexpected send-keys form\n");
    }
    proc.finish(1, "", `unknown command ${cmd}\n`);
  }
}

export const QUICK_OUTPUT = (host: string) =>
  fs
    .readFileSync(new URL("./fixtures/cloudflared-quick.txt", import.meta.url), "utf8")
    .replaceAll("HOST.trycloudflare.com", `${host}.trycloudflare.com`);

/** `cloudflared`: each start prints the quick-tunnel banner with a new host, unless told not to. */
export class FakeCloudflared {
  procs: FakeProc[] = [];
  starts: string[][] = [];
  hosts = ["first-tunnel-aa", "second-tunnel-bb", "third-tunnel-cc", "fourth-tunnel-dd"];
  /** "banner": print the URL and register; "silent": print nothing; "die": exit at once. */
  behaviour: "banner" | "silent" | "die" = "banner";

  spawn(args: string[]): Proc {
    const p = new FakeProc("cloudflared", args);
    const n = this.starts.length;
    this.starts.push(args);
    this.procs.push(p);
    p.once("close", () => this.closed.add(p));
    setImmediate(() => {
      if (this.behaviour === "die") return p.finish(1, "", "2026-10-20T10:00:00Z ERR failed to connect\n");
      if (this.behaviour === "silent") return;
      p.stderr.write(args.includes("run") ? "2026-10-20T10:00:01Z INF Registered tunnel connection connIndex=0 location=fra08 protocol=quic\n" : QUICK_OUTPUT(this.hosts[n] ?? `host-${n}`));
    });
    return p;
  }

  closed = new Set<FakeProc>();

  /** Processes started and not yet exited. */
  live(): FakeProc[] {
    return this.procs.filter((p) => !this.closed.has(p));
  }
}

/** Dispatches `tmux` and `cloudflared` to their fakes. */
export class FakeRunner implements Runner {
  tmux = new FakeTmux();
  cf = new FakeCloudflared();
  spawn(cmd: string, args: string[]): Proc {
    if (cmd === "cloudflared") return this.cf.spawn(args);
    return this.tmux.spawn(cmd, args);
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

export function tmpDir(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ma-inbox-${tag}-`));
}

export interface Harness {
  dir: string;
  stateDir: string;
  runner: FakeRunner;
  timers: FakeTimers;
  tool: Tool;
  service: InboxService;
  /** Every line the tool wrote on its serve channel (state, log, action replies). */
  out: string[];
  /** Calls an action through the serve channel, as the core would. */
  call(name: string, args?: Record<string, unknown>): Promise<{ result?: any; error?: { code: number; message: string } }>;
  logs(): { level: string; msg: string; fields?: Record<string, unknown> }[];
  url(p: string): string;
  close(): Promise<void>;
}

export async function harness(opts: { settings?: Partial<Settings>; service?: Partial<ServiceOptions>; panes?: FakePane[] } = {}): Promise<Harness> {
  const dir = tmpDir("h");
  const stateDir = path.join(dir, "state", "inbox");
  const runner = new FakeRunner();
  runner.tmux.panes = opts.panes ?? [claudePane(1)];
  const timers = new FakeTimers();
  const input = new PassThrough();
  const output = new PassThrough();
  const out: string[] = [];
  let buf = "";
  output.setEncoding("utf8");
  output.on("data", (c: string) => {
    buf += c;
    const parts = buf.split("\n");
    buf = parts.pop()!;
    out.push(...parts.filter(Boolean));
  });
  const tool = createTool({ id: "inbox", title: "Inbox", initialState: INITIAL_STATE, persist: false, input, output, captureConsole: false });
  const settings: Settings = { ...defaultSettings(), port: 0, sendDelayMs: 0, verifyDelayMs: 0, checkScreen: true, ...opts.settings };
  const service = new InboxService({
    tool,
    panes: new TmuxPanes({ runner, exists: () => true }),
    store: new Store(stateDir),
    settings,
    runner,
    stateDir,
    timers,
    sleep: async () => {},
    home: "/home/u",
    hostTimeoutMs: 2000,
    ...opts.service,
  });
  const serving = tool.serve();
  await service.start();
  let id = 0;
  return {
    dir,
    stateDir,
    runner,
    timers,
    tool,
    service,
    out,
    async call(name, args = {}) {
      const rid = ++id;
      input.write(JSON.stringify({ jsonrpc: "2.0", id: rid, method: "action", params: { name, args } }) + "\n");
      await waitFor(() => out.some((l) => JSON.parse(l).id === rid), `reply to ${name}`);
      return JSON.parse(out.find((l) => JSON.parse(l).id === rid)!);
    },
    logs() {
      return out.map((l) => JSON.parse(l)).filter((m) => m.method === "log").map((m) => m.params);
    },
    url(p) {
      return `http://127.0.0.1:${service.port}${p}`;
    },
    async close() {
      await service.stop();
      input.end();
      await serving;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
