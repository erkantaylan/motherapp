// tmux access for the inbox: list panes, capture one, type into one. Reuses the tmux tool's
// Runner, `run` and socket helpers (tools/tmux/src/), and follows its rules (docs/lessons/
// 2026-10-20-tmux-tool.md): every call passes `-u`, and targets are exact. Here the target is
// always a pane id (`%3`), which tmux matches exactly; names like `motherapp:0.0` are only
// resolved by us, by string equality against `list-panes` output, never handed to tmux.
//
// Checked against tmux 3.4 (test/real-tmux.test.ts):
// - `display-message -p -t %99` on a missing pane exits 0 with empty output, so existence is
//   checked with `list-panes -a`, not display-message. `send-keys -t %99` fails ("can't find pane").
// - `pane_current_command` is the basename of argv[0] of the pane's foreground process. A
//   `#!/bin/sh` script named `claude` shows as `sh`; a binary (or symlink) named `claude`, or a
//   Node program that sets `process.title = "claude"` (Claude Code does), shows as `claude`.
import { run } from "../../tmux/src/runner.ts";
import type { Runner } from "../../tmux/src/runner.ts";
import { defaultSocketPath } from "../../tmux/src/tmux.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmuxLiteralArg } from "./clean.ts";

export interface Pane {
  /** tmux pane id, "%3": unique while the server runs, exact as a target. */
  id: string;
  /** "session:window.pane", for people. */
  target: string;
  session: string;
  /** pid of the pane's first process (its shell). Changes if the pane is a different one. */
  pid: number;
  /** Copy mode or another mode is active (`#{pane_in_mode}`). */
  inMode: boolean;
  /** Clients attached to the pane's session. */
  attached: number;
  command: string;
  path: string;
}

export const PANE_FIELDS = [
  "pane_id",
  "session_name",
  "window_index",
  "pane_index",
  "pane_pid",
  "pane_in_mode",
  "session_attached",
  "pane_current_command",
  "pane_current_path", // last, so a tab in a path can't shift the other fields
] as const;
export const PANE_FORMAT = PANE_FIELDS.map((f) => `#{${f}}`).join("\t");

const int = (s: string | undefined): number => {
  const n = Number(s);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
};

export function parsePanes(out: string): Pane[] {
  const panes: Pane[] = [];
  for (const line of out.split("\n")) {
    if (line === "") continue;
    const f = line.split("\t");
    if (f.length < PANE_FIELDS.length || !/^%\d+$/.test(f[0]!)) continue;
    panes.push({
      id: f[0]!,
      session: f[1]!,
      target: `${f[1]}:${f[2]}.${f[3]}`,
      pid: int(f[4]),
      inMode: f[5] === "1",
      attached: int(f[6]),
      command: f[7]!,
      path: f.slice(8).join("\t"),
    });
  }
  return panes;
}

/**
 * Which panes run Claude Code. `pane_current_command` must be:
 * - exactly `claude` (the npm install sets `process.title = "claude"`; the native installer's
 *   `~/.local/bin/claude` symlink is invoked by that name), or
 * - a bare version number like `2.0.31` (the native installer's binary lives at
 *   `~/.local/share/claude/versions/<version>`, so started by its full path it shows as that), or
 * - a name listed in the settings' `paneCommands`.
 * `node` is deliberately not matched: any Node program would. Matching is case-sensitive.
 */
export function isClaudeCommand(command: string, extra: readonly string[] = []): boolean {
  if (command === "claude") return true;
  if (/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(command)) return true;
  return extra.includes(command);
}

export type PaneList = { kind: "ok"; panes: Pane[] } | { kind: "none"; reason: string };

export class TmuxError extends Error {}

export interface PanesOptions {
  runner: Runner;
  /** `-S <socket>` instead of the default server (tests use a private socket). */
  socket?: string;
  defaultSocket?: string;
  exists?: (p: string) => boolean;
}

const firstLine = (s: string) => s.split("\n").map((l) => l.trim()).find(Boolean) ?? "";

export class TmuxPanes {
  private runner: Runner;
  private socket: string | undefined;
  readonly socketPath: string;
  private exists: (p: string) => boolean;

  constructor(opts: PanesOptions) {
    this.runner = opts.runner;
    this.socket = opts.socket;
    this.socketPath = opts.socket ?? opts.defaultSocket ?? defaultSocketPath();
    this.exists = opts.exists ?? fs.existsSync;
  }

  private args(...rest: string[]): string[] {
    return ["-u", ...(this.socket ? ["-S", this.socket] : []), ...rest];
  }

  private async tmux(...rest: string[]) {
    return run(this.runner, "tmux", this.args(...rest)).catch((e: Error) => {
      throw new TmuxError(e.message);
    });
  }

  /** All panes of all sessions. "No server" is `{ kind: "none" }`, as in the tmux tool. */
  async list(): Promise<PaneList> {
    const res = await this.tmux("list-panes", "-a", "-F", PANE_FORMAT);
    if (res.code === 0) return { kind: "ok", panes: parsePanes(res.stdout) };
    const msg = firstLine(res.stderr);
    if (/^no server running on /.test(msg) || /^error connecting to .* \(No such file or directory\)$/i.test(msg)) {
      return { kind: "none", reason: "No tmux server is running." };
    }
    if (!this.exists(path.dirname(this.socketPath))) return { kind: "none", reason: "No tmux server has run for this user yet." };
    throw new TmuxError(`tmux list-panes failed: ${msg || `exit code ${res.code}`}`);
  }

  /** The pane with this id, if it exists. */
  async find(id: string): Promise<Pane | undefined> {
    const r = await this.list();
    return r.kind === "ok" ? r.panes.find((p) => p.id === id) : undefined;
  }

  /** The visible screen of a pane, as plain text (no escape sequences). */
  async capture(id: string): Promise<string> {
    assertPaneId(id);
    const res = await this.tmux("capture-pane", "-p", "-t", id);
    if (res.code !== 0) throw new TmuxError(`tmux capture-pane failed: ${firstLine(res.stderr) || `exit code ${res.code}`}`);
    return res.stdout;
  }

  /** Types `text` literally: `send-keys -t <id> -l -- <text>`. Never a newline, never Enter. */
  async sendLiteral(id: string, text: string): Promise<void> {
    assertPaneId(id);
    if (/[\r\n]/.test(text)) throw new TmuxError("refusing to type a line break");
    const res = await this.tmux("send-keys", "-t", id, "-l", "--", tmuxLiteralArg(text));
    if (res.code !== 0) throw new TmuxError(`tmux send-keys failed: ${firstLine(res.stderr) || `exit code ${res.code}`}`);
  }

  /** Presses Enter, as its own call: `send-keys -t <id> Enter`. */
  async sendEnter(id: string): Promise<void> {
    assertPaneId(id);
    const res = await this.tmux("send-keys", "-t", id, "Enter");
    if (res.code !== 0) throw new TmuxError(`tmux send-keys Enter failed: ${firstLine(res.stderr) || `exit code ${res.code}`}`);
  }
}

function assertPaneId(id: string): void {
  if (!/^%\d+$/.test(id)) throw new TmuxError(`not a pane id: ${id}`);
}

/**
 * Resolves what a user typed (`motherapp:0.0` or `%3`) to a pane, by exact string equality
 * (tmux's own target parsing would prefix-match session names).
 */
export function resolvePane(panes: Pane[], spec: string): Pane | undefined {
  return panes.find((p) => p.id === spec) ?? panes.find((p) => p.target === spec);
}
