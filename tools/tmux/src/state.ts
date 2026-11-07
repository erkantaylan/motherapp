// What a session is doing. Claude says so itself when its status file can be read (claude.ts);
// anything else is judged from pane output, so this works for any program:
//   working  output within the last WORKING_SECONDS
//   idle     no recent output, sitting at a shell or an interactive agent
//   quiet    no recent output, some other program in the foreground
export type SessionState = "working" | "idle" | "quiet" | "waiting";

export const WORKING_SECONDS = 3;
export const SHELLS: ReadonlySet<string> = new Set(["bash", "zsh", "fish", "sh", "dash"]);
export const INTERACTIVE_AGENTS: ReadonlySet<string> = new Set(["claude", "codex", "opencode", "amp", "gemini"]);

/** From pane output. `activity` is Unix seconds (tmux's `window_activity`, the session's max). */
export function outputState(activity: number, command: string, nowMs: number): SessionState {
  if (Math.floor(nowMs / 1000) - activity <= WORKING_SECONDS) return "working";
  return SHELLS.has(command) || INTERACTIVE_AGENTS.has(command) ? "idle" : "quiet";
}

/**
 * From Claude's reported status; undefined for a value we don't know, so the caller falls back.
 * Measured: "busy" lasts while a sub-agent runs, even after the main turn ended. "shell" is the
 * turn over with only a background command left; Claude wakes up when that ends, so it counts as
 * working and "finished" waits for "idle".
 */
export function claudeState(status: string): SessionState | undefined {
  if (status === "busy" || status === "shell") return "working";
  if (status === "idle") return "idle";
  if (status === "waiting") return "waiting";
  return undefined;
}

/** Untouched this long, a session is flagged. Longer than a weekend, so Monday isn't a sea of flags. */
export const STALE_DAYS = 3;

/** Whole days without output, from STALE_DAYS on, for a session at rest; otherwise undefined. */
export function staleDays(activity: number, state: SessionState, nowMs: number): number | undefined {
  if (state === "working" || state === "waiting") return undefined;
  const days = Math.floor((nowMs / 1000 - activity) / 86400);
  return days >= STALE_DAYS ? days : undefined;
}
