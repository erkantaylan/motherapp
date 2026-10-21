// Which network is this machine on? (DESIGN.md § 3 "Network": the LAN listener opens only on a
// network the user trusted.) A network is identified by the NetworkManager connection that holds
// the IPv4 default route (its UUID) plus the default gateway's MAC address, so a lookalike
// network with the same name and even a copied UUID doesn't count unless its gateway matches.
//
//   ip route show default                                   -> gateway IP and device
//   nmcli -t -f NAME,UUID,DEVICE,TYPE connection show --active -> the connection on that device
//   ip neigh show <gateway> dev <device>                    -> the gateway's MAC
import { execFile, spawn } from "node:child_process";
import type { ActiveNetwork } from "@motherapp/protocol";

/** Runs a command and resolves with its stdout. Rejects with `code: "ENOENT"` when it's missing. */
export type Runner = (cmd: string, args: string[]) => Promise<string>;

/** Starts a long-running command and calls `onLine` per output line; `stop()` kills it. */
export type MonitorFn = (cmd: string, args: string[], onLine: (line: string) => void, onExit: (err?: Error) => void) => { stop(): void };

const ENV = { ...process.env, LC_ALL: "C.UTF-8" };

export const realRunner: Runner = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 5000, env: ENV, maxBuffer: 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });

export const realMonitor: MonitorFn = (cmd, args, onLine, onExit) => {
  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"], env: ENV });
  let buf = "";
  let done = false;
  const finish = (err?: Error) => {
    if (done) return;
    done = true;
    onExit(err);
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (c: string) => {
    buf += c;
    const lines = buf.split("\n");
    buf = lines.pop()!;
    for (const l of lines) onLine(l);
  });
  child.on("error", (e) => finish(e));
  child.on("exit", (code, signal) => finish(code === 0 || signal === "SIGTERM" ? undefined : new Error(`${cmd} exited (${signal ?? code})`)));
  const onProcessExit = () => child.kill("SIGTERM");
  process.once("exit", onProcessExit);
  return {
    stop: () => {
      done = true;
      process.off("exit", onProcessExit);
      child.kill("SIGTERM");
    },
  };
};

/** The lowest-metric IPv4 default route: `{ via, dev }`, `via` missing for a gatewayless route. */
export function parseDefaultRoute(out: string): { via?: string; dev?: string } | undefined {
  let best: { via?: string; dev?: string; metric: number } | undefined;
  for (const line of out.split("\n")) {
    const w = line.trim().split(/\s+/);
    if (w[0] !== "default") continue;
    const at = (k: string) => {
      const i = w.indexOf(k);
      return i >= 0 ? w[i + 1] : undefined;
    };
    const metric = Number(at("metric") ?? 0);
    const r = { metric: Number.isFinite(metric) ? metric : 0, ...(at("via") ? { via: at("via")! } : {}), ...(at("dev") ? { dev: at("dev")! } : {}) };
    if (!best || r.metric < best.metric) best = r;
  }
  if (!best) return undefined;
  const { metric: _m, ...rest } = best;
  return rest;
}

/** Splits one `nmcli -t` line: fields separated by `:`, with `\:` and `\\` escaped. */
export function splitTerse(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === "\\" && i + 1 < line.length) cur += line[++i];
    else if (c === ":") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

export function parseActiveConnections(out: string): { name: string; uuid: string; device: string; type: string }[] {
  const rows = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const [name = "", uuid = "", device = "", type = ""] = splitTerse(line);
    if (uuid) rows.push({ name, uuid: uuid.toLowerCase(), device, type });
  }
  return rows;
}

/** The `lladdr` of an `ip neigh show` line, lowercase; undefined for FAILED/INCOMPLETE entries. */
export function parseNeighMac(out: string): string | undefined {
  const m = /\blladdr\s+([0-9a-f]{2}(?::[0-9a-f]{2}){5})\b/i.exec(out);
  return m ? m[1]!.toLowerCase() : undefined;
}

const isMissing = (e: unknown) => (e as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

/** Looks up the active network. Never throws: a problem becomes `error`. */
export async function identifyNetwork(run: Runner): Promise<ActiveNetwork> {
  let routeOut: string;
  try {
    routeOut = await run("ip", ["route", "show", "default"]);
  } catch (e) {
    return { error: isMissing(e) ? "can't read the default route (the ip command isn't available)" : `can't read the default route: ${(e as Error).message}` };
  }
  const route = parseDefaultRoute(routeOut);
  if (!route?.dev) return { error: "no network (no default route)" };
  const net: ActiveNetwork = { device: route.dev, ...(route.via ? { gatewayIp: route.via } : {}) };

  let nmOut: string;
  try {
    nmOut = await run("nmcli", ["-t", "-f", "NAME,UUID,DEVICE,TYPE", "connection", "show", "--active"]);
  } catch (e) {
    return { ...net, error: isMissing(e) ? "can't identify the network (NetworkManager not available)" : `can't identify the network: ${(e as Error).message}` };
  }
  const conn = parseActiveConnections(nmOut).find((c) => c.device === route.dev);
  if (!conn) return { ...net, error: `can't identify the network (NetworkManager doesn't manage ${route.dev})` };
  Object.assign(net, { name: conn.name, uuid: conn.uuid, type: conn.type });

  if (!route.via) return { ...net, error: `can't identify the network (the default route on ${route.dev} has no gateway)` };
  let neighOut = "";
  try {
    neighOut = await run("ip", ["neigh", "show", route.via, "dev", route.dev]);
  } catch (e) {
    return { ...net, error: `can't read the gateway's MAC address: ${(e as Error).message}` };
  }
  const mac = parseNeighMac(neighOut);
  if (!mac) return { ...net, error: `can't read the gateway's MAC address (no neighbour entry for ${route.via})` };
  net.gatewayMac = mac;
  return net;
}
