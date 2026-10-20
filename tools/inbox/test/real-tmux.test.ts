// Against a real tmux (3.4 in the cloud container: `apt-get install tmux`), skipped without one.
// Every call uses a private socket (-S <tmpdir>/sock), never the user's server, and the server
// is killed afterwards. The "Claude" pane runs test/fake-claude.ts, which sets
// process.title = "claude" like Claude Code does.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { RealRunner } from "../../tmux/src/runner.ts";
import type { Proc, Runner } from "../../tmux/src/runner.ts";
import { typeAndSubmit } from "../src/deliver.ts";
import { idleState } from "../src/idle.ts";
import { TmuxPanes } from "../src/panes.ts";
import { harness, waitFor } from "./fakes.ts";

const hasTmux = spawnSync("tmux", ["-V"], { encoding: "utf8" }).status === 0;
const skip = hasTmux ? false : "tmux is not installed";
const here = path.dirname(fileURLToPath(import.meta.url));

let dir = "";
let sock = "";
const runner = new RealRunner();

function tmux(...args: string[]) {
  const r = spawnSync("tmux", ["-u", "-S", sock, ...args], { encoding: "utf8", env: { ...process.env, TMUX: "" } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/** A session whose pane runs the fake Claude; returns its pane id and log file. */
function claudeSession(name: string, env: Record<string, string> = {}): { id: string; log: string } {
  const log = path.join(dir, `${name}.log`);
  const vars = Object.entries({ FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_WORK_MS: "150", ...env })
    .map(([k, v]) => `${k}='${v}'`)
    .join(" ");
  const cmd = `${vars} exec '${process.execPath}' --disable-warning=ExperimentalWarning '${path.join(here, "fake-claude.ts")}'`;
  const r = tmux("new-session", "-d", "-s", name, "-x", "100", "-y", "20", "-c", dir, "-P", "-F", "#{pane_id}", cmd);
  assert.equal(r.code, 0, r.err);
  return { id: r.out.trim(), log };
}

const panes = () => new TmuxPanes({ runner, socket: sock });
const logLines = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean) : []);
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitIdle(id: string): Promise<void> {
  const end = Date.now() + 5000;
  for (;;) {
    const s = idleState(await panes().capture(id), false);
    if (s.idle) return;
    if (Date.now() > end) throw new Error(`pane ${id} never idle: ${JSON.stringify(s)}\n${await panes().capture(id)}`);
    await realSleep(30);
  }
}

before(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ma-inbox-real-")));
  sock = path.join(dir, "sock");
});

after(() => {
  if (hasTmux) tmux("kill-server");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("real tmux: list-panes sees the fake Claude as `claude`; a shell is not Claude", { skip }, async () => {
  const { id } = claudeSession("listing");
  tmux("new-session", "-d", "-s", "shell", "-x", "80", "-y", "20", "sh");
  await waitIdle(id);
  const r = await panes().list();
  assert.equal(r.kind, "ok");
  if (r.kind !== "ok") return;
  const p = r.panes.find((x) => x.id === id)!;
  assert.equal(p.command, "claude");
  assert.equal(p.target, "listing:0.0");
  assert.equal(p.path, dir);
  assert.equal(p.inMode, false);
  assert.ok(p.pid > 0);
  assert.notEqual(r.panes.find((x) => x.session === "shell")!.command, "claude");
  tmux("copy-mode", "-t", id);
  assert.equal((await panes().find(id))!.inMode, true);
  tmux("send-keys", "-t", id, "-X", "cancel");
  tmux("kill-session", "-t", "=shell");
});

test("real tmux: two calls submit; text + Enter in one call does NOT (as in Claude Code)", { skip }, async () => {
  const { id, log } = claudeSession("submit");
  await waitIdle(id);
  tmux("send-keys", "-t", id, "-l", "--", "joined");
  tmux("send-keys", "-t", id, "x", "Enter"); // the wrong way: one call
  await realSleep(200);
  assert.deepEqual(logLines(log), []);
  assert.equal(idleState(await panes().capture(id), false).idle, false, "the text sits in the input box");
  tmux("send-keys", "-t", id, "C-u");
  await waitIdle(id);

  const opts = { keys: panes(), sleep: realSleep, delayMs: 200, verifyDelayMs: 300 };
  const line = `[inbox: cloud] it's "fine" é🚀 $(nope) #{pane_id} ends with;`;
  const d = await typeAndSubmit(opts, id, line);
  assert.equal(d.result, "submitted");
  await waitFor(() => logLines(log).length === 1, "submitted line");
  assert.deepEqual(logLines(log), [line], "exactly the text, trailing ; included");
});

test("real tmux: idle detection from the real screen; typing and working are busy", { skip }, async () => {
  const { id, log } = claudeSession("idle", { FAKE_CLAUDE_WORK_MS: "600" });
  await waitIdle(id);
  tmux("send-keys", "-t", id, "-l", "--", "the user is typing");
  await realSleep(100);
  assert.deepEqual(idleState(await panes().capture(id), false), { idle: false, reason: "someone is typing in the pane (input not empty)", check: "input-not-empty" });
  tmux("send-keys", "-t", id, "Enter");
  await realSleep(100);
  assert.equal((idleState(await panes().capture(id), false) as { check: string }).check, "busy-marker");
  await waitIdle(id);
  assert.deepEqual(logLines(log), ["the user is typing"]);
});

test("real tmux: a swallowed Enter gets exactly one retry", { skip }, async () => {
  const { id, log } = claudeSession("retry", { FAKE_CLAUDE_SWALLOW: "1" });
  await waitIdle(id);
  const d = await typeAndSubmit({ keys: panes(), sleep: realSleep, delayMs: 200, verifyDelayMs: 300 }, id, "[inbox: cloud] again");
  assert.equal(d.result, "submitted: retried");
  await waitFor(() => logLines(log).length === 1, "submitted after the retry");
});

/** Real tmux for `tmux`, the scripted cloudflared for `cloudflared`. */
function mixedRunner(fake: Runner): Runner {
  return { spawn: (cmd: string, args: string[]): Proc => (cmd === "tmux" ? runner.spawn(cmd, args) : fake.spawn(cmd, args)) };
}

test("real tmux + service: POST while the user types is held, then delivered and submitted", { skip }, async (t) => {
  const { id, log } = claudeSession("service");
  await waitIdle(id);
  const h = await harness({ settings: { sendDelayMs: 200, verifyDelayMs: 300 }, service: { sleep: realSleep } });
  t.after(() => h.close());
  // swap in real tmux on the private socket
  await h.service.stop();
  const { InboxService } = await import("../src/service.ts");
  const { Store } = await import("../src/store.ts");
  const service = new InboxService({
    tool: h.tool,
    panes: panes(),
    store: new Store(h.stateDir),
    settings: { port: 0, sendDelayMs: 200, verifyDelayMs: 300, paneCommands: [] },
    runner: mixedRunner(h.runner),
    stateDir: h.stateDir,
    timers: h.timers,
    sleep: realSleep,
  });
  await service.start();
  t.after(() => service.stop());
  const created = await h.call("create", { pane: "service:0.0", label: "cloud" });
  assert.equal(created.error, undefined, JSON.stringify(created.error));
  const url = new URL(created.result.link);
  const local = `http://127.0.0.1:${service.port}${url.pathname}`;
  const post = (text: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const r = http.request(local, { method: "POST", headers: { "content-type": "application/json" } }, (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => resolve({ status: res.statusCode!, body: b }));
      });
      r.on("error", reject);
      r.end(JSON.stringify({ text }));
    });

  tmux("send-keys", "-t", id, "-l", "--", "half typed");
  await realSleep(100);
  const held = await post("from the cloud");
  assert.equal(held.status, 202, held.body);
  assert.match(held.body, /someone is typing/);
  assert.equal(logLines(log).length, 0);
  tmux("send-keys", "-t", id, "C-u");
  await realSleep(100);
  h.timers.advance(1000); // pump
  await waitFor(() => logLines(log).length === 1, "delivered from the queue", 5000);
  assert.deepEqual(logLines(log), ["[inbox: cloud] from the cloud"]);

  // the pump is done once it has checked the box cleared and the queue is empty
  await waitFor(() => (h.tool.get(`links.${created.result.id}`) as { pending: number }).pending === 0, "queue empty", 5000);
  await waitIdle(id);
  const now = await post("second, while idle");
  assert.equal(now.status, 200, now.body);
  await waitFor(() => logLines(log).length === 2, "delivered at once");
  assert.equal(logLines(log)[1], "[inbox: cloud] second, while idle");
});
