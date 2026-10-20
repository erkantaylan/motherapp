// End to end: the real core starts the inbox tool, which runs a fake `tmux` and a fake
// `cloudflared` put first on PATH. A link is made over the core's WebSocket (as the page does)
// and with `inboxctl` (through the core), messages go to the inbox's own listener, and nothing
// secret reaches the core's stdout (journald) or its log file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { claudePane, tmpDir, waitFor } from "./fakes.ts";
import type { FakePane } from "./fakes.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..", "..");

class Client {
  ws: WebSocket;
  msgs: Record<string, any>[] = [];
  private id = 0;
  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on("message", (d) => this.msgs.push(JSON.parse(d.toString())));
  }
  open() {
    return new Promise<void>((res, rej) => {
      this.ws.once("open", () => res());
      this.ws.once("error", rej);
    });
  }
  async call(method: string, params: unknown): Promise<{ result?: any; error?: any }> {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    await waitFor(() => this.msgs.some((m) => m.id === id), `reply to ${method}`, 20_000);
    return this.msgs.find((m) => m.id === id)!;
  }
  /** The inbox tool's state: last snapshot plus the deltas after it. */
  state(): Record<string, any> {
    const st: Record<string, any> = {};
    for (const m of this.msgs) {
      if (m.method === "snapshot" && m.params.tool === "inbox") Object.assign(st, structuredClone(m.params.state));
      if (m.method === "state" && m.params.tool === "inbox") {
        for (const c of m.params.changes) {
          const keys = c.path.split(".");
          let o = st;
          for (const k of keys.slice(0, -1)) o = o[k] ??= {};
          if (c.value === null) delete o[keys.at(-1)!];
          else o[keys.at(-1)!] = c.value;
        }
      }
    }
    return st;
  }
  notes(method: string) {
    return this.msgs.filter((m) => m.method === method).map((m) => m.params);
  }
}

function request(url: string, method: string, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request(url, { method, headers: { "content-type": "application/json" }, agent: false }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode!, body: b }));
    });
    r.on("error", reject);
    r.end(body);
  });
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (err += c));
    p.on("close", (code) => resolve({ code, out, err }));
  });
}

test("core + inbox tool: link over the WebSocket and inboxctl, delivery, revoke, no secrets in logs", async (t) => {
  const tmp = tmpDir("e2e");
  const bin = path.join(tmp, "bin");
  const fake = path.join(tmp, "fake");
  fs.mkdirSync(bin);
  fs.mkdirSync(fake);
  const panes: FakePane[] = [claudePane(0, { index: 0 }), claudePane(1, { session: "other", index: 0, command: "bash" })];
  fs.writeFileSync(path.join(fake, "panes.json"), JSON.stringify(panes));
  const readPanes = () => JSON.parse(fs.readFileSync(path.join(fake, "panes.json"), "utf8")) as FakePane[];
  for (const name of ["tmux", "cloudflared"]) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nexec "${process.execPath}" --disable-warning=ExperimentalWarning "${path.join(here, "fake-bins.ts")}" ${name} "$@"\n`, { mode: 0o755 });
  }
  const cfgDir = path.join(tmp, "config", "motherapp");
  fs.mkdirSync(cfgDir, { recursive: true });
  const others = ["audio", "brightness", "tmux", "shortcuts", "demo"];
  fs.writeFileSync(path.join(cfgDir, "config.json"), JSON.stringify({ port: 0, tools: Object.fromEntries(others.map((id) => [id, { enabled: false }])) }));
  fs.writeFileSync(path.join(cfgDir, "inbox.json"), JSON.stringify({ port: 0, sendDelayMs: 10, verifyDelayMs: 10, checkScreen: true }));
  const calls = () =>
    fs.existsSync(path.join(fake, "calls.log")) ? fs.readFileSync(path.join(fake, "calls.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]) : [];

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_DIR: fake,
    XDG_CONFIG_HOME: path.join(tmp, "config"),
    XDG_STATE_HOME: path.join(tmp, "state"),
    MOTHERAPP_TOOLS_DIR: path.join(repo, "tools"),
    MOTHERAPP_WEB_DIR: path.join(tmp, "noweb"),
  };
  const core = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(repo, "core/src/main.ts")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let coreErr = "";
  core.stderr.on("data", (c) => (coreErr += c));
  t.after(() => {
    core.kill("SIGKILL");
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const raw: string[] = [];
  let buf = "";
  core.stdout.setEncoding("utf8");
  core.stdout.on("data", (c: string) => {
    buf += c;
    const parts = buf.split("\n");
    buf = parts.pop()!;
    raw.push(...parts.filter(Boolean));
  });
  const lines = () => raw.map((l) => JSON.parse(l) as Record<string, any>);
  await waitFor(() => lines().some((l) => l.fields?.port), "core listening", 10_000);
  const corePortNum = lines().find((l) => l.fields?.port)!.fields.port as number;

  const c = new Client(`ws://127.0.0.1:${corePortNum}/ws`);
  await c.open();
  await waitFor(() => c.notes("tools").some((p) => p.tools.find((x: any) => x.id === "inbox")?.status === "running"), "inbox running", 15_000);
  const info = c.notes("tools").at(-1).tools.find((x: any) => x.id === "inbox");
  assert.equal(info.page, "custom");
  assert.equal(info.pageUrl, "/tools/inbox/page.ts");
  await waitFor(() => c.state().listener?.port > 0, "inbox listener", 10_000);
  const inboxPort = c.state().listener.port as number;
  assert.notEqual(inboxPort, corePortNum);
  await waitFor(() => c.state().panes?.["0"]?.target === "motherapp:0.0", "pane list", 10_000);
  assert.equal(c.state().panes["1"], undefined, "the bash pane isn't listed");

  // 1. a link from the page's action
  const created = await c.call("action", { tool: "inbox", name: "create", args: { pane: "motherapp:0.0", label: "cloud" } });
  assert.equal(created.error, undefined, JSON.stringify(created.error));
  const link = created.result.link as string;
  assert.match(link, /^https:\/\/e2e-fake-host\.trycloudflare\.com\/inbox\/[A-Za-z0-9_-]{43}$/);
  const token = link.split("/").at(-1)!;
  const cf = calls().filter((x) => x[0] === "cloudflared");
  assert.deepEqual(cf, [["cloudflared", "tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${inboxPort}`]], "cloudflared points at the inbox port only");

  // 2. the agent's side, on the inbox listener (what cloudflared forwards to)
  const skill = await request(`http://127.0.0.1:${inboxPort}/inbox/${token}`, "GET");
  assert.equal(skill.status, 200);
  assert.match(skill.body, /motherapp:0\.0/);
  const sent = await request(`http://127.0.0.1:${inboxPort}/inbox/${token}`, "POST", JSON.stringify({ text: "hello from the cloud", ref: "#11" }));
  assert.equal(sent.status, 200, sent.body);
  assert.deepEqual(readPanes()[0]!.submitted, ["[inbox: cloud] (re #11) hello from the cloud"]);
  const sends = calls().filter((x) => x[0] === "tmux" && x.includes("send-keys"));
  assert.deepEqual(sends.map((x) => x.slice(2)), [
    ["send-keys", "-t", "%0", "-l", "--", "[inbox: cloud] (re #11) hello from the cloud"],
    ["send-keys", "-t", "%0", "Enter"],
  ]);
  assert.equal((await request(`http://127.0.0.1:${inboxPort}/`, "GET")).status, 404);
  assert.equal((await request(`http://127.0.0.1:${inboxPort}/ws`, "GET")).status, 404, "the core isn't behind the inbox port");
  await waitFor(() => Object.values(c.state().log ?? {}).length === 1, "log on the page");

  // 3. inboxctl goes through the running core
  const ctl = path.join(repo, "tools/inbox/inboxctl.ts");
  const cliEnv = { ...env, MOTHERAPP_PORT: String(corePortNum) };
  const links = await run(process.execPath, ["--disable-warning=ExperimentalWarning", ctl, "links"], cliEnv);
  assert.equal(links.code, 0, links.err);
  assert.match(links.out, new RegExp(`^${created.result.id}  …${token.slice(-4)}  cloud  → motherapp:0\\.0  expires in 24 h, 1 message\\n$`));
  const refused = await run(process.execPath, ["--disable-warning=ExperimentalWarning", ctl, "new", "--pane", "motherapp:0.0", "--label", "second"], cliEnv);
  assert.equal(refused.code, 2, "stdout is a pipe here");
  assert.equal(refused.out, "");
  const made = await run(process.execPath, ["--disable-warning=ExperimentalWarning", ctl, "new", "--pane", "motherapp:0.0", "--label", "second", "--expires", "1h", "--print"], cliEnv);
  assert.equal(made.code, 0, made.err);
  const link2 = made.out.trim();
  assert.match(link2, /^https:\/\/e2e-fake-host\.trycloudflare\.com\/inbox\/[A-Za-z0-9_-]{43}$/);
  const token2 = link2.split("/").at(-1)!;
  assert.equal(calls().filter((x) => x[0] === "cloudflared").length, 1, "the running tunnel is reused");
  const notClaude = await run(process.execPath, ["--disable-warning=ExperimentalWarning", ctl, "new", "--pane", "other:0.0", "--label", "x", "--print"], cliEnv);
  assert.equal(notClaude.code, 1);
  assert.match(notClaude.err, /not Claude/);

  // 4. revoke (with inboxctl) → the same 404 as an unknown token
  const rv = await run(process.execPath, ["--disable-warning=ExperimentalWarning", ctl, "revoke", created.result.id], cliEnv);
  assert.equal(rv.code, 0, rv.err);
  const after = await request(`http://127.0.0.1:${inboxPort}/inbox/${token}`, "POST", JSON.stringify({ text: "x" }));
  const unknown = await request(`http://127.0.0.1:${inboxPort}/inbox/${"Z".repeat(43)}`, "POST", JSON.stringify({ text: "x" }));
  assert.deepEqual(after, unknown);
  assert.equal(after.status, 404);
  assert.equal((await request(`http://127.0.0.1:${inboxPort}/inbox/${token2}`, "GET")).status, 200, "the other link still works");

  // 5. nothing secret in the journal (core stdout), the log file, or anyone's stderr
  await waitFor(() => lines().some((l) => l.tool === "inbox" && l.msg === "inbox link revoked"), "revoke logged");
  const logFile = fs.readFileSync(path.join(tmp, "state", "motherapp", "log.jsonl"), "utf8");
  for (const secret of [token, token2, token.slice(0, 16), token2.slice(0, 16)]) {
    assert.ok(!raw.join("\n").includes(secret), "core stdout");
    assert.ok(!logFile.includes(secret), "log.jsonl");
    assert.ok(!coreErr.includes(secret), "core stderr");
    assert.ok(!links.err.includes(secret) && !rv.out.includes(secret));
  }
  assert.ok(!made.err.includes(token2), "inboxctl new prints the link once, on stdout");
  assert.ok(lines().some((l) => l.tool === "inbox" && l.msg === "inbox message submitted"));
  const files = fs.readdirSync(path.join(tmp, "state", "motherapp", "inbox"));
  for (const f of files) assert.ok(!fs.readFileSync(path.join(tmp, "state", "motherapp", "inbox", f), "utf8").includes(token2), f);
  assert.equal(fs.statSync(path.join(tmp, "state", "motherapp", "inbox")).mode & 0o777, 0o700);
  c.ws.close();
});
