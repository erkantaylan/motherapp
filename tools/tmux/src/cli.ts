// Plain subcommands for terminals and scripts; they work without the core.
import type { Writable } from "node:stream";
import { Tmux, TmuxError, ago, attachCommand, attachedText } from "./tmux.ts";
import type { Session, TmuxOptions } from "./tmux.ts";

export const USAGE = `usage: tmuxctl <command> [args]

  list [--json]        tmux sessions: name, windows, attached/detached, created, last activity
  attach-cmd <name>    print the shell command that attaches to the session
  kill <name>          kill the session with exactly this name
  serve                JSON-RPC serve mode (started by the motherapp core)

Exit codes: 0 ok, 1 tmux failed or no such session, 2 usage error.
"No tmux server running" is an empty list (exit 0), not an error.`;

export interface CliIO {
  tmux: TmuxOptions;
  stdout: Writable;
  stderr: Writable;
  now?: () => number;
}

class UsageError extends Error {}

const line = (out: Writable, s = "") => out.write(s + "\n");

async function find(tmux: Tmux, name: string): Promise<Session> {
  const res = await tmux.list();
  const s = res.kind === "ok" ? res.sessions.find((x) => x.name === name) : undefined;
  if (!s) throw new TmuxError(res.kind === "none" ? `no session named '${name}': ${res.reason}` : `no session named '${name}'`);
  return s;
}

function one(args: string[], what: string): string {
  if (args.length !== 1 || args[0] === "") throw new UsageError(args.length === 0 ? `missing ${what}` : `expected one ${what} (quote names with spaces)`);
  return args[0]!;
}

export async function runCli(argv: string[], io: CliIO): Promise<number> {
  const [cmd, ...args] = argv;
  const tmux = new Tmux(io.tmux);
  const now = io.now ?? Date.now;
  try {
    switch (cmd) {
      case "list": {
        const json = args.includes("--json");
        const bad = args.find((a) => a !== "--json");
        if (bad !== undefined) throw new UsageError(`unknown option "${bad}"`);
        const res = await tmux.list();
        const sessions = res.kind === "ok" ? res.sessions : [];
        if (json) {
          line(io.stdout, JSON.stringify(sessions.map((s) => ({ ...s, attachCommand: attachCommand(s.name) })), null, 2));
          return 0;
        }
        if (res.kind === "none") {
          line(io.stdout, res.reason);
          return 0;
        }
        if (sessions.length === 0) line(io.stdout, "No tmux sessions.");
        const w = Math.max(0, ...sessions.map((s) => s.name.length));
        for (const s of [...sessions].sort((a, b) => a.name.localeCompare(b.name))) {
          const win = `${s.windows} window${s.windows === 1 ? "" : "s"}`;
          line(io.stdout, `${s.name.padEnd(w)}  ${win.padEnd(10)}  ${attachedText(s.attached).padEnd(22)}  created ${ago(s.created, now())}, active ${ago(s.activity, now())}`);
        }
        return 0;
      }
      case "attach-cmd": {
        const s = await find(tmux, one(args, "session name"));
        line(io.stdout, attachCommand(s.name));
        return 0;
      }
      case "kill": {
        const name = one(args, "session name");
        await tmux.kill(`=${name}`);
        line(io.stdout, `killed '${name}'`);
        return 0;
      }
      case undefined:
      case "help":
      case "-h":
      case "--help":
        line(cmd === undefined ? io.stderr : io.stdout, USAGE);
        return cmd === undefined ? 2 : 0;
      default:
        throw new UsageError(`unknown command "${cmd}"`);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      line(io.stderr, `tmuxctl: ${e.message}\n\n${USAGE}`);
      return 2;
    }
    let msg = (e as Error).message;
    if (cmd === "kill" && msg === "That session doesn't exist anymore.") msg = `no session named '${args[0]}'`;
    line(io.stderr, `tmuxctl: ${msg}`);
    return 1;
  }
}
