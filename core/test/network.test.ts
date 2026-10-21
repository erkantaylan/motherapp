// Host names, source addresses, the Local network switch and trusted networks
// (access.ts, netIdentity.ts, lan.ts, server.ts). nmcli/ip are faked through the runner; the
// "LAN" interface is 127.0.0.2, which every Linux loopback answers, so the listener tests run
// anywhere. One test also uses a real non-loopback interface when the machine has one.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { WebSocket } from "ws";
import type { NetworkInfo } from "@motherapp/protocol";
import { canChangeSettings, classifySource, isAllowedOrigin, isAllowedSource, isLocalhostName, machineNames, refusal, RejectLog } from "../src/access.ts";
import type { HostContext } from "../src/access.ts";
import { decide } from "../src/lan.ts";
import { LogService } from "../src/logService.ts";
import { Manager } from "../src/manager.ts";
import { identifyNetwork, parseActiveConnections, parseDefaultRoute, parseNeighMac, splitTerse } from "../src/netIdentity.ts";
import type { MonitorFn, Runner } from "../src/netIdentity.ts";
import { startServer } from "../src/server.ts";
import { waitFor } from "./helpers.ts";

// ---- access.ts ----

const closed = (subdomains = true): HostContext => ({ subdomains, lanNames: new Set() });

test("localhost names: localhost, 127/8, [::1], and *.localhost only while that setting is on", () => {
  for (const h of ["localhost", "127.0.0.1", "127.3.4.5", "[::1]", "ana.localhost", "a.b.localhost"]) assert.equal(isLocalhostName(h, true), true, h);
  for (const h of ["ana.localhost", "a.b.localhost"]) assert.equal(isLocalhostName(h, false), false, h);
  for (const h of ["localhost", "127.0.0.1", "[::1]"]) assert.equal(isLocalhostName(h, false), true, h);
  for (const h of ["localhost.evil.com", "evillocalhost", ".localhost", "128.0.0.1", "motherapp.lan", "192.168.1.20", "[::2]"]) assert.equal(isLocalhostName(h, true), false, h);
});

test("Host/Origin refusal: other names are refused (DNS rebinding), with any port", () => {
  assert.equal(refusal({ host: "localhost:7323" }, closed()), undefined);
  assert.equal(refusal({ host: "ANA.Localhost:8080" }, closed()), undefined);
  assert.equal(refusal({ host: "[::1]:7323", origin: "http://[::1]:7323" }, closed()), undefined);
  assert.equal(refusal({ host: "127.0.0.1:7323", origin: "http://ana.localhost" }, closed()), undefined);
  assert.deepEqual(refusal({ host: "ana.localhost:7323" }, closed(false)), { what: "host", value: "ana.localhost" });
  assert.deepEqual(refusal({ host: "evil.example:7323" }, closed()), { what: "host", value: "evil.example" });
  assert.deepEqual(refusal({}, closed()), { what: "host", value: "" });
  assert.deepEqual(refusal({ host: "localhost", origin: "https://evil.example" }, closed()), { what: "origin", value: "https://evil.example" });
  assert.equal(refusal({ host: "localhost", origin: "null" }, closed())?.what, "origin");
});

test("Host rules while the LAN listener is open: interface IPs, hostname, <hostname>.local", () => {
  const names = machineNames(
    {
      lo: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: true, cidr: "127.0.0.1/8" }],
      eth0: [
        { address: "192.168.1.20", netmask: "255.255.255.0", family: "IPv4", mac: "aa:aa:aa:aa:aa:aa", internal: false, cidr: "192.168.1.20/24" },
        { address: "fe80::1:2", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", mac: "aa:aa:aa:aa:aa:aa", internal: false, cidr: "fe80::1:2/64", scopeid: 2 },
      ],
    },
    "Kappa",
  );
  const open: HostContext = { subdomains: true, lanNames: names };
  for (const h of ["192.168.1.20:7323", "kappa:7323", "KAPPA.local", "[fe80::1:2]:7323", "localhost"]) assert.equal(refusal({ host: h }, open), undefined, h);
  for (const h of ["192.168.1.21", "evil.example", "kappa.evil.example", "kappa.lan"]) assert.equal(refusal({ host: h }, open)?.what, "host", h);
  assert.equal(isAllowedOrigin("http://kappa.local:7323", open), true);
  assert.equal(isAllowedOrigin("ftp://kappa.local", open), false);
  // closed: the same names are refused
  assert.equal(refusal({ host: "192.168.1.20:7323" }, closed())?.what, "host");
  assert.equal(refusal({ host: "kappa.local" }, closed())?.what, "host");
});

test("source addresses: loopback and private/link-local ranges only", () => {
  const cases: [string, string][] = [
    ["127.0.0.1", "loopback"],
    ["::1", "loopback"],
    ["::ffff:127.0.0.1", "loopback"],
    ["10.1.2.3", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["172.32.0.1", "public"],
    ["192.168.1.5", "private"],
    ["::ffff:192.168.1.5", "private"],
    ["169.254.10.10", "link-local"],
    ["fd12:3456::1", "private"],
    ["fc00::1", "private"],
    ["fe80::1%eth0", "link-local"],
    ["8.8.8.8", "public"],
    ["192.0.2.2", "public"],
    ["2001:db8::1", "public"],
    ["", "invalid"],
    ["nonsense", "invalid"],
  ];
  for (const [a, c] of cases) assert.equal(classifySource(a), c, a);
  assert.equal(isAllowedSource("8.8.8.8"), false);
  assert.equal(isAllowedSource("192.168.1.5"), true);
  assert.equal(isAllowedSource(undefined), false);
});

test("settings change only from a loopback source under a localhost name", () => {
  assert.equal(canChangeSettings("127.0.0.1", { host: "localhost:7323" }, true), true);
  assert.equal(canChangeSettings("::ffff:127.0.0.1", { host: "127.0.0.1:7323", origin: "http://127.0.0.1:7323" }, true), true);
  assert.equal(canChangeSettings("127.0.0.1", { host: "ana.localhost" }, true), true);
  assert.equal(canChangeSettings("127.0.0.1", { host: "ana.localhost" }, false), false);
  assert.equal(canChangeSettings("192.168.1.5", { host: "localhost:7323" }, true), false);
  assert.equal(canChangeSettings("127.0.0.1", { host: "kappa.local:7323" }, true), false);
  assert.equal(canChangeSettings("127.0.0.1", { host: "localhost", origin: "http://kappa.local" }, true), false);
});

test("RejectLog: once per key per hour", () => {
  let t = 0;
  const r = new RejectLog({ now: () => t, maxKeys: 3 });
  assert.equal(r.shouldLog("a"), true);
  assert.equal(r.shouldLog("a"), false);
  assert.equal(r.shouldLog("b"), true);
  t = 59 * 60 * 1000;
  assert.equal(r.shouldLog("a"), false);
  t = 60 * 60 * 1000;
  assert.equal(r.shouldLog("a"), true);
  // bounded: many names never grow the map past maxKeys
  for (let i = 0; i < 50; i++) r.shouldLog(`x${i}`);
  assert.equal(r.shouldLog("x49"), false);
});

// ---- netIdentity.ts ----

test("parsing ip route / nmcli -t / ip neigh", () => {
  assert.deepEqual(parseDefaultRoute("default via 192.168.1.1 dev enp3s0 proto dhcp src 192.168.1.20 metric 100\ndefault via 10.0.0.1 dev wlp2s0 proto dhcp metric 600\n"), { via: "192.168.1.1", dev: "enp3s0" });
  assert.deepEqual(parseDefaultRoute("default via 10.0.0.1 dev wlp2s0 metric 600\ndefault dev wg0 scope link metric 50\n"), { dev: "wg0" });
  assert.equal(parseDefaultRoute(""), undefined);
  assert.deepEqual(splitTerse("Caf\\:e\\\\x:1234:wlp2s0:802-11-wireless"), ["Caf:e\\x", "1234", "wlp2s0", "802-11-wireless"]);
  assert.deepEqual(parseActiveConnections("Wired connection 1:AAAA-1:enp3s0:802-3-ethernet\nlo:bbbb:lo:loopback\n"), [
    { name: "Wired connection 1", uuid: "aaaa-1", device: "enp3s0", type: "802-3-ethernet" },
    { name: "lo", uuid: "bbbb", device: "lo", type: "loopback" },
  ]);
  assert.equal(parseNeighMac("192.168.1.1 lladdr AA:BB:CC:DD:EE:FF REACHABLE\n"), "aa:bb:cc:dd:ee:ff");
  assert.equal(parseNeighMac("192.168.1.1  FAILED\n"), undefined);
});

interface FakeNet {
  uuid: string;
  name: string;
  mac: string | null;
  nmcli: boolean;
  route: boolean;
  calls: string[];
}

function fakeNet(init: Partial<FakeNet> = {}): { state: FakeNet; run: Runner } {
  const state: FakeNet = { uuid: "u-home", name: "Home", mac: "aa:bb:cc:dd:ee:01", nmcli: true, route: true, calls: [], ...init };
  const missing = (cmd: string) => Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: "ENOENT" });
  const run: Runner = async (cmd, args) => {
    state.calls.push(`${cmd} ${args.join(" ")}`);
    if (cmd === "ip" && args[0] === "route") return state.route ? "default via 192.168.1.1 dev eth0 proto dhcp metric 100\n" : "";
    if (cmd === "ip" && args[0] === "neigh") return state.mac ? `192.168.1.1 lladdr ${state.mac} REACHABLE\n` : "192.168.1.1 INCOMPLETE\n";
    if (cmd === "nmcli") {
      if (!state.nmcli) throw missing(cmd);
      return `${state.name}:${state.uuid}:eth0:802-3-ethernet\nlo:u-lo:lo:loopback\n`;
    }
    throw missing(cmd);
  };
  return { state, run };
}

test("identifyNetwork: UUID, name, gateway and its MAC; reasons when it can't", async () => {
  const f = fakeNet();
  assert.deepEqual(await identifyNetwork(f.run), { device: "eth0", gatewayIp: "192.168.1.1", name: "Home", uuid: "u-home", type: "802-3-ethernet", gatewayMac: "aa:bb:cc:dd:ee:01" });
  f.state.mac = null;
  assert.match((await identifyNetwork(f.run)).error ?? "", /gateway's MAC address \(no neighbour entry for 192\.168\.1\.1\)/);
  f.state.nmcli = false;
  assert.equal((await identifyNetwork(f.run)).error, "can't identify the network (NetworkManager not available)");
  f.state.route = false;
  assert.equal((await identifyNetwork(f.run)).error, "no network (no default route)");
});

test("decide: trusted only when the UUID and the gateway MAC both match", () => {
  const trusted = [{ uuid: "u-home", name: "Home", gatewayMac: "aa:bb:cc:dd:ee:01" }];
  const home = { name: "Home", uuid: "u-home", gatewayMac: "aa:bb:cc:dd:ee:01" };
  assert.deepEqual(decide({ enabled: true, trusted }, home), { open: true, trusted: true, reason: "Open on Home" });
  assert.equal(decide({ enabled: false, trusted }, home).open, false);
  assert.equal(decide({ enabled: false, trusted }, home).reason, "Closed: the Local network switch is off");
  const lookalike = decide({ enabled: true, trusted }, { ...home, gatewayMac: "66:66:66:66:66:66" });
  assert.equal(lookalike.open, false);
  assert.match(lookalike.reason, /gateway \(66:66:66:66:66:66\) isn't the one you trusted/);
  assert.equal(decide({ enabled: true, trusted }, { name: "Wired connection 1", uuid: "u-other", gatewayMac: "aa:bb:cc:dd:ee:01" }).reason, "Closed: not on a trusted network (Wired connection 1)");
  assert.equal(decide({ enabled: true, trusted }, { ...home, gatewayMac: undefined, error: "can't read the gateway's MAC address" } as never).open, false);
  assert.equal(decide({ enabled: true, trusted }, { error: "can't identify the network (NetworkManager not available)" }).reason, "Closed: can't identify the network (NetworkManager not available)");
});

// ---- the real server, in process ----

const FAKE_IFACES = () => ({
  lo: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4" as const, mac: "00:00:00:00:00:00", internal: true, cidr: "127.0.0.1/8" }],
  fake0: [{ address: "127.0.0.2", netmask: "255.0.0.0", family: "IPv4" as const, mac: "02:00:00:00:00:02", internal: false, cidr: "127.0.0.2/8" }],
});

/** A fake `nmcli monitor`: `fire()` sends a line to whoever is watching. */
function fakeMonitor() {
  const watchers = new Set<(l: string) => void>();
  const started: string[] = [];
  const monitor: MonitorFn = (cmd, args, onLine) => {
    started.push(`${cmd} ${args.join(" ")}`);
    watchers.add(onLine);
    return { stop: () => watchers.delete(onLine) };
  };
  return { monitor, started, watchers, fire: () => watchers.forEach((w) => w("eth0: connection changed")) };
}

async function setup(t: { after(fn: () => unknown): void }, opts: { config?: unknown; net?: ReturnType<typeof fakeNet>; allowSource?: (a: string | undefined) => boolean; interfaces?: () => NodeJS.Dict<os.NetworkInterfaceInfo[]> } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ma-net-"));
  const toolsDir = path.join(tmp, "tools");
  fs.mkdirSync(toolsDir);
  const webDir = path.join(tmp, "web");
  fs.mkdirSync(webDir);
  fs.writeFileSync(path.join(webDir, "index.html"), "<!doctype html><title>t</title>");
  const configFile = path.join(tmp, "config.json");
  if (opts.config !== undefined) fs.writeFileSync(configFile, JSON.stringify(opts.config));
  const lines: { level: string; msg: string }[] = [];
  const log = new LogService({ stdout: null });
  log.subscribe((e) => lines.push({ level: e.level, msg: e.msg }));
  const manager = new Manager({ toolsDir, configFile, log });
  manager.init();
  const fnet = opts.net ?? fakeNet();
  const mon = fakeMonitor();
  const server = await startServer({
    manager,
    log,
    webDir,
    port: 0,
    network: {
      run: fnet.run,
      monitor: mon.monitor,
      interfaces: opts.interfaces ?? FAKE_IFACES,
      hostname: () => "kappa",
      pollMs: 60_000,
      debounceMs: 5,
      ...(opts.allowSource ? { allowSource: opts.allowSource } : {}),
    },
  });
  t.after(async () => {
    await server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  return { server, port: server.port, manager, lines, configFile, fnet, mon };
}

/** GET / with a chosen Host header; "refused" for ECONNREFUSED, "closed" for a dropped socket. */
function get(address: string, port: number, hostHeader: string, extra: { origin?: string; localAddress?: string; method?: string } = {}): Promise<number | "refused" | "closed"> {
  return new Promise((resolve) => {
    const req = http.request({ host: address, port, path: "/", method: extra.method ?? "GET", headers: { host: hostHeader, ...(extra.origin ? { origin: extra.origin } : {}) }, agent: false, ...(extra.localAddress ? { localAddress: extra.localAddress } : {}) }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", (e: NodeJS.ErrnoException) => resolve(e.code === "ECONNREFUSED" ? "refused" : "closed"));
    req.setTimeout(3000, () => req.destroy());
    req.end();
  });
}

class Ws {
  ws: WebSocket;
  msgs: Record<string, any>[] = [];
  private id = 0;
  constructor(url: string, headers: Record<string, string> = {}, localAddress?: string) {
    this.ws = new WebSocket(url, { headers, ...(localAddress ? { localAddress } : {}) });
    this.ws.on("message", (d) => this.msgs.push(JSON.parse(d.toString())));
  }
  open(): Promise<"open" | "refused"> {
    return new Promise((res) => {
      this.ws.once("open", () => res("open"));
      this.ws.once("error", () => res("refused"));
    });
  }
  closed(): Promise<void> {
    return new Promise((res) => (this.ws.readyState === this.ws.CLOSED ? res() : this.ws.once("close", () => res())));
  }
  async call(method: string, params: unknown = {}): Promise<{ result?: any; error?: any }> {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    await waitFor(() => this.msgs.some((m) => m.id === id), `reply to ${method}`);
    return this.msgs.find((m) => m.id === id)!;
  }
  notes(): NetworkInfo[] {
    return this.msgs.filter((m) => m.method === "network").map((m) => m.params);
  }
}

const TRUSTED_HOME = { lan: { enabled: true, trusted: [{ uuid: "u-home", name: "Home", gatewayMac: "aa:bb:cc:dd:ee:01" }] } };

test("off (the default): no listener beyond loopback; *.localhost accepted, other names 403", async (t) => {
  const s = await setup(t);
  assert.equal(await get("127.0.0.1", s.port, `localhost:${s.port}`), 200);
  assert.equal(await get("127.0.0.1", s.port, `ana.localhost:${s.port}`), 200);
  assert.equal(await get("127.0.0.1", s.port, `a.b.localhost`), 200);
  assert.equal(await get("127.0.0.1", s.port, `evil.example:${s.port}`), 403);
  assert.equal(await get("127.0.0.1", s.port, `kappa:${s.port}`), 403);
  assert.equal(await get("127.0.0.1", s.port, `localhost`, { origin: "https://evil.example", method: "POST" }), 403);
  assert.equal(await get("127.0.0.2", s.port, `127.0.0.2:${s.port}`), "refused");
  const c = new Ws(`ws://127.0.0.1:${s.port}/ws`);
  assert.equal(await c.open(), "open");
  const info = (await c.call("network.get")).result as NetworkInfo;
  assert.deepEqual([info.lanEnabled, info.open, info.localhostSubdomains, info.canChange], [false, false, true, true]);
  assert.equal(info.reason, "Closed: the Local network switch is off");
  assert.deepEqual(s.mon.started, []); // no monitor while off
  c.ws.close();
});

test("refusals are logged once per name per hour", async (t) => {
  const s = await setup(t);
  for (let i = 0; i < 5; i++) assert.equal(await get("127.0.0.1", s.port, "evil.example"), 403);
  assert.equal(await get("127.0.0.1", s.port, "other.example"), 403);
  const warns = s.lines.filter((l) => l.level === "warn" && l.msg.startsWith("refused a request"));
  assert.deepEqual(
    warns.map((w) => w.msg),
    ['refused a request: host "evil.example" isn\'t a name motherapp answers to (logged once an hour per name)', 'refused a request: host "other.example" isn\'t a name motherapp answers to (logged once an hour per name)'],
  );
});

test("*.localhost toggle: applied live, loopback only, other config keys kept", async (t) => {
  const s = await setup(t, { config: { port: 0, tools: {}, junk: { keep: 1 } } });
  const sub = new Ws(`ws://127.0.0.1:${s.port}/ws`, { host: `ana.localhost:${s.port}`, origin: `http://ana.localhost:${s.port}` });
  assert.equal(await sub.open(), "open");
  const c = new Ws(`ws://127.0.0.1:${s.port}/ws`);
  assert.equal(await c.open(), "open");
  const r = await c.call("network.setLocalhostSubdomains", { enabled: false });
  assert.equal(r.result.localhostSubdomains, false);
  await sub.closed(); // its name is no longer accepted
  assert.equal(await get("127.0.0.1", s.port, "ana.localhost"), 403);
  assert.equal(await get("127.0.0.1", s.port, "localhost"), 200);
  const file = JSON.parse(fs.readFileSync(s.configFile, "utf8"));
  assert.equal(file.localhostSubdomains, false);
  assert.deepEqual(file.junk, { keep: 1 });
  await c.call("network.setLocalhostSubdomains", { enabled: true });
  assert.equal(await get("127.0.0.1", s.port, "ana.localhost"), 200);
  c.ws.close();
});

test("switch on + trusted network: listener up, LAN names accepted, live off again; config kept", async (t) => {
  const s = await setup(t, { config: { port: 0, tools: {}, junk: 1, lan: { enabled: false, extra: "x", trusted: TRUSTED_HOME.lan.trusted } } });
  const c = new Ws(`ws://127.0.0.1:${s.port}/ws`);
  assert.equal(await c.open(), "open");
  const on = (await c.call("network.setLan", { enabled: true })).result as NetworkInfo;
  assert.equal(on.open, true);
  assert.equal(on.reason, "Open on Home");
  assert.deepEqual(on.addresses, [`http://127.0.0.2:${s.port}/`]);
  assert.equal(on.canChange, true);
  assert.deepEqual(s.mon.started, ["nmcli monitor"]);
  assert.ok(s.lines.some((l) => l.msg === "network: LAN opened (Home)"));
  assert.ok(c.notes().some((n) => n.open));
  // Host rules while open
  assert.equal(await get("127.0.0.2", s.port, `kappa:${s.port}`), 200);
  assert.equal(await get("127.0.0.2", s.port, `kappa.local:${s.port}`), 200);
  assert.equal(await get("127.0.0.2", s.port, `127.0.0.2:${s.port}`), 200);
  assert.equal(await get("127.0.0.2", s.port, `evil.example:${s.port}`), 403);
  assert.equal(await get("127.0.0.1", s.port, `kappa:${s.port}`), 200); // also on the loopback listener
  const lanWs = new Ws(`ws://127.0.0.2:${s.port}/ws`, { host: `kappa.local:${s.port}`, origin: `http://kappa.local:${s.port}` });
  assert.equal(await lanWs.open(), "open");
  // it can look, but not change (not a localhost name)
  assert.equal(((await lanWs.call("network.get")).result as NetworkInfo).canChange, false);
  assert.match((await lanWs.call("network.setLan", { enabled: false })).error.message, /Only from this computer/);
  assert.match((await lanWs.call("network.trust")).error.message, /Only from this computer/);
  assert.match((await lanWs.call("network.untrust", { uuid: "u-home" })).error.message, /Only from this computer/);
  assert.match((await lanWs.call("network.setLocalhostSubdomains", { enabled: false })).error.message, /Only from this computer/);

  const off = (await c.call("network.setLan", { enabled: false })).result as NetworkInfo;
  assert.equal(off.open, false);
  await lanWs.closed(); // LAN clients are dropped
  assert.equal(await get("127.0.0.2", s.port, `127.0.0.2:${s.port}`), "refused");
  assert.equal(await get("127.0.0.1", s.port, `kappa:${s.port}`), 403);
  assert.equal(await get("127.0.0.1", s.port, `localhost:${s.port}`), 200); // loopback untouched
  assert.equal(c.ws.readyState, c.ws.OPEN); // the page that flipped it stays connected
  assert.ok(s.lines.some((l) => l.msg === "network: LAN closed (the Local network switch is off)"));
  assert.equal(s.mon.watchers.size, 0); // no monitor while off
  const file = JSON.parse(fs.readFileSync(s.configFile, "utf8"));
  assert.equal(file.junk, 1);
  assert.equal(file.lan.extra, "x");
  assert.equal(file.lan.enabled, false);
  c.ws.close();
});

test("a network change opens and closes the listener; transitions are logged once", async (t) => {
  const s = await setup(t, { config: { port: 0, tools: {}, ...TRUSTED_HOME } });
  await waitFor(() => s.server.lan.open, "opened at start");
  assert.equal(await get("127.0.0.2", s.port, "127.0.0.2"), 200);
  s.fnet.state.uuid = "u-cafe";
  s.fnet.state.name = "Cafe";
  s.mon.fire();
  await waitFor(() => !s.server.lan.open, "closed after the change");
  assert.equal(s.server.lan.reason, "Closed: not on a trusted network (Cafe)");
  assert.equal(await get("127.0.0.2", s.port, "127.0.0.2"), "refused");
  s.mon.fire(); // nothing changed: no second log line
  await s.server.lan.evaluate(true);
  // lookalike: same UUID and name as Home, another gateway
  Object.assign(s.fnet.state, { uuid: "u-home", name: "Home", mac: "66:66:66:66:66:66" });
  await s.server.lan.evaluate(true);
  assert.equal(s.server.lan.open, false);
  assert.match(s.server.lan.reason, /isn't the one you trusted/);
  s.fnet.state.mac = "aa:bb:cc:dd:ee:01";
  s.mon.fire();
  await waitFor(() => s.server.lan.open, "re-opened");
  assert.equal(await get("127.0.0.2", s.port, "127.0.0.2"), 200);
  const transitions = s.lines.filter((l) => /^network: LAN (opened|closed)/.test(l.msg)).map((l) => l.msg);
  assert.deepEqual(transitions, ["network: LAN opened (Home)", "network: LAN closed (not on a trusted network (Cafe))", "network: LAN opened (Home)"]);
});

test("no NetworkManager: untrusted, with the reason; trusting is refused", async (t) => {
  const s = await setup(t, { net: fakeNet({ nmcli: false }), config: { port: 0, tools: {}, ...TRUSTED_HOME } });
  await waitFor(() => s.server.lan.current !== null, "first look");
  assert.equal(s.server.lan.open, false);
  assert.equal(s.server.lan.reason, "Closed: can't identify the network (NetworkManager not available)");
  assert.deepEqual(s.mon.started, ["nmcli monitor"]);
  const c = new Ws(`ws://127.0.0.1:${s.port}/ws`);
  await c.open();
  assert.match((await c.call("network.trust")).error.message, /Can't trust this network: can't identify the network \(NetworkManager not available\)/);
  c.ws.close();
});

test("trust / untrust from loopback: recorded with the gateway MAC, applied live, other keys kept", async (t) => {
  const s = await setup(t, { config: { port: 0, tools: {}, other: [1, 2], lan: { enabled: true, trusted: [] } } });
  const c = new Ws(`ws://127.0.0.1:${s.port}/ws`);
  await c.open();
  let info = (await c.call("network.get", { refresh: true })).result as NetworkInfo;
  assert.equal(info.open, false);
  assert.equal(info.reason, "Closed: not on a trusted network (Home)");
  assert.deepEqual(info.current, { device: "eth0", gatewayIp: "192.168.1.1", name: "Home", uuid: "u-home", type: "802-3-ethernet", gatewayMac: "aa:bb:cc:dd:ee:01" });
  info = (await c.call("network.trust")).result as NetworkInfo;
  assert.equal(info.open, true);
  assert.equal(info.currentTrusted, true);
  assert.deepEqual(info.trusted, [{ uuid: "u-home", name: "Home", gatewayMac: "aa:bb:cc:dd:ee:01" }]);
  let file = JSON.parse(fs.readFileSync(s.configFile, "utf8"));
  assert.deepEqual(file.lan.trusted, [{ uuid: "u-home", name: "Home", gatewayMac: "aa:bb:cc:dd:ee:01" }]);
  assert.deepEqual(file.other, [1, 2]);
  info = (await c.call("network.untrust", { uuid: "u-home" })).result as NetworkInfo;
  assert.equal(info.open, false);
  assert.deepEqual(info.trusted, []);
  file = JSON.parse(fs.readFileSync(s.configFile, "utf8"));
  assert.deepEqual(file.lan.trusted, []);
  c.ws.close();
});

test("source addresses: a refused source is dropped on the LAN listener (allowSource hook)", async (t) => {
  const s = await setup(t, { config: { port: 0, tools: {}, ...TRUSTED_HOME }, allowSource: (a) => a !== "127.0.0.3" });
  await waitFor(() => s.server.lan.open, "opened");
  assert.equal(await get("127.0.0.2", s.port, "127.0.0.2", { localAddress: "127.0.0.4" }), 200);
  assert.equal(await get("127.0.0.2", s.port, "127.0.0.2", { localAddress: "127.0.0.3" }), "closed");
  assert.ok(s.lines.some((l) => l.msg.startsWith("refused a connection from 127.0.0.3")));
});

test("a real non-loopback interface: served exactly when its address is private/link-local", async (t) => {
  const real = Object.values(os.networkInterfaces())
    .flat()
    .find((i) => i && !i.internal && i.family === "IPv4");
  if (!real) return t.skip("no non-loopback IPv4 interface here");
  const s = await setup(t, { config: { port: 0, tools: {}, ...TRUSTED_HOME }, interfaces: os.networkInterfaces });
  await waitFor(() => s.server.lan.open, "opened");
  assert.ok(s.server.lan.info(false).addresses.includes(`http://${real.address}:${s.port}/`));
  const got = await get(real.address, s.port, `${real.address}:${s.port}`, { localAddress: real.address });
  assert.equal(got, isAllowedSource(real.address) ? 200 : "closed", `${real.address} is ${classifySource(real.address)}`);
  // and nothing is listening there once the switch is off
  const c = new Ws(`ws://127.0.0.1:${s.port}/ws`);
  await c.open();
  await c.call("network.setLan", { enabled: false });
  assert.equal(await get(real.address, s.port, real.address, { localAddress: real.address }), "refused");
  c.ws.close();
});

test("the 30 s re-check and the monitor run only while the switch is on", async (t) => {
  const s = await setup(t, { config: { port: 0, tools: {}, lan: { enabled: false, trusted: [] } } });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(s.fnet.state.calls.length, 0);
  assert.equal(s.mon.watchers.size, 0);
});
