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
import { ErrorCode } from "@motherapp/protocol";
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

async function setup(t: { after(fn: () => unknown): void }, opts: { config?: unknown; net?: ReturnType<typeof fakeNet>; allowSource?: (a: string | undefined) => boolean; interfaces?: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>; addTools?: (toolsDir: string) => void; addExternalTools?: (dir: string) => void } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ma-net-"));
  const toolsDir = path.join(tmp, "tools");
  fs.mkdirSync(toolsDir);
  opts.addTools?.(toolsDir);
  // a second tools folder, as main.ts passes for the tools outside the checkout
  const externalToolsDir = path.join(tmp, "external-tools");
  if (opts.addExternalTools) {
    fs.mkdirSync(externalToolsDir);
    opts.addExternalTools(externalToolsDir);
  }
  const webDir = path.join(tmp, "web");
  fs.mkdirSync(webDir);
  fs.writeFileSync(path.join(webDir, "index.html"), "<!doctype html><title>t</title>");
  const configFile = path.join(tmp, "config.json");
  if (opts.config !== undefined) fs.writeFileSync(configFile, JSON.stringify(opts.config));
  const lines: { level: string; msg: string }[] = [];
  const log = new LogService({ stdout: null });
  log.subscribe((e) => lines.push({ level: e.level, msg: e.msg }));
  const manager = new Manager({ toolsDir, configFile, log, ...(opts.addExternalTools ? { externalToolsDir } : {}) });
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
  return { server, port: server.port, manager, lines, configFile, fnet, mon, toolsDir, externalToolsDir };
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
  /** Resolves when the socket has closed; fails after 8 s rather than hang the run. */
  closed(): Promise<void> {
    return waitFor(() => this.ws.readyState === this.ws.CLOSED, "the connection to be closed");
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

// A tool without the SDK (the temp dir can't resolve packages): it notes every action it hears.
const NOTING_TOOL = `
import * as fs from "node:fs";
import * as readline from "node:readline";
for await (const line of readline.createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  if (m.id === undefined) continue;
  if (m.method === "action") fs.appendFileSync("heard.log", m.params.name + "\\n");
  const result = m.method === "describe" ? { title: "Noting", page: "custom" } : m.method === "state.get" ? { state: {} } : "ran";
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
}
`;

test("localActions: run from this computer, refused for a LAN client before the tool hears of them", async (t) => {
  let heard = "";
  const s = await setup(t, {
    config: { port: 0, tools: {}, ...TRUSTED_HOME },
    addTools: (toolsDir) => {
      const dir = path.join(toolsDir, "noting");
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, "t.mjs"), NOTING_TOOL);
      fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ id: "noting", title: "Noting", serve: ["node", "t.mjs"], localActions: ["secret"] }));
      heard = path.join(dir, "heard.log");
    },
  });
  t.after(() => s.manager.shutdown());
  await waitFor(() => s.manager.host("noting").status === "running", "tool running");
  const local = new Ws(`ws://127.0.0.1:${s.port}/ws`);
  assert.equal(await local.open(), "open");
  await local.call("network.get", { refresh: true });
  await waitFor(() => s.lines.some((l) => l.msg === "network: LAN opened (Home)"), "LAN open");
  const lan = new Ws(`ws://127.0.0.2:${s.port}/ws`, { host: `kappa.local:${s.port}`, origin: `http://kappa.local:${s.port}` });
  assert.equal(await lan.open(), "open");
  // A loopback source relaying under a LAN name is no better.
  const relayed = new Ws(`ws://127.0.0.1:${s.port}/ws`, { host: `kappa:${s.port}` });
  assert.equal(await relayed.open(), "open");

  const params = { tool: "noting", name: "secret" };
  assert.equal((await local.call("action", params)).result, "ran");
  for (const c of [lan, relayed]) {
    const { error } = await c.call("action", params);
    assert.equal(error.code, ErrorCode.LocalOnly);
    assert.match(error.message, /Only from this computer/);
  }
  assert.equal((await lan.call("action", { tool: "noting", name: "other" })).result, "ran");
  assert.deepEqual(fs.readFileSync(heard, "utf8").trim().split("\n"), ["secret", "other"]);
  for (const c of [local, lan, relayed]) c.ws.close();
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

// ---- a tool that is off the network (Settings -> "On the network"; DESIGN.md § 3 "Network switch scope") ----

// A tool without the SDK: it writes down everything it hears, has state, a stream, a
// notification kind and a log line.
const HIDEABLE_TOOL = `
import * as fs from "node:fs";
import * as readline from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
const me = process.env.MOTHERAPP_TOOL_ID;
let n = 0;
for await (const line of readline.createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  fs.appendFileSync("heard.log", m.method + (m.params?.name ? ":" + m.params.name : "") + (m.method === "watch" ? ":" + m.params.watching : "") + "\\n");
  if (m.id === undefined) continue;
  const name = m.params?.name;
  let result = null;
  if (m.method === "describe") result = { title: "Tool " + me, page: "custom" };
  else if (m.method === "state.get") result = { state: { n } };
  else if (m.method === "stream.open") setTimeout(() => send({ method: "stream", params: { name, value: "tick from " + me } }), 5);
  else if (m.method === "action" && name === "inc") { n++; send({ method: "state", params: { changes: [{ path: "n", value: n }] } }); result = n; }
  else if (m.method === "action" && name === "notify") send({ method: "notify", params: { kind: "done", title: "Done in " + me } });
  else if (m.method === "action" && name === "log") send({ method: "log", params: { level: "info", msg: "hello from " + me } });
  else if (m.method === "action") result = "ran";
  send({ id: m.id, result });
}
`;

function writeHideable(dir: string, id: string): void {
  const d = path.join(dir, id);
  fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, "t.mjs"), HIDEABLE_TOOL);
  fs.writeFileSync(path.join(d, "page.ts"), "export default class P extends HTMLElement {}\n");
  fs.writeFileSync(path.join(d, "icon.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  fs.writeFileSync(
    path.join(d, "manifest.json"),
    JSON.stringify({ id, title: `Tool ${id}`, serve: ["node", "t.mjs"], icon: "icon.svg", page: "page.ts", localActions: ["secret"], notifications: [{ id: "done", label: "Done" }] }),
  );
}

/** GET with a chosen Host header: status and body. */
function getBody(address: string, port: number, hostHeader: string, pathname: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: address, port, path: pathname, headers: { host: hostHeader }, agent: false }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** A core with two tools in tools/ and two in the external folder, LAN open, all running. */
async function hideableSetup(t: { after(fn: () => unknown): void }, tools: Record<string, unknown>) {
  const s = await setup(t, {
    config: { port: 0, tools, keep: "me", ...TRUSTED_HOME },
    addTools: (dir) => ["plain", "shy"].forEach((id) => writeHideable(dir, id)),
    addExternalTools: (dir) => ["xplain", "xshy"].forEach((id) => writeHideable(dir, id)),
  });
  t.after(() => s.manager.shutdown());
  await waitFor(() => ["plain", "shy", "xplain", "xshy"].every((id) => s.manager.host(id).status === "running"), "tools running");
  await waitFor(() => s.server.lan.open, "LAN open");
  const local = new Ws(`ws://127.0.0.1:${s.port}/ws`, { origin: `http://localhost:${s.port}` });
  assert.equal(await local.open(), "open");
  const heard = (id: string) => {
    const f = path.join(id.startsWith("x") ? s.externalToolsDir : s.toolsDir, id, "heard.log");
    return fs.readFileSync(f, "utf8").trim().split("\n").filter((l) => !/^(describe|state\.get)$/.test(l));
  };
  const lanClient = async () => {
    const c = new Ws(`ws://127.0.0.2:${s.port}/ws`, { host: `kappa.local:${s.port}`, origin: `http://kappa.local:${s.port}` });
    assert.equal(await c.open(), "open");
    return c;
  };
  const file = () => JSON.parse(fs.readFileSync(s.configFile, "utf8"));
  return { ...s, local, heard, lanClient, file };
}

const toolsOf = (c: Ws) => c.msgs.filter((m) => m.method === "tools").at(-1)?.params as { tools: Record<string, any>[]; orderSaved: boolean } | undefined;
const pushes = (c: Ws, method: string) => c.msgs.filter((m) => m.method === method).map((m) => m.params);
const HIDDEN = ["shy", "xshy"];

test("off the network: for a LAN client the tool doesn't exist, in every message and route; this computer sees everything", async (t) => {
  const s = await hideableSetup(t, { shy: { network: false }, xshy: { network: false, enabled: true } });
  const { local, port } = s;
  // Something to see from every tool before the LAN clients connect.
  for (const id of ["plain", "shy", "xplain", "xshy"]) {
    for (const name of ["inc", "notify", "log"]) assert.equal((await local.call("action", { tool: id, name })).error, undefined);
  }
  await waitFor(() => s.manager.notifications.backlog().length === 4, "four notifications recorded");
  const lan = await s.lanClient();
  // A loopback source that came in under a LAN name (a relay) is a LAN client too.
  const relayed = new Ws(`ws://127.0.0.1:${port}/ws`, { host: `kappa:${port}` });
  assert.equal(await relayed.open(), "open");

  // -- this computer: every tool, with its setting
  await waitFor(() => toolsOf(local) !== undefined, "tools");
  assert.deepEqual(toolsOf(local)!.tools.map((x) => [x.id, x.onNetwork]), [["plain", true], ["shy", false], ["xplain", true], ["xshy", false]]);
  assert.deepEqual(pushes(local, "snapshot").map((p) => p.tool).sort(), ["plain", "shy", "xplain", "xshy"]);
  const status = await getBody("127.0.0.1", port, `localhost:${port}`, "/api/status");
  assert.deepEqual(JSON.parse(status.body).tools.map((x: any) => x.id), ["plain", "shy", "xplain", "xshy"]);
  for (const id of HIDDEN) {
    assert.equal((await getBody("127.0.0.1", port, `localhost:${port}`, `/tools/${id}/page.ts`)).status, 200);
    assert.equal((await getBody("127.0.0.1", port, `localhost:${port}`, `/tools/${id}/icon.svg`)).status, 200);
  }
  assert.deepEqual((await local.call("notifications.settings.get")).result.tools.map((x: any) => x.id), ["plain", "shy", "xplain", "xshy"]);
  const localLogs = (await local.call("logs.subscribe")).result.entries as any[];
  assert.ok(localLogs.some((e) => e.tool === "shy" && e.msg === "hello from shy"));
  assert.ok(localLogs.some((e) => e.tool === "core" && /^discovered 4 tool/.test(e.msg)));
  assert.deepEqual((await local.call("notifications.subscribe")).result.entries.map((e: any) => e.tool), ["plain", "shy", "xplain", "xshy"]);
  assert.equal((await local.call("action", { tool: "shy", name: "secret" })).result, "ran"); // localActions as before

  for (const [who, c, address, hostHeader] of [["lan", lan, "127.0.0.2", `kappa.local:${port}`], ["relayed", relayed, "127.0.0.1", `kappa:${port}`]] as const) {
    // -- lists
    await waitFor(() => toolsOf(c) !== undefined, "tools");
    assert.deepEqual(toolsOf(c)!.tools.map((x) => x.id), ["plain", "xplain"], who);
    assert.ok(toolsOf(c)!.tools.every((x) => !("onNetwork" in x)), "a LAN client isn't told the setting exists");
    assert.equal(toolsOf(c)!.orderSaved, false);
    await waitFor(() => pushes(c, "snapshot").length === 2, "snapshots");
    assert.deepEqual(pushes(c, "snapshot").map((p) => p.tool).sort(), ["plain", "xplain"]);

    // -- HTTP
    const st = await getBody(address, port, hostHeader, "/api/status");
    assert.deepEqual(JSON.parse(st.body).tools.map((x: any) => x.id), ["plain", "xplain"]);
    const never = await getBody(address, port, hostHeader, "/tools/nosuch/page.ts");
    for (const id of HIDDEN) {
      for (const f of ["page.ts", "icon.svg"]) assert.deepEqual(await getBody(address, port, hostHeader, `/tools/${id}/${f}`), never, `${id}/${f} answers as an unknown tool`);
    }
    assert.equal(never.status, 404);
    assert.equal((await getBody(address, port, hostHeader, "/tools/plain/page.ts")).status, 200);
    assert.equal((await getBody(address, port, hostHeader, "/tools/xplain/icon.svg")).status, 200);

    // -- requests that name a tool: the answer an id that was never installed gets
    const asUnknown = async (method: string, params: (tool: string) => object) => {
      const never = await c.call(method, params("nosuch"));
      for (const id of HIDDEN) {
        const got = await c.call(method, params(id));
        assert.deepEqual({ ...got, id: 0 }, JSON.parse(JSON.stringify({ ...never, id: 0 }).replaceAll("nosuch", id)), `${method} for ${id}`);
      }
      return never;
    };
    assert.equal((await asUnknown("action", (tool) => ({ tool, name: "inc" }))).error.code, ErrorCode.UnknownTool);
    assert.equal((await asUnknown("action", (tool) => ({ tool, name: "secret" }))).error.code, ErrorCode.UnknownTool); // not LocalOnly
    assert.equal((await asUnknown("stream.open", (tool) => ({ tool, name: "wave" }))).error.code, ErrorCode.UnknownTool);
    assert.equal((await asUnknown("stream.close", (tool) => ({ tool, name: "wave" }))).result, null);
    assert.equal((await asUnknown("tool.watch", (tool) => ({ tool }))).error.code, ErrorCode.UnknownTool);
    assert.equal((await asUnknown("tool.restart", (tool) => ({ tool }))).error.code, ErrorCode.UnknownTool);
    assert.equal((await asUnknown("tool.setEnabled", (tool) => ({ tool, enabled: false }))).error.code, ErrorCode.UnknownTool);
    assert.equal((await asUnknown("notifications.setTool", (tool) => ({ tool, enabled: false }))).error.code, ErrorCode.InvalidParams);
    assert.equal((await asUnknown("notifications.setKind", (tool) => ({ tool, kind: "done", enabled: false }))).error.code, ErrorCode.InvalidParams);
    // -- the setting itself: the same refusal for a hidden tool, a visible one and no tool at all
    for (const onNetwork of [true, false]) {
      const never = await asUnknown("tool.setOnNetwork", (tool) => ({ tool, onNetwork }));
      assert.match(never.error.message, /^Only from this computer/);
      assert.deepEqual((await c.call("tool.setOnNetwork", { tool: "plain", onNetwork })).error, never.error);
    }
    assert.deepEqual((await c.call("tool.setOnNetwork", { tool: "shy", onNetwork: "yes" })).error.message.slice(0, 23), "Only from this computer");

    // -- notifications: history, settings rows
    assert.deepEqual((await c.call("notifications.subscribe")).result.entries.map((e: any) => e.tool), ["plain", "xplain"]);
    assert.deepEqual((await c.call("notifications.subscribe", { limit: 1 })).result.entries.map((e: any) => e.tool), ["xplain"]);
    assert.deepEqual((await c.call("notifications.settings.get")).result.tools.map((x: any) => x.id), ["plain", "xplain"]);
    assert.deepEqual((await c.call("notifications.setTool", { tool: "plain", enabled: true })).result.tools.map((x: any) => x.id), ["plain", "xplain"]);
    assert.deepEqual((await c.call("notifications.setKind", { tool: "plain", kind: "done", enabled: true })).result.tools.map((x: any) => x.id), ["plain", "xplain"]);
    assert.deepEqual((await c.call("notifications.setMuted", { muted: false })).result.tools.map((x: any) => x.id), ["plain", "xplain"]);

    // -- logs: nothing of the tool, and nothing of the core's that names it
    const logs = (await c.call("logs.subscribe")).result.entries as any[];
    assert.ok(logs.some((e) => e.tool === "plain" && e.msg === "hello from plain"));
    assert.ok(logs.some((e) => e.tool === "core" && /^network: LAN opened/.test(e.msg)));
    assert.deepEqual(logs.filter((e) => HIDDEN.includes(e.tool)), []);
    assert.deepEqual(logs.filter((e) => /^discovered /.test(e.msg)), [], "it lists every tool id");
    const two = (await c.call("logs.subscribe", { limit: 2 })).result.entries as any[];
    assert.deepEqual(two, logs.slice(-2), "the newest two of what it may see");
  }

  // -- live pushes: state, stream, notification, log, notification settings. Each is made for a
  // hidden tool first and then for a visible one; when the visible one's arrived, the other didn't.
  const before = lan.msgs.length;
  await lan.call("stream.open", { tool: "plain", name: "wave" });
  await local.call("stream.open", { tool: "shy", name: "wave" });
  for (const id of ["shy", "xshy", "plain"]) for (const name of ["inc", "notify", "log"]) await local.call("action", { tool: id, name });
  await local.call("notifications.setTool", { tool: "shy", enabled: true });
  for (const c of [lan, relayed]) {
    await waitFor(() => pushes(c, "state").some((p) => p.tool === "plain"), "state push");
    await waitFor(() => pushes(c, "notification").some((p) => p.entry.tool === "plain"), "notification push");
    await waitFor(() => pushes(c, "log").some((p) => p.entry.msg === "hello from plain"), "log push");
    await waitFor(() => pushes(c, "notifications.settings").length >= 3, "settings pushes");
    assert.deepEqual(pushes(c, "notifications.settings").at(-1).tools.map((x: any) => x.id), ["plain", "xplain"]);
  }
  await waitFor(() => pushes(lan, "stream").length > 0 && pushes(local, "stream").length > 0, "stream values");
  assert.deepEqual(pushes(lan, "stream").map((p) => p.value), ["tick from plain"]);
  await waitFor(() => pushes(local, "state").filter((p) => HIDDEN.includes(p.tool)).length >= 2 && pushes(local, "notification").filter((p) => HIDDEN.includes(p.entry.tool)).length >= 2, "this computer got the hidden tools' pushes");
  assert.ok(lan.msgs.length > before);

  // -- order: the tools a LAN client can't see keep their places and can't be named
  assert.equal((await lan.call("tools.setOrder", { order: ["xshy", "xplain", "shy", "plain"] })).result, null);
  await waitFor(() => toolsOf(local)!.tools.map((x) => x.id).join() === "xplain,shy,plain,xshy", "the order on this computer");
  await waitFor(() => toolsOf(lan)!.tools.map((x) => x.id).join() === "xplain,plain" && toolsOf(lan)!.orderSaved, "the order on the LAN client");
  assert.equal((await lan.call("tools.resetOrder")).result, null);
  await waitFor(() => toolsOf(lan)!.tools.map((x) => x.id).join() === "plain,xplain" && !toolsOf(lan)!.orderSaved, "reset on the LAN client");
  assert.deepEqual(toolsOf(local)!.tools.map((x) => x.id), ["plain", "shy", "xplain", "xshy"]);

  // -- nothing a LAN client was sent names a hidden tool, apart from the errors that repeat the
  // id it asked about itself
  for (const c of [lan, relayed]) {
    const sent = JSON.stringify(c.msgs.filter((m) => m.error === undefined));
    for (const id of HIDDEN) assert.ok(!new RegExp(`\\b${id}\\b`).test(sent.replaceAll("xshy", id === "shy" ? "-" : "xshy")), `${id} in a message to a LAN client`);
  }
  // -- and the tools heard only what this computer asked for
  assert.deepEqual(s.heard("shy"), ["action:inc", "action:notify", "action:log", "action:secret", "stream.open:wave", "action:inc", "action:notify", "action:log"]);
  assert.deepEqual(s.heard("xshy"), ["action:inc", "action:notify", "action:log", "action:inc", "action:notify", "action:log"]);
  assert.deepEqual(s.file().tools, { shy: { network: false }, xshy: { network: false, enabled: true } }, "no LAN request changed a tool's settings");
  for (const c of [local, lan, relayed]) c.ws.close();
});

test("on the network (the default): a LAN client sees and uses every tool, built-in and external, as before", async (t) => {
  const s = await hideableSetup(t, {});
  const lan = await s.lanClient();
  await waitFor(() => toolsOf(lan) !== undefined && pushes(lan, "snapshot").length === 4, "tools and snapshots");
  assert.deepEqual(toolsOf(lan)!.tools.map((x) => x.id), ["plain", "shy", "xplain", "xshy"]);
  assert.deepEqual((await getBody("127.0.0.2", s.port, `kappa.local:${s.port}`, "/api/status")).body.match(/"id":"\w+"/g), ['"id":"plain"', '"id":"shy"', '"id":"xplain"', '"id":"xshy"']);
  for (const id of HIDDEN) {
    assert.equal((await getBody("127.0.0.2", s.port, `kappa.local:${s.port}`, `/tools/${id}/page.ts`)).status, 200);
    assert.equal((await lan.call("action", { tool: id, name: "inc" })).result, 1);
    assert.equal((await lan.call("action", { tool: id, name: "secret" })).error.code, ErrorCode.LocalOnly); // localActions still apply
    assert.equal((await lan.call("action", { tool: id, name: "notify" })).error, undefined);
    assert.equal((await lan.call("action", { tool: id, name: "log" })).error, undefined);
    assert.equal((await lan.call("tool.watch", { tool: id })).result, null);
    assert.equal((await lan.call("stream.open", { tool: id, name: "wave" })).result, null);
    assert.equal((await lan.call("notifications.setTool", { tool: id, enabled: true })).error, undefined);
  }
  await waitFor(() => pushes(lan, "stream").length === 2, "stream values");
  await waitFor(() => pushes(lan, "state").length === 2, "state pushes");
  assert.deepEqual((await lan.call("notifications.subscribe")).result.entries.map((e: any) => e.tool), HIDDEN);
  assert.deepEqual((await lan.call("notifications.settings.get")).result.tools.map((x: any) => x.id), ["plain", "shy", "xplain", "xshy"]);
  const logs = (await lan.call("logs.subscribe")).result.entries as any[];
  assert.ok(logs.some((e) => e.msg === "hello from shy") && logs.some((e) => e.msg === "hello from xshy") && logs.some((e) => /^discovered 4 tool/.test(e.msg)));
  assert.equal((await lan.call("tools.setOrder", { order: ["xshy", "shy"] })).result, null);
  await waitFor(() => toolsOf(lan)!.tools.map((x) => x.id).join() === "xshy,shy,plain,xplain", "a LAN client may order every tool it sees");
  assert.equal((await lan.call("tools.resetOrder")).result, null);
  await waitFor(() => !toolsOf(lan)!.orderSaved, "reset");
  assert.equal(s.file().order, undefined, "a real reset: no saved order left");
  assert.equal((await lan.call("tool.setEnabled", { tool: "xshy", enabled: false })).result, null);
  assert.deepEqual(s.file().tools, { xshy: { enabled: false } });
  lan.ws.close();
  s.local.ws.close();
});

test("changing it: only from this computer, saved as tools.<id>.network, and at once for connected LAN clients", async (t) => {
  const s = await hideableSetup(t, { shy: { enabled: true, custom: 1 } });
  const { local } = s;
  const lan = await s.lanClient();
  await waitFor(() => toolsOf(lan)?.tools.length === 4, "all four tools on the LAN client");
  await lan.call("stream.open", { tool: "shy", name: "wave" });
  await lan.call("tool.watch", { tool: "shy" });
  await waitFor(() => s.heard("shy").includes("watch:true"), "the tool is watched");
  assert.match((await lan.call("tool.setOnNetwork", { tool: "plain", onNetwork: false })).error.message, /^Only from this computer/);
  assert.equal(s.manager.isOnNetwork("plain"), true);

  for (const id of HIDDEN) {
    // -- off: saved, this computer's page keeps its connection and gets the push, the LAN client is dropped
    assert.equal((await local.call("tool.setOnNetwork", { tool: id, onNetwork: "no" })).error.code, ErrorCode.InvalidParams);
    assert.equal((await local.call("tool.setOnNetwork", { tool: "nosuch", onNetwork: false })).error.code, ErrorCode.UnknownTool);
    const before = await s.lanClient();
    await waitFor(() => toolsOf(before)?.tools.some((x) => x.id === id) === true, "the tool on a LAN client");
    assert.equal((await local.call("tool.setOnNetwork", { tool: id, onNetwork: false })).result, null);
    await before.closed();
    await waitFor(() => toolsOf(local)!.tools.find((x) => x.id === id)!.onNetwork === false, "the push to this computer");
    assert.equal(local.ws.readyState, local.ws.OPEN);
    // what its page does next: reconnect, and the tool isn't there
    const after = await s.lanClient();
    await waitFor(() => toolsOf(after) !== undefined, "tools after the reconnect");
    assert.ok(!toolsOf(after)!.tools.some((x) => x.id === id));
    assert.equal((await after.call("action", { tool: id, name: "inc" })).error.code, ErrorCode.UnknownTool);
    // the same value again changes nothing and drops nobody
    assert.equal((await local.call("tool.setOnNetwork", { tool: id, onNetwork: false })).result, null);
    await after.call("network.get");
    assert.equal(after.ws.readyState, after.ws.OPEN);

    // -- on again: the LAN client is dropped again, and its reconnect has the tool and its state
    assert.equal((await local.call("tool.setOnNetwork", { tool: id, onNetwork: true })).result, null);
    await after.closed();
    const back = await s.lanClient();
    await waitFor(() => pushes(back, "snapshot").some((p) => p.tool === id), "the tool's snapshot");
    assert.ok(toolsOf(back)!.tools.some((x) => x.id === id));
    assert.equal(typeof (await back.call("action", { tool: id, name: "inc" })).result, "number");
    back.ws.close();
    assert.equal((await local.call("tool.setOnNetwork", { tool: id, onNetwork: false })).result, null);
  }
  await lan.closed(); // the first one went with the first change
  // its stream and its watching went with it (the tool was told once the debounce ran)
  await waitFor(() => s.heard("shy").includes("stream.close:wave"), "the stream closed");
  assert.equal(s.manager.host("shy").viewerCount, 0);

  // -- config.json: only what was changed, other keys kept; enabling keeps it
  assert.deepEqual(s.file().tools, { shy: { enabled: true, custom: 1, network: false }, xshy: { network: false } });
  assert.equal(s.file().keep, "me");
  assert.equal((await local.call("tool.setEnabled", { tool: "xshy", enabled: true })).result, null);
  assert.deepEqual(s.file().tools.xshy, { network: false, enabled: true });
  assert.equal(s.manager.isOnNetwork("xshy"), false);
  assert.equal((await local.call("tool.setOnNetwork", { tool: "shy", onNetwork: true })).result, null);
  assert.deepEqual(s.file().tools.shy, { enabled: true, custom: 1 }, "back to the default: the key is gone");
  // -- the log says so under the tool's own name (so a LAN client's logs don't, while it is hidden)
  const logs = (await local.call("logs.subscribe")).result.entries as any[];
  assert.ok(logs.some((e) => e.tool === "xshy" && /^taken off the network/.test(e.msg)));
  assert.ok(logs.some((e) => e.tool === "shy" && e.msg === "on the network again"));
  local.ws.close();
});

test("the setting is read from config.json at start; a broken value means on the network", async (t) => {
  const s = await hideableSetup(t, { shy: { network: false }, xshy: { network: "no" }, plain: { network: true }, xplain: {} });
  assert.deepEqual(["plain", "shy", "xplain", "xshy"].map((id) => s.manager.isOnNetwork(id)), [true, false, true, true]);
  assert.deepEqual([...s.manager.offNetwork()], ["shy"]);
  assert.equal(s.manager.isEnabled("shy"), true, "network alone doesn't disable a tool");
  s.local.ws.close();
});
