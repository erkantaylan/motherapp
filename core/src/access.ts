// Who may talk to the core's UI/API (server.ts), as pure functions (DESIGN.md § 3 "Host names",
// "Network"). The inbox tool's own listener (tools/inbox/) is separate and has its own token
// auth; nothing here applies to it.
//
//   Host / Origin names   always: localhost, 127.0.0.0/8, [::1], and (setting
//                         `localhostSubdomains`, default on) *.localhost at any depth.
//                         While the LAN listener is open, also this machine's interface IPs,
//                         its hostname and <hostname>.local. Every other name is refused, which
//                         is what stops DNS rebinding.
//   Source addresses      loopback, and while open private/link-local ranges only.
//   Changing settings     only from a loopback connection that uses a localhost name.
import * as net from "node:net";
import type * as os from "node:os";

/** Where a connection comes from. */
export type SourceClass = "loopback" | "private" | "link-local" | "public" | "invalid";

const LOOPBACK = new net.BlockList();
LOOPBACK.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK.addAddress("::1", "ipv6");
const PRIVATE = new net.BlockList();
PRIVATE.addSubnet("10.0.0.0", 8, "ipv4");
PRIVATE.addSubnet("172.16.0.0", 12, "ipv4");
PRIVATE.addSubnet("192.168.0.0", 16, "ipv4");
PRIVATE.addSubnet("fc00::", 7, "ipv6");
const LINK_LOCAL = new net.BlockList();
LINK_LOCAL.addSubnet("169.254.0.0", 16, "ipv4");
LINK_LOCAL.addSubnet("fe80::", 10, "ipv6");

/** "::ffff:192.168.1.5" -> "192.168.1.5"; drops an IPv6 zone ("fe80::1%eth0"). */
export function plainAddress(addr: string): string {
  let a = addr.trim().toLowerCase();
  const zone = a.indexOf("%");
  if (zone >= 0) a = a.slice(0, zone);
  if (a.startsWith("[") && a.endsWith("]")) a = a.slice(1, -1);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  return mapped ? mapped[1]! : a;
}

export function classifySource(addr: string | undefined): SourceClass {
  if (!addr) return "invalid";
  const a = plainAddress(addr);
  const family = net.isIPv4(a) ? "ipv4" : net.isIPv6(a) ? "ipv6" : undefined;
  if (!family) return "invalid";
  if (LOOPBACK.check(a, family)) return "loopback";
  if (PRIVATE.check(a, family)) return "private";
  if (LINK_LOCAL.check(a, family)) return "link-local";
  return "public";
}

/** May a connection from `addr` be served at all (on any listener)? */
export function isAllowedSource(addr: string | undefined): boolean {
  const c = classifySource(addr);
  return c === "loopback" || c === "private" || c === "link-local";
}

export function isLoopbackSource(addr: string | undefined): boolean {
  return classifySource(addr) === "loopback";
}

/** The hostname of a Host header, normalised like a browser does (lowercase, punycode, [v6]). */
export function hostnameOf(hostHeader: string | undefined): string | undefined {
  if (!hostHeader) return undefined;
  try {
    return new URL(`http://${hostHeader}`).hostname;
  } catch {
    return undefined;
  }
}

/** `localhost`, a 127/8 literal, [::1], and with `subdomains` any `<x>.localhost`. */
export function isLocalhostName(hostname: string, subdomains: boolean): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h === "[::1]" || h === "::1") return true;
  if (net.isIPv4(h) && h.startsWith("127.")) return true;
  return subdomains && h.length > ".localhost".length && h.endsWith(".localhost");
}

export interface HostContext {
  /** Setting `localhostSubdomains`. */
  subdomains: boolean;
  /** Extra names accepted while the LAN listener is open (see `machineNames`); empty when closed. */
  lanNames: ReadonlySet<string>;
}

export function isAllowedHostname(hostname: string | undefined, ctx: HostContext): boolean {
  if (!hostname) return false;
  return isLocalhostName(hostname, ctx.subdomains) || ctx.lanNames.has(hostname.toLowerCase().replace(/\.$/, ""));
}

/**
 * An Origin header, when present, must name an allowed host too. Localhost names keep today's
 * rule (any scheme); the LAN names need http or https.
 */
export function isAllowedOrigin(origin: string | undefined, ctx: HostContext): boolean {
  if (origin === undefined) return true;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (isLocalhostName(u.hostname, ctx.subdomains)) return true;
  return (u.protocol === "http:" || u.protocol === "https:") && isAllowedHostname(u.hostname, ctx);
}

/** Why a request is refused, or undefined when it may go on. */
export function refusal(headers: { host?: string | undefined; origin?: string | undefined }, ctx: HostContext): { what: "host" | "origin"; value: string } | undefined {
  const host = hostnameOf(headers.host);
  if (!isAllowedHostname(host, ctx)) return { what: "host", value: host ?? String(headers.host ?? "") };
  if (!isAllowedOrigin(headers.origin, ctx)) return { what: "origin", value: headers.origin ?? "" };
  return undefined;
}

/**
 * May this connection change network settings? Only from this computer: a loopback source and a
 * localhost Host (and Origin, when sent). A LAN client, or anything relayed under another name,
 * can look but not change (DESIGN.md § 4.3).
 */
export function canChangeSettings(remoteAddress: string | undefined, headers: { host?: string | undefined; origin?: string | undefined }, subdomains: boolean): boolean {
  if (!isLoopbackSource(remoteAddress)) return false;
  const host = hostnameOf(headers.host);
  if (!host || !isLocalhostName(host, subdomains)) return false;
  if (headers.origin === undefined) return true;
  try {
    return isLocalhostName(new URL(headers.origin).hostname, subdomains);
  } catch {
    return false;
  }
}

/** Host-header form of an interface address: "192.168.1.20" or "[fe80::1]". */
export function hostFormOf(address: string): string | undefined {
  const a = plainAddress(address);
  if (net.isIPv4(a)) return a;
  if (!net.isIPv6(a)) return undefined;
  try {
    return new URL(`http://[${a}]`).hostname;
  } catch {
    return undefined;
  }
}

/** The names a LAN client may use while open: interface IPs, the hostname, <hostname>.local. */
export function machineNames(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>, hostname: string): Set<string> {
  const out = new Set<string>();
  for (const list of Object.values(ifaces)) {
    for (const i of list ?? []) {
      if (i.internal) continue;
      const f = hostFormOf(i.address);
      if (f) out.add(f);
    }
  }
  const name = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (name && name !== "localhost") {
    out.add(name);
    const short = name.split(".")[0]!;
    out.add(`${short}.local`);
  }
  return out;
}

/** Logs a refusal at most once per key per hour, so a client retrying can't flood the log. */
export class RejectLog {
  private seen = new Map<string, number>();
  private now: () => number;
  private intervalMs: number;
  private max: number;

  constructor(opts: { now?: () => number; intervalMs?: number; maxKeys?: number } = {}) {
    this.now = opts.now ?? Date.now;
    this.intervalMs = opts.intervalMs ?? 60 * 60 * 1000;
    this.max = opts.maxKeys ?? 1000;
  }

  /** True when `key` should be logged now. */
  shouldLog(key: string): boolean {
    const t = this.now();
    const last = this.seen.get(key);
    if (last !== undefined && t - last < this.intervalMs) return false;
    this.seen.delete(key);
    if (this.seen.size >= this.max) {
      for (const [k, at] of this.seen) if (t - at >= this.intervalMs) this.seen.delete(k);
      if (this.seen.size >= this.max) this.seen.delete(this.seen.keys().next().value!);
    }
    this.seen.set(key, t);
    return true;
  }
}

/** A header value safe to put in a log line: printable ASCII, at most 100 characters. */
export function logSafe(v: string): string {
  const s = v.replace(/[^\x20-\x7e]/g, "?");
  return s.length > 100 ? s.slice(0, 100) + "…" : s;
}
