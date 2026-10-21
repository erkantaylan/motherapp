// The "Local network" switch (DESIGN.md § 3 "Network", § 4.3). The core always listens on
// 127.0.0.1 (server.ts). While the switch is on AND the active network is one the user trusted
// (NetworkManager connection UUID + gateway MAC, netIdentity.ts), it also listens on each
// non-loopback interface address, with the same handlers. The source-address and Host rules are
// in access.ts; changing anything here is for loopback connections only (server.ts checks).
//
// Why one listener per address and not 0.0.0.0/[::]: a wildcard bind on the same port fails with
// EADDRINUSE while 127.0.0.1 is bound, and dropping the loopback listener to make room would cut
// the page that is flipping the switch. The addresses are re-read on every check, so a new DHCP
// lease is picked up within one check.
import { EventEmitter } from "node:events";
import type * as net from "node:net";
import * as os from "node:os";
import type { ActiveNetwork, NetworkInfo, TrustedNetwork } from "@motherapp/protocol";
import { hostFormOf, machineNames } from "./access.ts";
import type { HostContext } from "./access.ts";
import type { LogService } from "./logService.ts";
import { identifyNetwork } from "./netIdentity.ts";
import type { MonitorFn, Runner } from "./netIdentity.ts";

/** What the controller reads from and writes to config.json (the Manager). */
export interface NetworkStore {
  get(): { lan: { enabled: boolean; trusted: TrustedNetwork[] }; localhostSubdomains: boolean };
  /** Edits config.json in place and updates the in-memory config; throws when it can't save. */
  setLanEnabled(enabled: boolean): void;
  setTrusted(trusted: TrustedNetwork[]): void;
  setLocalhostSubdomains(enabled: boolean): void;
}

export interface LanOptions {
  store: NetworkStore;
  log: LogService;
  /** A new HTTP server with the core's handlers (and its source check). */
  createListener: () => net.Server;
  run: Runner;
  monitor?: MonitorFn;
  interfaces?: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  hostname?: () => string;
  /** Re-check while the switch is on, besides `nmcli monitor` events. Default 30 s. */
  pollMs?: number;
  /** Wait after a monitor event before checking (events come in bursts). Default 1 s. */
  debounceMs?: number;
  /** A cached look at the network is reused by `get()` for this long. Default 10 s. */
  maxAgeMs?: number;
}

/** Is `current` one of `trusted`, and if not, why. Pure, for tests. */
export function decide(lan: { enabled: boolean; trusted: TrustedNetwork[] }, current: ActiveNetwork | null): { open: boolean; trusted: boolean; reason: string } {
  const label = current?.name || current?.device || "unknown network";
  const entry = current?.uuid ? lan.trusted.find((t) => t.uuid === current.uuid) : undefined;
  const trusted = !!entry && !!current?.gatewayMac && entry.gatewayMac === current.gatewayMac;
  if (!lan.enabled) return { open: false, trusted, reason: "Closed: the Local network switch is off" };
  if (!current) return { open: false, trusted, reason: "Closed: the network hasn't been checked yet" };
  if (current.error) return { open: false, trusted, reason: `Closed: ${current.error}` };
  if (entry && !trusted) return { open: false, trusted, reason: `Closed: ${label}'s gateway (${current.gatewayMac}) isn't the one you trusted (${entry.gatewayMac})` };
  if (!trusted) return { open: false, trusted, reason: `Closed: not on a trusted network (${label})` };
  return { open: true, trusted, reason: `Open on ${label}` };
}

interface Bound {
  server: net.Server;
  sockets: Set<net.Socket>;
  /** Shown to the user (not for IPv6 link-local, which needs a zone in the URL). */
  url?: string;
}

export class LanController extends EventEmitter<{ change: [] }> {
  open = false;
  reason = "Closed: the Local network switch is off";
  current: ActiveNetwork | null = null;
  currentTrusted = false;
  private opts: LanOptions;
  private port = 0;
  private bound = new Map<string, Bound>();
  private failed = new Set<string>();
  private names: ReadonlySet<string> = new Set();
  private checkedAt = 0;
  private queue: Promise<void> = Promise.resolve();
  private watch: { stop(): void } | undefined;
  private poll: ReturnType<typeof setInterval> | undefined;
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private lastInfo = "";
  private stopped = false;

  constructor(opts: LanOptions) {
    super();
    this.opts = opts;
  }

  private get ifaces() {
    return (this.opts.interfaces ?? os.networkInterfaces)();
  }

  /** Call once the loopback listener is up: the LAN listeners use the same port. */
  async start(port: number): Promise<void> {
    this.port = port;
    this.syncWatching();
    if (this.opts.store.get().lan.enabled) await this.evaluate(true);
  }

  /** The Host/Origin rules for right now (access.ts). */
  hostContext(): HostContext {
    return { subdomains: this.opts.store.get().localhostSubdomains, lanNames: this.open ? this.names : new Set() };
  }

  info(canChange: boolean): NetworkInfo {
    const cfg = this.opts.store.get();
    const addresses = [...this.bound.values()].flatMap((b) => (b.url ? [b.url] : []));
    return {
      lanEnabled: cfg.lan.enabled,
      open: this.open,
      reason: this.reason,
      current: this.current,
      currentTrusted: this.currentTrusted,
      trusted: cfg.lan.trusted,
      addresses: this.open ? addresses : [],
      localhostSubdomains: cfg.localhostSubdomains,
      canChange,
    };
  }

  async get(refresh: boolean): Promise<void> {
    const old = Date.now() - this.checkedAt > (this.opts.maxAgeMs ?? 10_000);
    await this.evaluate(refresh || !this.current || old);
  }

  async setLan(enabled: boolean): Promise<void> {
    this.opts.store.setLanEnabled(enabled);
    this.opts.log.core("info", `network: Local network switch ${enabled ? "on" : "off"}`);
    this.syncWatching();
    await this.evaluate(enabled);
  }

  /** Trusts the network the machine is on now. Throws when it can't be identified. */
  async trust(): Promise<void> {
    await this.evaluate(true);
    const c = this.current;
    if (!c?.uuid || !c.gatewayMac) throw new Error(`Can't trust this network: ${c?.error ?? "it can't be identified"}`);
    const trusted = this.opts.store.get().lan.trusted.filter((t) => t.uuid !== c.uuid);
    trusted.push({ uuid: c.uuid, name: c.name ?? "", gatewayMac: c.gatewayMac });
    this.opts.store.setTrusted(trusted);
    this.opts.log.core("info", `network: trusted ${c.name ?? c.uuid}`, { uuid: c.uuid, gatewayMac: c.gatewayMac });
    await this.evaluate(false);
  }

  async untrust(uuid: string): Promise<void> {
    const before = this.opts.store.get().lan.trusted;
    const gone = before.find((t) => t.uuid === uuid.toLowerCase());
    if (!gone) return;
    this.opts.store.setTrusted(before.filter((t) => t !== gone));
    this.opts.log.core("info", `network: no longer trusted: ${gone.name || gone.uuid}`, { uuid: gone.uuid });
    await this.evaluate(false);
  }

  setLocalhostSubdomains(enabled: boolean): void {
    this.opts.store.setLocalhostSubdomains(enabled);
    this.opts.log.core("info", `network: *.localhost names ${enabled ? "accepted" : "refused"}`);
    this.changed();
  }

  /** Re-checks the network (`fresh`: ask nmcli/ip again) and opens or closes the listeners. */
  evaluate(fresh: boolean): Promise<void> {
    const run = this.queue.then(() => this.doEvaluate(fresh));
    this.queue = run.catch(() => {});
    return run;
  }

  private async doEvaluate(fresh: boolean): Promise<void> {
    if (this.stopped) return;
    const cfg = this.opts.store.get();
    if (fresh || !this.current) {
      this.current = await identifyNetwork(this.opts.run);
      this.checkedAt = Date.now();
    }
    const d = decide(cfg.lan, this.current);
    const ifaces = d.open ? this.ifaces : {};
    await this.syncListeners(d.open ? bindTargets(ifaces) : []);
    this.names = d.open ? machineNames(ifaces, (this.opts.hostname ?? os.hostname)()) : new Set();
    if (d.open !== this.open) this.opts.log.core("info", `network: LAN ${d.open ? "opened" : "closed"} (${d.reason.replace(/^(Open on|Closed: )\s*/, "")})`, { reason: d.reason });
    this.open = d.open;
    this.reason = d.reason;
    this.currentTrusted = d.trusted;
    this.changed();
  }

  /** Emits `change` when what Settings shows is different. */
  private changed(): void {
    const s = JSON.stringify(this.info(false));
    if (s === this.lastInfo) return;
    this.lastInfo = s;
    this.emit("change");
  }

  private async syncListeners(targets: { key: string; host: string; url?: string }[]): Promise<void> {
    const want = new Map(targets.map((t) => [t.key, t]));
    for (const [key, b] of this.bound) {
      if (want.has(key)) continue;
      this.bound.delete(key);
      closeBound(b);
    }
    for (const k of this.failed) if (!want.has(k)) this.failed.delete(k);
    await Promise.all(
      [...want.values()]
        .filter((t) => !this.bound.has(t.key))
        .map(
          (t) =>
            new Promise<void>((resolve) => {
              const server = this.opts.createListener();
              const b: Bound = { server, sockets: new Set(), ...(t.url ? { url: t.url.replace("PORT", String(this.port)) } : {}) };
              server.on("connection", (s: net.Socket) => {
                b.sockets.add(s);
                s.once("close", () => b.sockets.delete(s));
              });
              server.once("error", (e) => {
                if (!this.failed.has(t.key)) this.opts.log.core("warn", `network: can't listen on ${t.host}:${this.port}: ${e.message}`);
                this.failed.add(t.key);
                resolve();
              });
              server.listen({ port: this.port, host: t.host }, () => {
                this.failed.delete(t.key);
                this.bound.set(t.key, b);
                resolve();
              });
            }),
        ),
    );
  }

  /** `nmcli monitor` (else `ip monitor route`) and the 30 s re-check, only while the switch is on. */
  private syncWatching(): void {
    const on = this.opts.store.get().lan.enabled && !this.stopped;
    if (!on) {
      this.watch?.stop();
      this.watch = undefined;
      clearInterval(this.poll);
      this.poll = undefined;
      clearTimeout(this.debounce);
      return;
    }
    if (this.poll === undefined) {
      this.poll = setInterval(() => void this.evaluate(true), this.opts.pollMs ?? 30_000);
      this.poll.unref();
    }
    if (this.watch || !this.opts.monitor) return;
    const onLine = () => {
      clearTimeout(this.debounce);
      this.debounce = setTimeout(() => void this.evaluate(true), this.opts.debounceMs ?? 1000);
      this.debounce.unref();
    };
    const tryWatch = (cmd: string, args: string[], next?: () => void) => {
      const w = this.opts.monitor!(cmd, args, onLine, (err) => {
        if (this.watch !== w) return;
        this.watch = undefined;
        if (err && (err as NodeJS.ErrnoException).code === "ENOENT" && next) next();
        // otherwise the periodic re-check carries on alone
      });
      this.watch = w;
    };
    tryWatch("nmcli", ["monitor"], () => tryWatch("ip", ["monitor", "route"]));
  }

  stop(): void {
    this.stopped = true;
    this.syncWatching();
    for (const b of this.bound.values()) closeBound(b);
    this.bound.clear();
  }
}

/** Where to listen: every non-loopback interface address (IPv6 link-local with its zone). */
export function bindTargets(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>): { key: string; host: string; url?: string }[] {
  const out: { key: string; host: string; url?: string }[] = [];
  for (const [name, list] of Object.entries(ifaces)) {
    for (const i of list ?? []) {
      if (i.internal) continue;
      const linkLocal = i.family === "IPv6" && /^fe[89ab]/i.test(i.address);
      const host = linkLocal && !i.address.includes("%") ? `${i.address}%${name}` : i.address;
      const form = hostFormOf(i.address);
      if (!form || out.some((o) => o.key === host)) continue;
      out.push({ key: host, host, ...(linkLocal ? {} : { url: `http://${form}:PORT/` }) });
    }
  }
  return out;
}

function closeBound(b: Bound): void {
  b.server.close();
  for (const s of b.sockets) s.destroy();
  b.sockets.clear();
}
