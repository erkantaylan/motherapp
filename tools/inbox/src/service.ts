// Serve mode: lists Claude panes, owns the links, the inbox listener, the tunnel and the queue.
//
// State published to the core (and so to every page): panes, links (id, label, pane, expiry,
// uses, the waiting messages, last 4 characters of the token), the delivery log, tunnel and
// listener status. NEVER a token or a full link: those only travel in the `create` action's result,
// which the core passes to the one client that asked and doesn't log or cache.
import { RpcError } from "@motherapp/tool-sdk";
import type { JsonObject, JsonValue, Tool } from "@motherapp/tool-sdk";
import type { Runner } from "../../tmux/src/runner.ts";
import { tildify } from "../../tmux/src/tmux.ts";
import { cleanLabel, cleanRef, cleanText, codePoints, deliveredLine } from "./clean.ts";
import { typeAndSubmit } from "./deliver.ts";
import type { DeliveryResult } from "./deliver.ts";
import { BODY_CAP, startInboxServer } from "./http.ts";
import type { InboxBackend, InboxServer, MessageBody, Reply } from "./http.ts";
import { idleState } from "./idle.ts";
import type { HoldCheck } from "./idle.ts";
import { QUEUE_MAX, RATE_PER_MINUTE, linkOptions } from "./limits.ts";
import { TmuxError, isClaudeCommand, resolvePane } from "./panes.ts";
import type { Pane, PaneList } from "./panes.ts";
import { RateLimiter } from "./ratelimit.ts";
import { saveScreen } from "./screens.ts";
import type { Settings } from "./settings.ts";
import { AGENT_SENTENCE, skillMarkdown } from "./skill.ts";
import { linkStatus } from "./store.ts";
import type { DeliveryEntry, LinkRecord, Store } from "./store.ts";
import { Tunnel } from "./tunnel.ts";
import type { TunnelInfo } from "./tunnel.ts";

export interface Timers {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realTimers: Timers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** What the service needs from tmux (TmuxPanes, or a fake). */
export interface PaneSource {
  list(): Promise<PaneList>;
  capture(id: string): Promise<string>;
  sendLiteral(id: string, text: string): Promise<void>;
  sendEnter(id: string): Promise<void>;
}

export const INITIAL_STATE: JsonObject = { panes: {}, links: {}, log: {}, activeCount: 0 };
/** Delivery log entries kept in the published state (the file keeps more). */
export const STATE_LOG_MAX = 100;

export interface ServiceOptions {
  tool: Tool;
  panes: PaneSource;
  store: Store;
  settings: Settings;
  /** For cloudflared. */
  runner: Runner;
  /** The inbox state dir; "Save screen" writes under `screens/` there. */
  stateDir: string;
  timers?: Timers;
  sleep?: (ms: number) => Promise<void>;
  home?: string | undefined;
  /** Pane list refresh. Default 3 s. */
  pollMs?: number;
  /** Queue retry. Default 1 s. */
  pumpMs?: number;
  /** Expiry sweep. Default 15 s. */
  sweepMs?: number;
  /** How long `create` waits for the tunnel's host. Default 30 s. */
  hostTimeoutMs?: number;
  cloudflared?: string;
}

interface Pending {
  /** Unique within this process, for "Deliver now". */
  qid: number;
  line: string;
  received: number;
  from: string;
}

interface Hold {
  reason: string;
  check: HoldCheck | "earlier-waiting" | "tmux-failed";
}

type Attempt = { kind: "done"; result: DeliveryResult } | ({ kind: "held" } & Hold) | { kind: "gone"; reason: string } | { kind: "skipped" };

export class InboxService {
  private tool: Tool;
  private panes: PaneSource;
  readonly store: Store;
  private settings: Settings;
  private opts: ServiceOptions;
  private timers: Timers;
  private sleep: (ms: number) => Promise<void>;
  private home: string | undefined;
  readonly tunnel: Tunnel;
  private server: InboxServer | undefined;
  private limiter = new RateLimiter(RATE_PER_MINUTE);
  private queues = new Map<string, Pending[]>();
  private held = new Map<string, Hold>();
  private nextQid = 1;
  private chain: Promise<unknown> = Promise.resolve();
  private timersOn: unknown[] = [];
  private running = false;
  private pumping = false;
  private lastPaneProblem = "";

  constructor(opts: ServiceOptions) {
    this.opts = opts;
    this.tool = opts.tool;
    this.panes = opts.panes;
    this.store = opts.store;
    this.settings = opts.settings;
    this.timers = opts.timers ?? realTimers;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.home = "home" in opts ? opts.home : process.env.HOME;
    this.tunnel = new Tunnel({
      runner: opts.runner,
      timers: this.timers,
      port: opts.settings.port,
      log: {
        info: (m, f) => this.tool.log.info(m, f),
        warn: (m, f) => this.tool.log.warn(m, f),
      },
      onChange: (info) => this.publishTunnel(info),
      ...(opts.cloudflared ? { command: opts.cloudflared } : {}),
    });
    this.registerActions();
  }

  get port(): number | undefined {
    return this.server?.port;
  }

  async start(): Promise<void> {
    this.running = true;
    const now = this.timers.now();
    this.store.prune(now);
    for (const p of this.store.problems) this.tool.log.warn(p);
    this.publishTunnel(this.tunnel.info());
    try {
      this.server = await startInboxServer(this.backend(), this.settings.port);
      this.tool.set("listener", { port: this.server.port, error: "" });
      this.tunnel.reconfigure(this.server.port);
    } catch (e) {
      const msg = `cannot listen on 127.0.0.1:${this.settings.port}: ${(e as Error).message}`;
      this.tool.set("listener", { port: this.settings.port, error: msg });
      this.tool.log.error(msg);
    }
    this.publishLinks();
    this.publishLog();
    const active = this.store.active(now);
    if (active.length > 0) {
      this.tool.log.warn(`${active.length} inbox link(s) active`, { ids: active.map((l) => l.id).join(",") });
      if (this.server) this.tunnel.start();
    }
    void this.pollPanes();
    this.every(this.opts.pollMs ?? 3000, () => this.pollPanes());
    this.every(this.opts.pumpMs ?? 1000, () => this.pump());
    this.every(this.opts.sweepMs ?? 15_000, async () => this.sweep());
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const t of this.timersOn) this.timers.clearTimeout(t);
    this.timersOn = [];
    this.tunnel.stop();
    await this.server?.close();
    this.server = undefined;
  }

  private every(ms: number, fn: () => Promise<void> | void): void {
    const slot = this.timersOn.length;
    const loop = () => {
      if (!this.running) return;
      void Promise.resolve()
        .then(fn)
        .catch((e: Error) => this.tool.log.warn(e.message))
        .finally(() => {
          if (this.running) this.timersOn[slot] = this.timers.setTimeout(loop, ms);
        });
    };
    this.timersOn[slot] = this.timers.setTimeout(loop, ms);
  }

  // ---- panes ----

  private isClaude(p: Pane): boolean {
    return isClaudeCommand(p.command, this.settings.paneCommands);
  }

  async pollPanes(): Promise<void> {
    let list: PaneList;
    try {
      list = await this.panes.list();
    } catch (e) {
      const msg = e instanceof TmuxError ? e.message : `tmux failed: ${(e as Error).message}`;
      if (msg !== this.lastPaneProblem) this.tool.log.warn(msg);
      this.lastPaneProblem = msg;
      this.setIfChanged("panesStatus", msg);
      return;
    }
    if (this.lastPaneProblem) this.tool.log.info("tmux panes readable again");
    this.lastPaneProblem = "";
    const rows: Record<string, JsonObject> = {};
    if (list.kind === "ok") {
      for (const p of list.panes) {
        if (!this.isClaude(p)) continue;
        rows[p.id.slice(1)] = {
          id: p.id,
          target: p.target,
          path: tildify(p.path, this.home),
          attached: p.attached > 0 ? "attached" : "detached",
          command: p.command,
        };
      }
    }
    this.setIfChanged("panesStatus", list.kind === "none" ? list.reason : Object.keys(rows).length === 0 ? "No tmux pane is running Claude." : "");
    const cur = this.tool.get("panes") as Record<string, JsonValue> | undefined;
    if (JSON.stringify(cur ?? {}) !== JSON.stringify(rows)) this.tool.set("panes", rows as JsonObject);
  }

  private setIfChanged(path: string, value: string): void {
    if (this.tool.get(path) !== value) this.tool.set(path, value);
  }

  // ---- publishing ----

  private publishTunnel(info: TunnelInfo): void {
    const warning = "Quick tunnel: its URL changes whenever cloudflared restarts (or motherapp does), and links made before stop working.";
    this.tool.set("tunnel", { ...info, warning } as unknown as JsonObject);
    if (this.running) this.publishLinks();
  }

  /** Active links only, keyed by id. */
  publishLinks(): void {
    const now = this.timers.now();
    const tunnel = this.tunnel.info();
    const rows: Record<string, JsonObject> = {};
    const active = this.store.active(now);
    for (const l of active) {
      const q = this.queues.get(l.id) ?? [];
      const pending = q.length;
      const hold = pending > 0 ? this.held.get(l.id) : undefined;
      rows[l.id] = {
        id: l.id,
        label: l.label,
        pane: l.pane.target,
        paneId: l.pane.id,
        created: l.created,
        expires: l.expires,
        uses: l.uses,
        last4: l.last4,
        pending,
        held: hold?.reason ?? "",
        check: hold?.check ?? "",
        // The waiting lines, for "Deliver now" (the delivery log shows the same text).
        queued: q.map((p) => ({ qid: p.qid, received: p.received, text: p.line })),
        // A quick tunnel's host changes on restart; a link made for the old host is dead.
        hostChanged: tunnel.host !== "" && l.host !== "" && l.host !== tunnel.host,
      };
    }
    const cur = this.tool.get("links") as JsonValue | undefined;
    if (JSON.stringify(cur ?? {}) !== JSON.stringify(rows)) this.tool.set("links", rows as JsonObject);
    if (this.tool.get("activeCount") !== active.length) this.tool.set("activeCount", active.length);
  }

  private publishLog(): void {
    const entries = this.store.deliveries().slice(-STATE_LOG_MAX);
    const rows: Record<string, JsonObject> = {};
    for (const e of entries) rows[String(e.seq)] = e as unknown as JsonObject;
    this.tool.set("log", rows);
  }

  private addLog(link: Pick<LinkRecord, "id" | "label" | "pane">, text: string, result: string, from = "", check = ""): DeliveryEntry {
    const e = this.store.addDelivery({ time: this.timers.now(), linkId: link.id, label: link.label, pane: link.pane.target, text, result, ...(from ? { from } : {}) });
    this.tool.set(`log.${e.seq}`, e as unknown as JsonObject);
    const keys = Object.keys((this.tool.get("log") as JsonObject | undefined) ?? {});
    for (const k of keys.slice(0, Math.max(0, keys.length - STATE_LOG_MAX))) this.tool.delete(`log.${k}`);
    // Never the text or the token in the journal: the id, the pane and the outcome.
    this.tool.log.info(`inbox message ${result}`, { link: link.id, pane: link.pane.target, chars: codePoints(text), ...(check ? { check } : {}) });
    return e;
  }

  /** Records why a link's messages wait; logs (check name only) when that changes. */
  private setHold(link: Pick<LinkRecord, "id" | "pane">, hold: Hold): void {
    const before = this.held.get(link.id);
    this.held.set(link.id, hold);
    if (before && before.check !== hold.check) this.tool.log.info(`inbox message still held: ${hold.reason}`, { link: link.id, pane: link.pane.target, check: hold.check });
  }

  // ---- delivery ----

  /** Runs `fn` after every earlier delivery step (one pane write at a time, in order). */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /**
   * The link's pane, if it is still the same pane (same id AND same pid: after a tmux restart
   * a new pane can get the old id) and still runs Claude. Types nothing.
   */
  private async boundPane(link: LinkRecord): Promise<Pane | { gone: string }> {
    const list = await this.panes.list();
    const pane = list.kind === "ok" ? list.panes.find((p) => p.id === link.pane.id) : undefined;
    if (!pane || pane.pid !== link.pane.pid) return { gone: "the pane is gone" };
    if (!this.isClaude(pane)) return { gone: `the pane runs ${pane.command || "something else"}, not Claude` };
    return pane;
  }

  /**
   * Checks the pane is the same Claude pane (and idle, with checkScreen), then types the line.
   * `still` runs first in the serial slot: false (the message was delivered by hand meanwhile)
   * skips it.
   */
  private attempt(link: LinkRecord, line: string, still: () => boolean = () => true): Promise<Attempt> {
    return this.serial(async () => {
      if (!still()) return { kind: "skipped" };
      const pane = await this.boundPane(link);
      if ("gone" in pane) return { kind: "gone", reason: pane.gone };
      const checkScreen = this.settings.checkScreen === true;
      if (checkScreen) {
        const idle = idleState(await this.panes.capture(pane.id), pane.inMode);
        if (!idle.idle) return { kind: "held", reason: idle.reason, check: idle.check };
      }
      const d = await typeAndSubmit({ keys: this.panes, sleep: this.sleep, delayMs: this.settings.sendDelayMs, verifyDelayMs: this.settings.verifyDelayMs, checkScreen }, pane.id, line);
      return { kind: "done", result: d.result };
    });
  }

  private enqueue(link: LinkRecord, line: string, hold: Hold, from: string): number {
    const q = this.queues.get(link.id) ?? [];
    q.push({ qid: this.nextQid++, line, received: this.timers.now(), from });
    this.queues.set(link.id, q);
    this.held.set(link.id, hold);
    this.publishLinks();
    return q.length;
  }

  /** Takes one waiting message out of its queue. */
  private unqueue(id: string, p: Pending): void {
    const q = this.queues.get(id);
    if (!q) return;
    const i = q.indexOf(p);
    if (i >= 0) q.splice(i, 1);
    if (q.length === 0) {
      this.queues.delete(id);
      this.held.delete(id);
    }
  }

  private drop(id: string, why: string): void {
    const q = this.queues.get(id);
    this.queues.delete(id);
    this.held.delete(id);
    if (!q || q.length === 0) return;
    const link = this.store.get(id);
    for (const p of q) this.addLog(link ?? { id, label: "?", pane: { id: "", target: "?", pid: 0, path: "" } }, p.line, `dropped: ${why}`, p.from);
  }

  /** Tries the head of each queue once. */
  async pump(): Promise<void> {
    if (this.pumping || this.queues.size === 0) return;
    this.pumping = true;
    try {
      const now = this.timers.now();
      for (const id of [...this.queues.keys()]) {
        const q = this.queues.get(id);
        const link = this.store.get(id);
        if (!q || q.length === 0) continue;
        if (!link || linkStatus(link, now) === "revoked" || now >= link.expires) {
          this.drop(id, link ? `link ${linkStatus(link, now)}` : "link gone");
          continue;
        }
        const head = q[0]!;
        let a: Attempt;
        try {
          a = await this.attempt(link, head.line, () => this.queues.get(id)?.includes(head) === true);
        } catch (e) {
          a = { kind: "held", reason: `tmux failed: ${(e as Error).message}`, check: "tmux-failed" };
        }
        if (a.kind === "gone") this.drop(id, a.reason);
        else if (a.kind === "held") this.setHold(link, { reason: a.reason, check: a.check });
        else if (a.kind === "done") {
          this.unqueue(id, head);
          this.addLog(link, head.line, a.result, head.from);
        }
      }
    } finally {
      this.pumping = false;
      this.publishLinks();
    }
  }

  private sweep(): void {
    const now = this.timers.now();
    for (const id of [...this.queues.keys()]) {
      const l = this.store.get(id);
      if (!l || linkStatus(l, now) === "revoked" || now >= l.expires) this.drop(id, l ? `link ${linkStatus(l, now)}` : "link gone");
    }
    this.publishLinks();
    if (this.store.active(now).length === 0 && this.tunnel.running) this.tunnel.stop();
  }

  // ---- HTTP ----

  backend(): InboxBackend {
    return {
      lookup: (token) => this.store.verify(token, this.timers.now())?.id,
      skill: (id) => {
        const l = this.store.get(id)!;
        return skillMarkdown(l, { perMinute: RATE_PER_MINUTE, bodyCap: BODY_CAP, queueMax: QUEUE_MAX });
      },
      rateLimit: (id) => this.limiter.hit(id, this.timers.now()),
      message: (id, body, from) => this.message(id, body, from),
      onError: (msg) => this.tool.log.error(msg),
    };
  }

  async message(id: string, body: MessageBody, from = ""): Promise<Reply> {
    const now = this.timers.now();
    const link = this.store.get(id);
    if (!link || linkStatus(link, now) !== "active") return { status: 404, body: { error: "not found" } };
    const text = cleanText(body.text);
    if (text === "") return { status: 400, body: { error: "\"text\" is empty" } };
    const queued = this.queues.get(id)?.length ?? 0;
    if (queued >= QUEUE_MAX) return { status: 429, body: { error: `${queued} messages are already waiting; try later` }, headers: { "retry-after": "60" } };
    const line = deliveredLine(link.label, text, cleanRef(body.ref));

    let a: Attempt;
    if (queued > 0) {
      // Keep the order: behind the ones already waiting. Still refuse if the pane is gone.
      const pane = await this.serial(() => this.boundPane(link));
      a = "gone" in pane ? { kind: "gone", reason: pane.gone } : { kind: "held", ...(this.held.get(id) ?? { reason: "earlier messages are waiting", check: "earlier-waiting" }) };
    } else {
      a = await this.attempt(link, line);
    }
    if (a.kind === "gone") {
      this.addLog(link, line, `rejected: ${a.reason}`, from);
      return { status: 409, body: { error: `Claude isn't running in pane ${link.pane.target} any more (${a.reason}); nothing was typed` } };
    }
    this.store.recordUse(id);
    if (a.kind === "held") {
      const pending = this.enqueue(link, line, { reason: a.reason, check: a.check }, from);
      this.addLog(link, line, `queued: ${a.reason}`, from, a.check);
      return { status: 202, body: { status: "queued", pending, reason: a.reason } };
    }
    if (a.kind === "skipped") throw new Error("unreachable: a new message is never skipped");
    this.publishLinks();
    this.addLog(link, line, a.result, from);
    if (a.result.startsWith("not submitted")) return { status: 202, body: { status: "typed", result: a.result } };
    return { status: 200, body: { status: "delivered", result: a.result } };
  }

  // ---- actions ----

  private registerActions(): void {
    const t = this.tool;

    t.action("create", async (args, ctx) => {
      let opts;
      try {
        opts = linkOptions(args);
      } catch (e) {
        throw new RpcError(-32602, (e as Error).message);
      }
      const spec = typeof args.pane === "string" ? args.pane.trim() : "";
      if (!spec) throw new RpcError(-32602, "pick a pane (e.g. motherapp:0.0)");
      const label = cleanLabel(typeof args.label === "string" ? args.label : "");
      if (!this.server) throw new Error("the inbox listener isn't running (see its error above)");
      const list = await this.panes.list();
      const pane = list.kind === "ok" ? resolvePane(list.panes, spec) : undefined;
      if (!pane) throw new Error(`no tmux pane ${spec}`);
      if (!this.isClaude(pane)) throw new Error(`pane ${pane.target} runs ${pane.command || "nothing"}, not Claude`);
      const wasRunning = this.tunnel.running;
      this.tunnel.start();
      ctx.progress("waiting for the tunnel…");
      let host: string;
      try {
        host = await this.tunnel.waitForHost(this.opts.hostTimeoutMs ?? 30_000);
      } catch (e) {
        if (!wasRunning && this.store.active(this.timers.now()).length === 0) this.tunnel.stop();
        throw e;
      }
      const { link, token } = this.store.create(
        { ...opts, label, pane: { id: pane.id, target: pane.target, pid: pane.pid, path: pane.path }, host },
        this.timers.now(),
      );
      this.publishLinks();
      t.log.info("inbox link created", { link: link.id, label, pane: pane.target, expires: new Date(link.expires).toISOString() });
      const url = `https://${host}/inbox/${token}`;
      return { id: link.id, label, pane: pane.target, expires: link.expires, link: url, message: `${url}\n${AGENT_SENTENCE}` };
    });

    t.action("revoke", async (args) => {
      const id = typeof args.id === "string" ? args.id : "";
      if (!this.store.revoke(id, this.timers.now())) throw new Error(`no active link with id ${id || "(none)"}`);
      this.limiter.forget(id);
      this.drop(id, "link revoked");
      t.log.info("inbox link revoked", { link: id });
      this.publishLinks();
      if (this.store.active(this.timers.now()).length === 0) this.tunnel.stop();
      return { id };
    });

    // A person's override from the page: type one waiting message now, although the pane
    // doesn't look idle. Same two-call send of the same cleaned line; copy mode still refuses.
    t.action("deliverNow", async (args) => {
      const id = typeof args.id === "string" ? args.id : "";
      const qid = Number(args.qid);
      const find = () => this.queues.get(id)?.find((p) => p.qid === qid);
      if (!find()) throw new Error("that message isn't waiting any more");
      const outcome = await this.serial(async (): Promise<{ result: string; error?: string }> => {
        const p = find();
        if (!p) return { result: "", error: "that message isn't waiting any more (it was just delivered)" };
        const link = this.store.get(id);
        if (!link || linkStatus(link, this.timers.now()) !== "active") return { result: "", error: "the link is no longer active" };
        const pane = await this.boundPane(link);
        if ("gone" in pane) {
          this.drop(id, pane.gone);
          return { result: "", error: `nothing typed: ${pane.gone}` };
        }
        if (pane.inMode) return { result: "", error: "the pane is in copy mode; leave it (q) and try again" };
        this.unqueue(id, p);
        let result: string;
        try {
          const opts = { keys: this.panes, sleep: this.sleep, delayMs: this.settings.sendDelayMs, verifyDelayMs: this.settings.verifyDelayMs, force: true };
          result = (await typeAndSubmit(opts, pane.id, p.line)).result;
        } catch (e) {
          result = `failed (delivered now by hand): ${(e as Error).message}`;
        }
        this.addLog(link, p.line, result, p.from);
        return { result };
      });
      this.publishLinks();
      if (outcome.error) throw new Error(outcome.error);
      return { result: outcome.result };
    });

    // Saves a pane's screen for idle-detector fixtures (screens.ts). Logs the file, not the screen.
    t.action("saveScreen", async (args) => {
      const spec = typeof args.pane === "string" ? args.pane.trim() : "";
      const list = await this.panes.list();
      const pane = list.kind === "ok" ? resolvePane(list.panes, spec) : undefined;
      if (!pane) throw new Error(`no tmux pane ${spec || "(none)"}`);
      const saved = await saveScreen(this.panes, this.opts.stateDir, pane.id, pane.inMode, this.timers.now());
      const file = tildify(saved.file, this.home);
      t.log.info("inbox screen saved", { pane: pane.target, file, verdict: saved.verdict.idle ? "idle" : saved.verdict.check });
      return { file, verdict: saved.verdict.idle ? "idle" : `busy: ${saved.verdict.reason}` };
    });

    t.action("refresh", async () => {
      await this.pollPanes();
      return null;
    });
  }
}
