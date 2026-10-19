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
import { DERIVED_KEYS, MAX_APP_VOLUME, PwModel, appMuted, buildView, viewToState } from "./pipewire.ts";
import type { AppGroup, AudioView, Device } from "./pipewire.ts";
import type { Runner } from "./runner.ts";

export interface ServiceOptions {
  tool: Tool;
  runner: Runner;
  timers?: Timers;
  ops?: Omit<OpsOptions, "runner" | "ownPid">;
  /** How long a finished pw-play's pid stays hidden (its node can outlive the process briefly). */
  ownPidGraceMs?: number;
}

export const INITIAL_STATE: JsonObject = { sinks: {}, sources: {}, defaultSink: "", defaultSource: "", apps: {} };

const invalid = (msg: string) => new RpcError(-32602, msg);

function argId(args: JsonObject): number {
  const id = args.id;
  const n = typeof id === "number" ? id : typeof id === "string" && /^\d+$/.test(id) ? Number(id) : NaN;
  if (!Number.isInteger(n)) throw invalid("id must be a PipeWire object id");
  return n;
}

function argApp(args: JsonObject): string {
  if (typeof args.app !== "string" || args.app === "") throw invalid("app must be a string");
  return args.app;
}

export class AudioService {
  readonly model = new PwModel();
  view: AudioView = { sinks: [], sources: [], apps: [] };
  readonly ops: AudioOps;
  readonly monitor: PwMonitor;
  private tool: Tool;
  private timers: Timers;
  private writes = new Coalescer();
  private ownPids = new Map<number, unknown>();
  private graceMs: number;

  constructor(opts: ServiceOptions) {
    this.tool = opts.tool;
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
    if (full && this.tool.get("status") !== undefined) this.tool.delete("status");
  }

  private onDown(reason: string, retryInMs: number): void {
    for (const k of DERIVED_KEYS) this.tool.markStale(k);
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
      const dev = this.device(argId(args));
      await this.ops.setDefault(dev);
      t.log.info(`default ${dev.kind === "sink" ? "output" : "input"}: ${dev.title}`, { id: dev.id, name: dev.name });
      // Show it now; the metadata change from pw-dump confirms it (or corrects it).
      t.set(dev.kind === "sink" ? "defaultSink" : "defaultSource", String(dev.id));
    });

    t.action("testOutput", async (args) => {
      const dev = this.device(argId(args), "sink");
      t.log.info(`playing test sound on ${dev.title}`, { id: dev.id });
      await this.ops.testOutput(dev);
    });

    t.action("recordTest", async (args, ctx) => {
      const dev = this.device(argId(args), "source");
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
