// End to end: the real core starts the tmux tool, which runs a fake `tmux` put first on PATH.
// Talks to the core over WebSocket like the browser does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { session, waitFor } from "./fakes.ts";

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
    await waitFor(() => this.msgs.some((m) => m.id === id), `reply to ${method}`, 10_000);
    return this.msgs.find((m) => m.id === id)!;
  }
  /** The tmux tool's state as the browser would hold it: the snapshot plus every delta. */
  changes(): { path: string; value: any }[] {
    return this.msgs.filter((m) => m.method === "state" && m.params.tool === "tmux").flatMap((m) => m.params.changes);
  }
  notes(method: string) {
    return this.msgs.filter((m) => m.method === method).map((m) => m.params);
  }
}

test("core + tmux tool with a fake tmux: live list, rename in place, kill", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ma-tmux-e2e-"));
  const bin = path.join(tmp, "bin");
  const fake = path.join(tmp, "tmux");
  fs.mkdirSync(bin);
  fs.mkdirSync(fake);
  const now = Math.floor(Date.now() / 1000);
  const server = (s: unknown) => fs.writeFileSync(path.join(fake, "server.json"), JSON.stringify(s));
  server([session(0, "work", { created: now, activity: now }), session(1, "foo2", { created: now, activity: now })]);
  fs.writeFileSync(
    path.join(bin, "tmux"),
    `#!/bin/sh\nexec "${process.execPath}" --disable-warning=ExperimentalWarning "${path.join(here, "fake-tmux.ts")}" "$@"\n`,
    { mode: 0o755 },
  );
  const cfgDir = path.join(tmp, "config", "motherapp");
  fs.mkdirSync(cfgDir, { recursive: true });
  // only the tmux tool, so the test doesn't depend on the others (the inbox tool also runs
  // `tmux list-panes`, which landed in this fake's call log now and then)
  const others = fs.readdirSync(path.join(repo, "tools")).filter((d) => d !== "tmux" && fs.existsSync(path.join(repo, "tools", d, "manifest.json")));
  fs.writeFileSync(path.join(cfgDir, "config.json"), JSON.stringify({ port: 0, tools: Object.fromEntries(others.map((id) => [id, { enabled: false }])) }));
  const calls = () =>
    fs.existsSync(path.join(fake, "calls.log"))
      ? fs.readFileSync(path.join(fake, "calls.log"), "utf8").trim().split("\n").map((l) => (JSON.parse(l) as string[]).join(" "))
      : [];

  const core = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(repo, "core/src/main.ts")], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_TMUX_DIR: fake,
      XDG_CONFIG_HOME: path.join(tmp, "config"),
      XDG_STATE_HOME: path.join(tmp, "state"),
      MOTHERAPP_TOOLS_DIR: path.join(repo, "tools"),
      MOTHERAPP_WEB_DIR: path.join(tmp, "noweb"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => {
    core.kill("SIGKILL");
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const lines: Record<string, any>[] = [];
  let buf = "";
  core.stdout.setEncoding("utf8");
  core.stdout.on("data", (c: string) => {
    buf += c;
    const parts = buf.split("\n");
    buf = parts.pop()!;
    for (const p of parts) if (p) lines.push(JSON.parse(p));
  });
  await waitFor(() => lines.some((l) => l.fields?.port), "core listening", 10_000);
  const port = lines.find((l) => l.fields?.port)!.fields.port as number;

  const c = new Client(`ws://127.0.0.1:${port}/ws`);
  await c.open();
  await waitFor(() => c.notes("tools").some((p) => p.tools.find((x: any) => x.id === "tmux")?.status === "running"), "tmux running", 15_000);
  const info = c.notes("tools").at(-1).tools.find((x: any) => x.id === "tmux");
  assert.equal(info.page, "declarative");
  assert.equal(info.title, "tmux");
  // Nobody has the page open yet: no tmux call at all, over more than one 2 s poll interval.
  await new Promise((r) => setTimeout(r, 2500));
  assert.deepEqual(calls(), [], "no polling while unwatched");
  // The tab shows the tmux page: an immediate list, then every 2 s.
  assert.equal((await c.call("tool.watch", { tool: "tmux" })).error, undefined);
  // the first poll lands in the snapshot or as a delta
  const hasRow = (key: string, name: string) =>
    c.notes("snapshot").some((s) => s.tool === "tmux" && s.state.sessions?.[key]?.name === name) ||
    c.changes().some((x) => (x.path === "sessions" && x.value?.[key]?.name === name) || (x.path === `sessions.${key}` && x.value?.name === name));
  await waitFor(() => hasRow("0", "work") && hasRow("1", "foo2"), "first list", 10_000);
  assert.ok(calls().every((l) => l.startsWith("-u list-sessions -F ")));

  // a new session, a rename and an attach show up on the next 2 s poll, as small deltas
  server([
    session(0, "renamed work", { created: now, activity: now, attached: 1 }),
    session(1, "foo2", { created: now, activity: now }),
    session(2, "foo", { created: now, activity: now }),
  ]);
  await waitFor(() => c.changes().some((x) => x.path === "sessions.0.name" && x.value === "renamed work"), "rename delta", 6000);
  await waitFor(() => c.changes().some((x) => x.path === "sessions.2"), "new session delta", 6000);
  assert.ok(c.changes().some((x) => x.path === "sessions.0.attachedNote" && x.value === " It is attached (1 client)."));
  assert.ok(!c.changes().some((x) => x.path === "sessions.0" && x.value === null), "a rename never removes the row");

  // kill by id: only foo, not foo2; the row goes away with the reply
  const r = await c.call("action", { tool: "tmux", name: "kill", args: { id: "2" } });
  assert.equal(r.error, undefined);
  assert.ok(calls().includes("-u kill-session -t $2"));
  await waitFor(() => c.changes().some((x) => x.path === "sessions.2" && x.value === null), "kill delta", 3000);
  const bad = await c.call("action", { tool: "tmux", name: "kill", args: { id: "2" } });
  assert.equal(bad.error?.message, "That session doesn't exist anymore.");

  // the server goes away: empty list and a status line
  server("none");
  await waitFor(() => c.changes().some((x) => x.path === "status" && x.value === "No tmux server running on /tmp/tmux-fake/default."), "no-server status", 6000);
  assert.ok(lines.some((l) => l.tool === "tmux" && l.src === "tool" && l.msg === "tmux tool serving"));
  c.ws.close();
});
