// When to tell the user a session needs them. Pure: it sees one observation per session per poll
// and returns what to announce.
//
// Claude reports its own status, so its transitions are taken as they are: busy -> idle is
// "finished", anything -> waiting is "waiting". waiting -> idle is not: the user just dismissed
// the prompt.
//
// Anything else has only pane output to go on, and output doesn't mean work: a keystroke echoes,
// a resize redraws. So it must have run for MIN_WORK_SECONDS and then stayed silent for
// QUIET_SECONDS. Output up to the last key press doesn't count as work: `session_activity` moves
// on client input, so typing never adds up, while a build started by one Enter does.
//
// The first sight of a session sets a baseline and alerts nothing, so neither a service start
// nor a new session announces what is already there. A session changing between the two kinds
// (Claude exits, or starts) gets a new baseline too.
import type { SessionState } from "./state.ts";

export const MIN_WORK_SECONDS = 10;
export const QUIET_SECONDS = 5;

/** Also the notification kind ids in manifest.json's `notifications`. */
export type AlertWord = "finished" | "waiting";

export interface Observation {
  /** Stable for one session's life. */
  key: string;
  name: string;
  state: SessionState;
  /** `state` is Claude's own report. */
  claude: boolean;
  /** Unix seconds of the last output. */
  activity: number;
  /** Unix seconds of the last client input. */
  input: number;
}

export interface Alert {
  name: string;
  word: AlertWord;
}

/** The notification's title: the session's name and what happened, nothing from the pane. */
export function alertTitle(a: Alert): string {
  return a.word === "waiting" ? `${a.name} is waiting on you` : `${a.name} finished`;
}

interface Track {
  claude: boolean;
  state: SessionState;
  activity: number;
  /** The output run being watched, in Unix seconds. */
  run: { start: number; last: number } | undefined;
}

export class Alerter {
  private tracks = new Map<string, Track>();

  observe(sessions: Observation[], nowMs: number): Alert[] {
    const alerts: Alert[] = [];
    const now = Math.floor(nowMs / 1000);
    for (const o of sessions) {
      const t = this.tracks.get(o.key);
      if (!t || t.claude !== o.claude) {
        this.tracks.set(o.key, { claude: o.claude, state: o.state, activity: o.activity, run: undefined });
        continue;
      }
      const word = o.claude ? claudeAlert(t.state, o.state) : outputAlert(t, o, now);
      if (word) alerts.push({ name: o.name, word });
      t.state = o.state;
      t.activity = o.activity;
    }
    const seen = new Set(sessions.map((o) => o.key));
    for (const k of this.tracks.keys()) if (!seen.has(k)) this.tracks.delete(k);
    return alerts;
  }
}

function claudeAlert(before: SessionState, after: SessionState): AlertWord | undefined {
  if (after === "waiting" && before !== "waiting") return "waiting";
  if (after === "idle" && before === "working") return "finished";
  return undefined;
}

function outputAlert(t: Track, o: Observation, now: number): AlertWord | undefined {
  const fresh = o.activity > t.activity;
  // A run has ended once output stops for QUIET_SECONDS, or resumes after a longer gap than that.
  const ended = t.run && now - t.run.last >= QUIET_SECONDS && (!fresh || o.activity - t.run.last >= QUIET_SECONDS);
  let word: AlertWord | undefined;
  if (t.run && ended) {
    if (t.run.last - Math.max(t.run.start, o.input) >= MIN_WORK_SECONDS) word = "finished";
    t.run = undefined;
  }
  if (fresh) {
    if (t.run) t.run.last = o.activity;
    else t.run = { start: o.activity, last: o.activity };
  }
  return word;
}
