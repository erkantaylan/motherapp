// Talking to tmux: list sessions, kill or rename one, capture a pane, and the commands that attach.
//
// Facts checked against real tmux 3.4 and 3.6a (see test/real-tmux.test.ts):
// - Without a UTF-8 client, tmux replaces every non-printable or non-ASCII byte in -F output
//   with "_", including the tab separators. `-u` (force UTF-8) keeps tabs and unicode, so every
//   call passes it; the systemd service's locale doesn't matter then.
// - Session names never contain tabs or newlines: tmux escapes them when the session is created
//   (a tab becomes the two characters "\t", a backslash "\\"), and turns ":" and "." into "_".
//   The listed name is exactly the string `-t '=<name>'` matches.
// - No server: exit 1 with "no server running on <socket>" (socket file left behind), or
//   "error connecting to <socket> (No such file or directory)" (no socket, or no socket dir).
// - `session_activity` is not output: it moves on client input and lagged real pane output by
//   hours. `window_activity` is output; a session's is the max across its windows.
// - Full-screen programs run on the alternate screen, which has no scrollback: `capture-pane -S`
//   gives only the screen. `history_size` doesn't say so: it is 0 for a Claude that is the pane's
//   own process, but counts the shell's lines for one started from a shell. `alternate_on` does.
// - `rename-session` expands formats in the new name: "#S" and "#{...}" are replaced, "##" is a
//   literal "#". `#(...)` isn't run, it becomes empty.
import * as fs from "node:fs";
import * as path from "node:path";
import { run } from "./runner.ts";
import type { Runner } from "./runner.ts";

export interface Pane {
  /** tmux pane id, "%3". */
  id: string;
  /** The pane's main process. */
  pid: number;
  /** The active pane of the session's current window. */
  active: boolean;
  width: number;
  height: number;
  /** Lines of scrollback tmux holds. */
  history: number;
  /** On the alternate screen, where that scrollback can't be reached. */
  alternate: boolean;
  /** Foreground command. */
  command: string;
  path: string;
}

export interface Session {
  /** tmux session id, "$3". Stable across renames; reset when the server restarts. */
  id: string;
  name: string;
  windows: number;
  /** Unix seconds. */
  created: number;
  /** Number of attached clients. */
  attached: number;
  /** Unix seconds of the last output in any window (`window_activity`, the max). */
  activity: number;
  /** Unix seconds of the last client input (`session_activity`). Not output: see above. */
  input: number;
  /** Active pane of the current window. */
  command: string;
  path: string;
  panes: Pane[];
}

export const FIELDS = [
  "session_id",
  "session_name",
  "session_windows",
  "session_created",
  "session_attached",
  "session_activity",
  "window_activity",
  "window_active",
  "pane_active",
  "pane_id",
  "pane_pid",
  "pane_width",
  "pane_height",
  "history_size",
  "alternate_on",
  "pane_current_command",
  "pane_current_path", // last, so a tab in a path can't shift the other fields
] as const;
export const FORMAT = FIELDS.map((f) => `#{${f}}`).join("\t");

const int = (s: string | undefined): number => {
  const n = Number(s);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
};

/** Parses `list-panes -a -F FORMAT` output into sessions. Lines that don't look like a pane are skipped. */
export function parseSessions(out: string): Session[] {
  const sessions = new Map<string, Session>();
  for (const line of out.split("\n")) {
    if (line === "") continue;
    const f = line.split("\t");
    if (f.length < FIELDS.length || !/^\$\d+$/.test(f[0]!)) continue;
    const pane: Pane = {
      id: f[9]!,
      pid: int(f[10]),
      active: f[7] === "1" && f[8] === "1",
      width: int(f[11]),
      height: int(f[12]),
      history: int(f[13]),
      alternate: f[14] === "1",
      command: f[15]!,
      path: f.slice(16).join("\t"),
    };
    let s = sessions.get(f[0]!);
    if (!s) {
      s = { id: f[0]!, name: f[1]!, windows: int(f[2]), created: int(f[3]), attached: int(f[4]), activity: 0, input: int(f[5]), command: pane.command, path: pane.path, panes: [] };
      sessions.set(s.id, s);
    }
    s.activity = Math.max(s.activity, int(f[6]));
    s.panes.push(pane);
    if (pane.active) {
      s.command = pane.command;
      s.path = pane.path;
    }
  }
  return [...sessions.values()];
}

/** POSIX shell single quoting: 'it'\''s' — safe for any string without NUL. */
export function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/**
 * The command a user pastes into a terminal to attach. `=` makes tmux match the name exactly,
 * so "foo" never attaches "foo2" and a session named "$1" isn't taken for an id.
 */
export function attachCommand(name: string): string {
  return `tmux attach -t ${shellQuote(`=${name}`)}`;
}

/** Where tmux looks for its default socket: `$TMUX_TMPDIR` (or /tmp), `tmux-<uid>/default`. */
export function defaultSocketPath(env: NodeJS.ProcessEnv = process.env, uid = process.getuid?.() ?? 0): string {
  return path.join(env.TMUX_TMPDIR || "/tmp", `tmux-${uid}`, "default");
}

export type ListResult = { kind: "ok"; sessions: Session[] } | { kind: "none"; reason: string };

/** tmux failed in a way that isn't "no server" (permission denied, tmux missing, …). */
export class TmuxError extends Error {}

export interface TmuxOptions {
  runner: Runner;
  /** Talk to this socket (`-S`) instead of the default one. Tests use a private socket. */
  socket?: string;
  /** For messages and the "no socket dir" check. Default: `defaultSocketPath()`. */
  defaultSocket?: string;
  /** Default `fs.existsSync`. */
  exists?: (p: string) => boolean;
}

export const SESSION_GONE = "That session doesn't exist anymore.";

function firstLine(s: string): string {
  return s.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
}

export class Tmux {
  private runner: Runner;
  private socket: string | undefined;
  readonly socketPath: string;
  private exists: (p: string) => boolean;

  constructor(opts: TmuxOptions) {
    this.runner = opts.runner;
    this.socket = opts.socket;
    this.socketPath = opts.socket ?? opts.defaultSocket ?? defaultSocketPath();
    this.exists = opts.exists ?? fs.existsSync;
  }

  private args(...rest: string[]): string[] {
    return ["-u", ...(this.socket ? ["-S", this.socket] : []), ...rest];
  }

  /** Lists sessions. "No server" in any of its forms is `{ kind: "none" }`, not an error. */
  async list(): Promise<ListResult> {
    // list-panes, not list-sessions: one call gives every window's activity and every pane's pid.
    const res = await run(this.runner, "tmux", this.args("list-panes", "-a", "-F", FORMAT)).catch((e: Error) => {
      throw new TmuxError(e.message);
    });
    if (res.code === 0) return { kind: "ok", sessions: parseSessions(res.stdout) };
    const msg = firstLine(res.stderr);
    const dir = path.dirname(this.socketPath);
    let m: RegExpExecArray | null;
    if ((m = /^no server running on (.*)$/.exec(msg))) {
      return { kind: "none", reason: `No tmux server running on ${m[1]}.` };
    }
    if ((m = /^error connecting to (.*) \((.*)\)$/.exec(msg))) {
      const [, sock, why] = m;
      if (/no such file or directory/i.test(why!)) {
        const sockDir = path.dirname(sock!);
        if (!this.exists(sockDir)) return { kind: "none", reason: `No tmux server has run for this user yet (${sockDir} doesn't exist).` };
        return { kind: "none", reason: `No tmux server running (no socket at ${sock}).` };
      }
      throw new TmuxError(`Can't connect to the tmux server at ${sock}: ${why}`);
    }
    if (!this.exists(dir)) return { kind: "none", reason: `No tmux server has run for this user yet (${dir} doesn't exist).` };
    throw new TmuxError(`tmux list-panes failed: ${msg || `exit code ${res.code}`}`);
  }

  /** Runs tmux; "that session is gone" in any form is one message. */
  private async session(what: string, ...args: string[]): Promise<string> {
    const res = await run(this.runner, "tmux", this.args(...args)).catch((e: Error) => {
      throw new TmuxError(e.message);
    });
    if (res.code === 0) return res.stdout;
    const msg = firstLine(res.stderr);
    if (/^can't find (session|pane|window)/.test(msg) || /^no server running/.test(msg) || /^error connecting to .*No such file/i.test(msg)) {
      throw new TmuxError(SESSION_GONE);
    }
    throw new TmuxError(`tmux ${what} failed: ${msg || `exit code ${res.code}`}`);
  }

  /**
   * Kills a session. `target` is "=<name>" (exact name) or "$<n>" (session id); both match
   * exactly, so "foo" never kills "foo2".
   */
  async kill(target: string): Promise<void> {
    await this.session("kill-session", "kill-session", "-t", target);
  }

  /**
   * Renames the session with this id and returns the name it really got: tmux turns ":" and "."
   * into "_". The id stays, so rows and an open page follow the session.
   */
  async rename(id: string, name: string): Promise<string> {
    const wanted = name.trim();
    if (wanted === "") throw new TmuxError("The name can't be empty.");
    const literal = wanted.replaceAll("#", "##"); // rename-session expands formats
    const res = await run(this.runner, "tmux", this.args("rename-session", "-t", id, "--", literal)).catch((e: Error) => {
      throw new TmuxError(e.message);
    });
    const msg = firstLine(res.stderr);
    if (res.code !== 0) {
      const dup = /^duplicate session: (.*)$/.exec(msg);
      if (dup) throw new TmuxError(`There is already a session named '${dup[1]}'.`);
      if (/^can't find session/.test(msg) || /^no server running/.test(msg) || /^error connecting to .*No such file/i.test(msg)) throw new TmuxError(SESSION_GONE);
      throw new TmuxError(`tmux rename-session failed: ${msg || `exit code ${res.code}`}`);
    }
    return (await this.session("display-message", "display-message", "-p", "-t", id, "#{session_name}")).replace(/\n$/, "");
  }

  /**
   * The visible screen of a session's active pane, with colours as SGR escapes (`-e`). Screen
   * contents can hold secrets: never publish this in state or log it.
   */
  capture(id: string): Promise<string> {
    return this.session("capture-pane", "capture-pane", "-p", "-e", "-t", `${id}:`);
  }

  /** The same, with up to `lines` lines of scrollback above the screen. */
  captureHistory(id: string, lines: number): Promise<string> {
    return this.session("capture-pane", "capture-pane", "-p", "-e", "-S", String(-lines), "-t", `${id}:`);
  }

  /** Argv of a tmux client attached to a session by exact name. For a terminal to run. */
  attachArgv(name: string): string[] {
    return ["tmux", ...this.args("attach-session", "-t", `=${name}`)];
  }
}

// ---- display ----

/** "just now", "5 min ago", "3 h ago", "2 d ago". Coarse on purpose: it changes rarely. */
export function ago(unixSeconds: number, nowMs: number): string {
  const s = Math.max(0, Math.floor(nowMs / 1000) - unixSeconds);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function attachedText(n: number): string {
  return n > 0 ? `attached (${plural(n, "client")})` : "detached";
}

/** Shortens a path under $HOME to ~/… */
export function tildify(p: string, home: string | undefined): string {
  if (!home || home === "/") return p;
  if (p === home) return "~";
  return p.startsWith(home + "/") ? `~${p.slice(home.length)}` : p;
}

export interface SessionRow {
  [k: string]: string | number | boolean;
  id: string;
  name: string;
  windows: number;
  attached: number;
  created: number;
  /** Second line: windows, attached/detached, created, last activity, active pane. */
  detail: string;
  /** "claude · ~/project": the active pane, for the session list. */
  where: string;
  /** The active pane's program and folder, on their own. */
  command: string;
  path: string;
  /** Appended to the kill confirm text: "" or " It is attached (2 clients)." */
  attachedNote: string;
  attachCommand: string;
}

/** The state map key for a session: its id without the "$" ("$3" → "3"). */
export const sessionKey = (id: string): string => id.replace(/^\$/, "");

export function sessionRow(s: Session, nowMs: number, home: string | undefined): SessionRow {
  const where = [s.command, s.path && tildify(s.path, home)].filter(Boolean);
  const parts = [plural(s.windows, "window"), attachedText(s.attached), `created ${ago(s.created, nowMs)}`, `active ${ago(s.activity, nowMs)}`];
  if (where.length) parts.push(where.join(" in "));
  return {
    id: s.id,
    name: s.name,
    windows: s.windows,
    attached: s.attached,
    created: s.created,
    // No raw activity time: it changes on every keystroke. The coarse "active … ago" in
    // `detail` changes at most once a minute, so a busy session isn't a delta every poll.
    detail: parts.join(" · "),
    where: where.join(" · "),
    command: s.command,
    path: s.path && tildify(s.path, home),
    attachedNote: s.attached > 0 ? ` It is attached (${plural(s.attached, "client")}).` : "",
    attachCommand: attachCommand(s.name),
  };
}
