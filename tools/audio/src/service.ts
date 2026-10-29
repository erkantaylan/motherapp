// Serve mode: keeps a model of the PipeWire graph from `pw-dump --monitor`, publishes only
// state deltas, and handles the page's actions and the mic level streams.
import { RpcError } from "@motherapp/tool-sdk";
import type { JsonObject, JsonValue, Tool } from "@motherapp/tool-sdk";
import { Coalescer } from "./coalescer.ts";
import { diffState } from "./diff.ts";
import { PwMonitor, realTimers } from "./monitor.ts";
import type { Timers } from "./monitor.ts";
import { AudioOps } from "./ops.ts";
import type { OpsOptions } from "./ops.ts";
import {
  DERIVED_KEYS,
  MASTER_KINDS,
  MAX_APP_VOLUME,
  MAX_MASTER_VOLUME,
  PwModel,
  appMuted,
  buildView,
  defaultDevice,
  masterItem,
  masterState,
  viewToState,
} from "./pipewire.ts";
import type { AppGroup, AudioView, Device, MasterKind, RouteOption } from "./pipewire.ts";
import type { Runner } from "./runner.ts";
import { selectRoute } from "./select.ts";

export interface ServiceOptions {
  tool: Tool;
  runner: Runner;
  timers?: Timers;
  ops?: Omit<OpsOptions, "runner" | "ownPid">;
  /** How long a finished pw-play's pid stays hidden (its node can outlive the process briefly). */
  ownPidGraceMs?: number;
  /** How long selecting a route waits for its node after a profile switch. */
  switchTimeoutMs?: number;
}

export const INITIAL_STATE: JsonObject = {
  sinks: {},
  sources: {},
  defaultSink: "",
  defaultSource: "",
  apps: {},
  master: { output: masterItem("output", undefined), input: masterItem("input", undefined) },
};

const invalid = (msg: string) => new RpcError(-32602, msg);

function argId(args: JsonObject): number {
  const id = args.id;
  const n = typeof id === "number" ? id : typeof id === "string" && /^\d+$/.test(id) ? Number(id) : NaN;
  if (!Number.isInteger(n)) throw invalid("id must be a PipeWire object id");
  return n;
}

/** A node id, or the key of a route with no node yet ("route-<card>-<index>"). */
function argTarget(args: JsonObject): number | string {
  if (typeof args.id === "string" && /^route-\d+-\d+$/.test(args.id)) return args.id;
  return argId(args);
}

function argKind(args: JsonObject): MasterKind {
  const k = args.kind ?? "output";
  if (k !== "output" && k !== "input") throw invalid('kind must be "output" or "input"');
  return k;
}

const isObj = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

function argApp(args: JsonObject): string {
  if (typeof args.app !== "string" || args.app === "") throw invalid("app must be a string");
  return args.app;
}

export class AudioService {
  readonly model = new PwModel();
  view: AudioView = { sinks: [], sources: [], sinkRoutes: [], sourceRoutes: [], cards: [], apps: [] };
  readonly ops: AudioOps;
  readonly monitor: PwMonitor;
  private tool: Tool;
  private timers: Timers;
  private writes = new Coalescer();
  private ownPids = new Map<number, unknown>();
  private graceMs: number;
  private switchTimeoutMs: number | undefined;
  /** Checked after every graph change; each returns true once it is done. */
  private viewWaiters = new Set<(view: AudioView) => boolean>();

  constructor(opts: ServiceOptions) {
    this.tool = opts.tool;
    this.switchTimeoutMs = opts.switchTimeoutMs;
    this.timers = opts.timers ?? realTimers;
    this.graceMs = opts.ownPidGraceMs ?? 5000;
    this.ops = new AudioOps({ ...opts.ops, runner: opts.runner, ownPid: (pid, running) => this.trackOwnPid(pid, running) });
    this.monitor = new PwMonitor({
      runner: opts.runner,
      timers: this.timers,
      log: this.tool.log,
      onBatch: (batch, first) => this.onBatch(batch, first),
      onDown: (reason, retryInMs) => this.onDown(reason, retryInMs),
    });
    this.registerActions();
  }

  /** Resets what can't be trusted from the state file and starts watching PipeWire. */
  start(): void {
    // Devices from the last run stay visible (stale) until the first dump; apps don't carry over.
    for (const k of DERIVED_KEYS) if (this.tool.get(k) === undefined) this.tool.set(k, INITIAL_STATE[k]!, { stale: true });
    this.tool.set("apps", {}, { stale: true });
    for (const k of DERIVED_KEYS) if (!this.tool.isStale(k)) this.tool.markStale(k);
    if (this.tool.get("status") !== undefined) this.tool.delete("status");
    // The master rows keep their last values (or a placeholder) and stay stale, row by row,
    // until the first dump confirms them, so the sliders start where they were.
    const saved = this.tool.get("master");
    const master: JsonObject = {};
    for (const k of MASTER_KINDS) {
      const old = isObj(saved) ? saved[k] : undefined;
      const base = masterItem(k, undefined);
      master[k] = isObj(old) ? { ...base, ...old, role: base.role!, order: base.order! } : base;
    }
    this.tool.set("master", master);
    for (const k of MASTER_KINDS) this.tool.markStale(`master.${k}`);
    this.monitor.start();
  }

  stop(): void {
    this.monitor.stop();
  }

  // ---- model → state ----

  onBatch(batch: unknown, first: boolean): void {
    if (first) this.model.clear(); // each pw-dump run starts with a full dump
    this.model.apply(batch);
    this.refresh(first);
  }

  private refresh(full = false): void {
    this.view = buildView(this.model.objects.values(), { isOwnPid: (pid) => this.ownPids.has(pid) });
    const next = viewToState(this.view);
    for (const key of DERIVED_KEYS) {
      if (full && this.tool.isStale(key)) {
        this.tool.set(key, next[key]); // one change for the whole key, and it is fresh again
        continue;
      }
      for (const c of diffState(key, this.tool.get(key), next[key])) {
        if (c.value === null) this.tool.delete(c.path);
        else this.tool.set(c.path, c.value);
      }
    }
    this.refreshMaster();
    if (full && this.tool.get("status") !== undefined) this.tool.delete("status");
    for (const w of [...this.viewWaiters]) if (w(this.view)) this.viewWaiters.delete(w);
  }

  /** Resolves with the first non-undefined pick(view), now or after a later graph change. */
  waitView<T>(pick: (view: AudioView) => T | undefined, timeoutMs: number): Promise<T | undefined> {
    return new Promise((resolve) => {
      const now = pick(this.view);
      if (now !== undefined) {
        resolve(now);
        return;
      }
      const timer = this.timers.setTimeout(() => {
        this.viewWaiters.delete(check);
        resolve(undefined);
      }, timeoutMs);
      const check = (view: AudioView) => {
        const v = pick(view);
        if (v === undefined) return false;
        this.timers.clearTimeout(timer);
        resolve(v);
        return true;
      };
      this.viewWaiters.add(check);
    });
  }

  /**
   * The master rows follow the defaults: deltas when the default's volume or mute changes, or
   * when the default switches. With no default (PipeWire restarting, or the device unplugged
   * before WirePlumber picks another) a row keeps its last values and is marked stale.
   */
  private refreshMaster(): void {
    const next = masterState(this.view);
    for (const k of MASTER_KINDS) {
      const path = `master.${k}`;
      const item = next[k];
      if (!item) {
        if (!this.tool.isStale(path)) this.tool.markStale(path);
        continue;
      }
      for (const c of diffState(path, this.tool.get(path), item)) {
        if (c.value === null) this.tool.delete(c.path);
        else this.tool.set(c.path, c.value);
      }
      if (this.tool.isStale(path)) this.tool.markFresh(path);
    }
  }

  private onDown(reason: string, retryInMs: number): void {
    for (const k of DERIVED_KEYS) this.tool.markStale(k);
    for (const k of MASTER_KINDS) if (!this.tool.isStale(`master.${k}`)) this.tool.markStale(`master.${k}`);
    this.tool.set("status", `Can't read PipeWire (pw-dump: ${reason}). Retrying in ${Math.round(retryInMs / 1000)} s.`);
  }

  private trackOwnPid(pid: number, running: boolean): void {
    const old = this.ownPids.get(pid);
    if (old !== undefined) this.timers.clearTimeout(old);
    if (running) this.ownPids.set(pid, undefined);
    else this.ownPids.set(pid, this.timers.setTimeout(() => this.ownPids.delete(pid), this.graceMs));
  }

  // ---- lookups ----

  device(id: number, kind?: "sink" | "source"): Device {
    const list = kind === "sink" ? this.view.sinks : kind === "source" ? this.view.sources : [...this.view.sinks, ...this.view.sources];
    const d = list.find((x) => x.id === id);
    if (!d) throw new Error(`That ${kind === "sink" ? "output" : kind === "source" ? "input" : "device"} is gone (id ${id})`);
    return d;
  }

  route(key: string): RouteOption {
    const r = [...this.view.sinkRoutes, ...this.view.sourceRoutes].find((x) => x.key === key);
    if (r) return r;
    const title = (this.tool.get(`sinks.${key}.title`) ?? this.tool.get(`sources.${key}.title`)) as string | undefined;
    throw new Error(`${title ?? "That output"} can't be selected any more (it is active already, or gone)`);
  }

  /** A row that is a route with no node can't play or record: say what to do instead. */
  private nodeFor(id: number | string, kind: "sink" | "source"): Device {
    if (typeof id === "number") return this.device(id, kind);
    const r = this.route(id);
    throw new Error(`${r.title} isn't active: select it first (that switches the card's profile)`);
  }

  /** The current default output or input, from the model (so writes hit the node the page shows). */
  defaultOf(kind: MasterKind): Device {
    const d = defaultDevice(this.view, kind);
    if (!d) throw new Error(`There is no default ${kind} right now`);
    return d;
  }

  private cardName(id: number): string {
    return this.view.cards.find((c) => c.id === id)?.description ?? `card ${id}`;
  }

  app(key: string): AppGroup {
    const a = this.view.apps.find((x) => x.key === key);
    if (!a) {
      const name = (this.tool.get(`apps.${key}.name`) as string | undefined) ?? "That app";
      throw new Error(`${name} is not playing sound anymore`);
    }
    return a;
  }

  // ---- actions ----

  private registerActions(): void {
    const t = this.tool;
    t.action("setDefault", async (args) => {
      const target = argTarget(args);
      if (typeof target === "string") {
        const opt = this.route(target);
        const how = opt.profile !== undefined ? `switching ${this.cardName(opt.card)} to profile ${opt.profile}` : `switching the port`;
        t.log.info(`selecting ${opt.title}: ${how}`, { card: opt.card, route: opt.routeName, profile: opt.profile ?? null });
        const started = this.timers.now();
        // One switch per card at a time; a second click while one runs replaces any queued one.
        await this.writes.run(`select:${opt.card}`, async () => {
          const deps = { ops: this.ops, waitView: <T>(pick: (v: AudioView) => T | undefined, ms: number) => this.waitView(pick, ms) };
          const node = await selectRoute(opt, this.switchTimeoutMs === undefined ? deps : { ...deps, timeoutMs: this.switchTimeoutMs });
          t.log.info(`default ${opt.kind === "sink" ? "output" : "input"}: ${node.title} (${opt.title}, ${this.timers.now() - started} ms)`, { id: node.id, name: node.name });
          if (t.get(opt.kind === "sink" ? `sinks.${node.id}` : `sources.${node.id}`) !== undefined) {
            t.set(opt.kind === "sink" ? "defaultSink" : "defaultSource", String(node.id));
          }
        });
        return;
      }
      const dev = this.device(target);
      await this.ops.setDefault(dev);
      t.log.info(`default ${dev.kind === "sink" ? "output" : "input"}: ${dev.title}`, { id: dev.id, name: dev.name });
      // Show it now; the metadata change from pw-dump confirms it (or corrects it).
      t.set(dev.kind === "sink" ? "defaultSink" : "defaultSource", String(dev.id));
    });

    t.action("testOutput", async (args) => {
      const dev = this.nodeFor(argTarget(args), "sink");
      t.log.info(`playing test sound on ${dev.title}`, { id: dev.id });
      await this.ops.testOutput(dev);
    });

    t.action("recordTest", async (args, ctx) => {
      const dev = this.nodeFor(argTarget(args), "source");
      t.log.info(`record test on ${dev.title}`, { id: dev.id });
      await this.ops.recordTest(dev, (text, fraction) => ctx.progress(text, fraction));
    });

    t.action("setAppVolume", async (args) => {
      const key = argApp(args);
      if (typeof args.value !== "number" || !Number.isFinite(args.value)) throw invalid("value must be a number");
      const percent = Math.round(Math.max(0, Math.min(MAX_APP_VOLUME, args.value)));
      this.app(key); // fail fast for an app that is gone
      await this.writes.run(`volume:${key}`, async () => {
        const app = this.app(key); // streams may have come or gone while waiting
        await this.ops.setStreamsVolume(app.streams, percent);
        if (t.get(`apps.${key}`) !== undefined) t.set(`apps.${key}.volume`, percent);
      });
    });

    t.action("setAppMute", async (args) => {
      const key = argApp(args);
      const v = args.value;
      if (typeof v !== "boolean" && v !== "toggle") throw invalid('value must be true, false or "toggle"');
      const muted = v === "toggle" ? !appMuted(this.app(key)) : v;
      this.app(key);
      await this.writes.run(`mute:${key}`, async () => {
        const app = this.app(key);
        await this.ops.setStreamsMute(app.streams, muted);
        if (t.get(`apps.${key}`) !== undefined) t.set(`apps.${key}.muted`, muted);
      });
    });

    // Master volume and mute of the default output/input, by the default's id in the model.
    // Writes are serialized and coalesced like the app sliders. The default is looked up when
    // the write runs, so a drag that outlives a default switch lands on the device shown then.
    t.action("setMasterVolume", async (args) => {
      const kind = argKind(args);
      if (typeof args.value !== "number" || !Number.isFinite(args.value)) throw invalid("value must be a number");
      const percent = Math.round(Math.max(0, Math.min(MAX_MASTER_VOLUME, args.value)));
      this.defaultOf(kind); // fail fast when there is none
      await this.writes.run(`master-volume:${kind}`, async () => {
        const dev = this.defaultOf(kind);
        await this.ops.setDeviceVolume(dev, percent);
        if (t.get(`master.${kind}.id`) === String(dev.id)) t.set(`master.${kind}.volume`, percent);
      });
    });

    t.action("setMasterMute", async (args) => {
      const kind = argKind(args);
      const v = args.value;
      if (typeof v !== "boolean" && v !== "toggle") throw invalid('value must be true, false or "toggle"');
      const muted = v === "toggle" ? !this.defaultOf(kind).muted : v;
      await this.writes.run(`master-mute:${kind}`, async () => {
        const dev = this.defaultOf(kind);
        await this.ops.setDeviceMute(dev, muted);
        if (t.get(`master.${kind}.id`) === String(dev.id)) t.set(`master.${kind}.muted`, muted);
      });
    });

    t.stream("level", ({ param, emit }) => {
      const id = Number(param);
      const dev = this.view.sources.find((d) => d.id === id);
      if (!dev) {
        t.log.warn(`level meter: no input with id ${param ?? "(none)"}`);
        emit(0);
        return;
      }
      t.log.debug(`level meter on ${dev.title}`, { id });
      const stop = this.ops.startLevel(
        dev,
        (level) => emit(level as JsonValue),
        (reason) => {
          t.log.warn(`level meter on ${dev.title} stopped: ${reason}`, { id });
          emit(0);
        },
      );
      return () => {
        stop();
        t.log.debug(`level meter on ${dev.title} closed`, { id });
      };
    });
  }
}
