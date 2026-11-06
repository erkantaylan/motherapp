// Serve mode: polls tmux every POLL_MS, always, with or without a page open, because the state,
// timeline and notifications have to work while nobody looks (the tmux tool's exception to "poll
// only while watched", DESIGN.md § 3). A tick is one `tmux list-panes` plus a few small file reads
// and publishes only what changed. Rows are keyed by session id ($3 → "3"), so a rename updates
// its row in place. The preview and Claude's text are not polled here: the page asks for them
// with the `view` action, only while it is visible and only for the selected session.
//
// Screen contents and Claude's words can hold secrets, so they exist only in `view`'s result:
// never in state (the core caches it and sends it to every client) and never in a log.
import { RpcError } from "@motherapp/tool-sdk";
import type { JsonObject, JsonValue, Tool } from "@motherapp/tool-sdk";
import { Alerter } from "./alerts.ts";
import type { Observation } from "./alerts.ts";
import { ClaudeFiles } from "./claude.ts";
import type { ClaudeSource, ClaudeStatus } from "./claude.ts";
import { diffState } from "./diff.ts";
import type { Notifier } from "./notify.ts";
import { launch, openArgv, openEnv } from "./open.ts";
import type { Launcher } from "./open.ts";
import { claudeState, outputState } from "./state.ts";
import type { SessionState } from "./state.ts";
import { Timeline } from "./timeline.ts";
import { TmuxError, SESSION_GONE, sessionKey, sessionRow } from "./tmux.ts";
import type { Pane, Session, Tmux } from "./tmux.ts";

export interface Timers {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realTimers: Timers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export const POLL_MS = 1500;
/** A preview bigger than this is cut: a pane is a few KB, so this is only a guard. */
const MAX_PREVIEW = 512 * 1024;
export const INITIAL_STATE: JsonObject = { sessions: {} };

export interface ServiceOptions {
  tool: Tool;
  tmux: Tmux;
  notifier: Notifier;
  timers?: Timers;
  intervalMs?: number;
  home?: string | undefined;
  claude?: ClaudeSource;
  launcher?: Launcher;
}

/** What the last poll saw of a session. */
interface Seen {
  session: Session;
  state: SessionState;
  claude: ClaudeStatus | undefined;
}

const RANK: Record<string, number> = { waiting: 2, busy: 1 };

/** The session's Claude: the one that most needs attention, the active pane's on a tie. */
function sessionClaude(panes: Pane[], found: Map<number, ClaudeStatus>): ClaudeStatus | undefined {
  let best: { c: ClaudeStatus; score: number } | undefined;
  for (const p of panes) {
    const c = found.get(p.pid);
    if (!c || claudeState(c.status) === undefined) continue;
    const score = (RANK[c.status] ?? 0) * 2 + (p.active ? 1 : 0);
    if (!best || score > best.score) best = { c, score };
  }
  return best?.c;
}

export class TmuxService {
  private tool: Tool;
  private tmux: Tmux;
  private notifier: Notifier;
  private timers: Timers;
  private intervalMs: number;
  private home: string | undefined;
  private claude: ClaudeSource;
  private launcher: Launcher;
  private alerter = new Alerter();
  private timeline = new Timeline();
  private seen = new Map<string, Seen>();
  private timer: unknown;
  private inflight: Promise<void> | undefined;
  private running = false;
  private lastProblem = "";

  constructor(opts: ServiceOptions) {
    this.tool = opts.tool;
    this.tmux = opts.tmux;
    this.notifier = opts.notifier;
    this.timers = opts.timers ?? realTimers;
    this.intervalMs = opts.intervalMs ?? POLL_MS;
    this.home = "home" in opts ? opts.home : process.env.HOME;
    this.claude = opts.claude ?? new ClaudeFiles();
    this.launcher = opts.launcher ?? launch;
    this.registerActions();
  }

  start(): void {
    this.running = true;
    if (!this.tool.isStale("sessions")) this.tool.markStale("sessions"); // until the first poll
    void this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private async tick(): Promise<void> {
    await this.poll();
    if (this.running) this.timer = this.timers.setTimeout(() => void this.tick(), this.intervalMs);
  }

  /** One poll. A call while one is running shares it. */
  poll(): Promise<void> {
    this.inflight ??= this.pollOnce().finally(() => (this.inflight = undefined));
    return this.inflight;
  }

  private async pollOnce(): Promise<void> {
    const t = this.tool;
    try {
      const res = await this.tmux.list();
      const sessions = res.kind === "ok" ? res.sessions : [];
      this.publish(this.observe(sessions) as unknown as JsonValue);
      if (res.kind === "none") this.setStatus(res.reason);
      else this.setStatus(undefined);
      this.problem("");
    } catch (e) {
      const msg = e instanceof TmuxError ? e.message : `tmux list-panes failed: ${(e as Error).message}`;
      this.problem(msg);
      if (!t.isStale("sessions")) t.markStale("sessions");
      this.setStatus(`${msg} Retrying every ${Math.round(this.intervalMs / 1000)} s.`);
    }
  }

  /** Works out each session's state, feeds the timeline and alerts, and returns the new rows. */
  private observe(sessions: Session[]): Record<string, JsonObject> {
    const now = this.timers.now();
    const found = this.claude.forPanes(new Set(sessions.flatMap((s) => s.panes.map((p) => p.pid))));
    const rows: Record<string, JsonObject> = {};
    const seen = new Map<string, Seen>();
    const observations: Observation[] = [];
    for (const s of sessions) {
      const claude = sessionClaude(s.panes, found);
      const state = (claude && claudeState(claude.status)) ?? outputState(s.activity, s.command, now);
      const key = sessionKey(s.id);
      // A server restart reuses ids, so a session's history goes by id and birth.
      const life = `${s.id}@${s.created}`;
      seen.set(key, { session: s, state, claude });
      this.timeline.add(life, state, now);
      observations.push({ key: life, name: s.name, state, claude: claude !== undefined, activity: s.activity, input: s.input });
      const agents = claude && this.claude.runningAgents(claude);
      rows[key] = { ...sessionRow(s, now, this.home), state, claude: claude !== undefined, timeline: this.timeline.encode(life, now), ...(agents ? { agents } : {}) };
    }
    this.seen = seen;
    this.timeline.keep(new Set(observations.map((o) => o.key)));
    for (const a of this.alerter.observe(observations, now)) this.notifier.send(a.name, a.word);
    return rows;
  }

  private publish(next: JsonValue): void {
    const t = this.tool;
    if (t.isStale("sessions")) {
      t.set("sessions", next); // one change for the whole map, and it is fresh again
      return;
    }
    for (const c of diffState("sessions", t.get("sessions"), next)) {
      if (c.value === null) t.delete(c.path);
      else t.set(c.path, c.value);
    }
  }

  private setStatus(text: string | undefined): void {
    const cur = this.tool.get("status");
    if (text === undefined) {
      if (cur !== undefined) this.tool.delete("status");
    } else if (cur !== text) {
      this.tool.set("status", text);
    }
  }

  /** Logs a listing problem once, and its recovery. */
  private problem(msg: string): void {
    if (msg === this.lastProblem) return;
    if (msg) this.tool.log.warn(msg);
    else this.tool.log.info("tmux sessions readable again");
    this.lastProblem = msg;
  }

  /** Claude's title and context for the session list, and the selected session's screen and text. */
  private async view(id: string | undefined): Promise<JsonValue> {
    const rows: JsonObject = {};
    for (const [key, s] of this.seen) {
      if (!s.claude) continue;
      const d = this.claude.details(s.claude.sessionId);
      rows[key] = { ...(d?.title ? { title: d.title } : {}), ...(d?.contextTokens ? { contextTokens: d.contextTokens } : {}) };
    }
    if (id === undefined) return { rows };
    const s = this.seen.get(id);
    if (!s) return { rows };
    const pane = s.session.panes.find((p) => p.active) ?? s.session.panes[0];
    let text: string | undefined;
    try {
      text = (await this.tmux.capture(`$${id}`)).slice(0, MAX_PREVIEW);
    } catch (e) {
      if (!(e instanceof TmuxError) || e.message !== SESSION_GONE) throw e;
    }
    const d = s.claude && this.claude.details(s.claude.sessionId);
    return {
      rows,
      selected: {
        id,
        ...(text !== undefined ? { text, cols: pane?.width ?? 0 } : {}),
        ...(s.claude
          ? {
              claude: {
                ...(d as JsonObject | undefined),
                ...(s.claude.name ? { name: s.claude.name } : {}),
                ...(s.claude.waitingFor ? { waitingFor: s.claude.waitingFor } : {}),
              },
            }
          : {}),
      },
    };
  }

  private idOf(args: JsonObject): string {
    const id = args.id;
    if (typeof id !== "string" || !/^\d+$/.test(id)) throw new RpcError(-32602, "id must be a tmux session id without the $");
    return id;
  }

  private registerActions(): void {
    this.tool.action("kill", async (args) => {
      const id = this.idOf(args);
      const name = this.tool.get(`sessions.${id}.name`);
      // By id: exact like "=<name>", and immune to a rename since the page last polled.
      await this.tmux.kill(`$${id}`);
      this.tool.log.info(`killed tmux session ${typeof name === "string" ? `'${name}'` : `$${id}`}`, { id: `$${id}` });
      await this.inflight;
      await this.poll(); // the row goes away now, not on the next tick
    });
    this.tool.action("rename", async (args) => {
      const id = this.idOf(args);
      if (typeof args.name !== "string") throw new RpcError(-32602, "name must be a string");
      const name = await this.tmux.rename(`$${id}`, args.name);
      this.tool.log.info(`renamed tmux session $${id} to '${name}'`, { id: `$${id}` });
      await this.inflight;
      await this.poll();
      return { name };
    });
    // Local only (manifest `localActions`): the core refuses both for anyone but this computer.
    this.tool.action("open", async (args) => {
      const id = this.idOf(args);
      // The name now, not the last poll's: a window attaches by name.
      const res = await this.tmux.list();
      const s = res.kind === "ok" ? res.sessions.find((x) => x.id === `$${id}`) : undefined;
      if (!s) throw new TmuxError(SESSION_GONE);
      await this.launcher(openArgv(this.tmux.attachArgv(s.name), process.env), openEnv(process.env));
      this.tool.log.info(`opened a terminal window on '${s.name}'`, { id: s.id });
    });
    this.tool.action("view", (args) => this.view(typeof args.id === "string" ? this.idOf(args) : undefined));
  }
}
