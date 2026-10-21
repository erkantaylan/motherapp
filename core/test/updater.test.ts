// Settings -> "Update now": the runner with systemd-run, systemctl and motherapp stubbed. The
// fake systemd-run runs the command in the background like a transient unit (its "active" file
// is what the fake systemctl reports), so the real bash wrapper and update.log are exercised.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import type { ToolInfo } from "@motherapp/protocol";
import { LogService } from "../src/logService.ts";
import type { Manager } from "../src/manager.ts";
import { ReleaseChecker } from "../src/releases.ts";
import { startServer } from "../src/server.ts";
import { parseUpdateLog, UpdateBusyError, Updater } from "../src/updater.ts";
import { Checkout, VersionSource } from "../src/version.ts";

const BASH = execFileSync("bash", ["-c", "command -v bash"], { encoding: "utf8" }).trim();

function script(file: string, body: string): void {
  fs.writeFileSync(file, `#!${BASH}\n${body}\n`);
  fs.chmodSync(file, 0o755);
}

/** A fake machine: systemd-run, systemctl and motherapp in <dir>/bin; the mode file picks what motherapp does. */
function fakeMachine(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ma-update-"));
  t.after(() => {
    fs.writeFileSync(path.join(dir, "release"), "");
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const q = JSON.stringify;
  script(
    path.join(bin, "systemd-run"),
    `printf '%s\\n' "$@" >${q(path.join(dir, "systemd-run.args"))}
[[ -f ${q(path.join(dir, "systemd_run_fails"))} ]] && { echo "Failed to connect to bus: No medium found" >&2; exit 1; }
envs=()
while [[ $1 == --* ]]; do [[ $1 == --setenv=* ]] && envs+=("\${1#--setenv=}"); shift; done
touch ${q(path.join(dir, "active"))}
( env "\${envs[@]}" "$@"; rm -f ${q(path.join(dir, "active"))} ) </dev/null >/dev/null 2>&1 &
exit 0`,
  );
  script(path.join(bin, "systemctl"), `[[ -f ${q(path.join(dir, "active"))} ]] && { echo active; exit 0; }; echo inactive; exit 3`);
  script(
    path.join(bin, "motherapp"),
    `mode="$(cat ${q(path.join(dir, "mode"))} 2>/dev/null)"
echo "==> motherapp install (/repo)"
echo "    + git fetch origin"
echo "env: MOTHERAPP_UNATTENDED=\${MOTHERAPP_UNATTENDED:-} GIT_TERMINAL_PROMPT=\${GIT_TERMINAL_PROMPT:-} args=$*"
case $mode in
  wait) for _ in $(seq 1 200); do [[ -f ${q(path.join(dir, "release"))} ]] && break; sleep 0.05; done ;;
  dirty)
    echo "motherapp: refusing: the checkout has local changes:" >&2
    echo "     M VERSION" >&2
    echo "motherapp: commit or discard them yourself, then re-run (motherapp never stashes, resets or merges)" >&2
    exit 1 ;;
  sudo)
    echo "    sudo needs a password, which can't be typed here (unattended): not running sudo modprobe i2c-dev"
    echo "FAIL     sudo                 sudo needs your password, which the browser can't ask for: run \\\`motherapp install\\\` in a terminal"
    echo "RESULT: FAIL (1 required item(s) missing or failed, 0 warning(s))"
    echo "    ./install.sh exited with 1 (see above)"
    exit 1 ;;
  current) echo "already up to date (v2-bbbbbbb, origin/main has nothing new)"; exit 0 ;;
esac
printf '\\e[1m==> motherapp updated\\e[0m\\n'
echo "    v1-aaaaaaa → v2-bbbbbbb"
echo "    commits:"
echo "      bbbbbbb Release v2"`,
  );
  const logFile = path.join(dir, "state", "update.log");
  const mk = (extra: Partial<ConstructorParameters<typeof Updater>[0]> = {}) =>
    new Updater({
      logFile,
      command: [path.join(bin, "motherapp"), "install"],
      running: "v1-aaaaaaa",
      systemdRun: path.join(bin, "systemd-run"),
      systemctl: path.join(bin, "systemctl"),
      bash: BASH,
      ...extra,
    });
  return {
    dir,
    logFile,
    mk,
    mode: (m: string) => fs.writeFileSync(path.join(dir, "mode"), m),
    release: () => fs.writeFileSync(path.join(dir, "release"), ""),
    args: () => fs.readFileSync(path.join(dir, "systemd-run.args"), "utf8").trimEnd().split("\n"),
  };
}

async function until<T>(get: () => Promise<T>, ok: (v: T) => boolean, what: string): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const v = await get();
    if (ok(v)) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

test("no update has run: idle", async (t) => {
  const m = fakeMachine(t);
  assert.deepEqual(await m.mk().status(), { state: "idle", log: "" });
});

test("start: runs motherapp install as the motherapp-update unit, refuses a second one, then reports done", async (t) => {
  const m = fakeMachine(t);
  m.mode("wait");
  const u = m.mk({ env: { PATH: "/opt/node24/bin:/usr/bin:/bin" } });
  const first = await u.start();
  assert.equal(first.state, "running");
  assert.match(first.log, /^== motherapp update started \S+ \(Settings -> Update now; running v1-aaaaaaa\) ==$/m);
  assert.ok(first.startedAt);

  const args = m.args();
  assert.deepEqual(args.slice(0, 4), ["--user", "--unit=motherapp-update", "--collect", "--quiet"]);
  assert.ok(args.includes("--setenv=MOTHERAPP_UNATTENDED=1"), "install.sh must not wait for a sudo password");
  assert.ok(args.includes("--setenv=GIT_TERMINAL_PROMPT=0"));
  assert.ok(args.includes("--setenv=PATH=/opt/node24/bin:/usr/bin:/bin"));
  assert.equal(args[args.indexOf(BASH) + 1], "-c", "runs the bash wrapper");
  assert.deepEqual(args.slice(-4), ["motherapp-update", m.logFile, path.join(m.dir, "bin", "motherapp"), "install"]);

  await assert.rejects(u.start(), (e: Error) => e instanceof UpdateBusyError && /already running/.test(e.message));
  await assert.rejects(m.mk().start(), UpdateBusyError, "another Updater (a restarted core) sees the unit too");

  const mid = await until(() => u.status(), (s) => s.log.includes("env: "), "output in the log");
  assert.equal(mid.state, "running");
  assert.match(mid.log, /env: MOTHERAPP_UNATTENDED=1 GIT_TERMINAL_PROMPT=0 args=install/);

  m.release();
  const done = await until(() => u.status(), (s) => s.state !== "running", "the end");
  assert.equal(done.state, "done");
  assert.equal(done.exitCode, 0);
  assert.equal(done.summary, "v1-aaaaaaa → v2-bbbbbbb");
  assert.ok(done.finishedAt);
  assert.doesNotMatch(done.log, /\x1b\[/, "colour codes stripped");
  assert.match(done.log, /^== motherapp update finished \S+: exit 0 ==$/m);
  assert.equal(done.message, undefined);

  // After the restart the update causes, a new core reads the same answer from the log.
  assert.deepEqual(await m.mk().status(), done);
});

test("refusals and failures: the reason the page shows", async (t) => {
  const m = fakeMachine(t);
  const cases: [string, RegExp][] = [
    ["dirty", /^refusing: the checkout has local changes: commit or discard them yourself, then re-run \(motherapp never stashes, resets or merges\)$/],
    ["sudo", /^sudo needs your password, which the browser can't ask for: run `motherapp install` in a terminal$/],
  ];
  for (const [mode, reason] of cases) {
    m.mode(mode);
    const u = m.mk();
    await u.start();
    const s = await until(() => u.status(), (x) => x.state !== "running", mode);
    assert.equal(s.state, "failed", mode);
    assert.equal(s.exitCode, 1, mode);
    assert.match(s.message!, reason, mode);
    assert.equal(s.summary, undefined, mode);
  }
  m.mode("current");
  const u = m.mk();
  await u.start();
  const s = await until(() => u.status(), (x) => x.state !== "running", "current");
  assert.equal(s.state, "done");
  assert.equal(s.summary, "already up to date (v2-bbbbbbb, origin/main has nothing new)");
  assert.doesNotMatch(s.log, /refusing/, "each update starts a fresh log");
});

test("systemd-run itself fails: failed, with its message", async (t) => {
  const m = fakeMachine(t);
  fs.writeFileSync(path.join(m.dir, "systemd_run_fails"), "");
  const s = await m.mk().start();
  assert.equal(s.state, "failed");
  assert.equal(s.message, "couldn't start the update: systemd-run: Failed to connect to bus: No medium found");
  const missing = await m.mk({ systemdRun: path.join(m.dir, "bin", "nope") }).start();
  assert.equal(missing.state, "failed");
  assert.match(missing.message!, /^couldn't start the update: systemd-run: .*ENOENT/);
});

test("parseUpdateLog: tail, a run that died, colour codes", () => {
  const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
  const text = `== motherapp update started 2026-10-21T10:00:00.000Z (x) ==\n${lines.join("\n")}\n`;
  const running = parseUpdateLog(text, true, 5);
  assert.equal(running.state, "running");
  assert.equal(running.log, "line 45\nline 46\nline 47\nline 48\nline 49");
  assert.equal(running.startedAt, "2026-10-21T10:00:00.000Z");
  const died = parseUpdateLog(text, false);
  assert.equal(died.state, "failed");
  assert.equal(died.message, "the update stopped without finishing (see the log)");
  const coloured = parseUpdateLog("\x1b[31mmotherapp: refusing: the checkout is on branch 'x', not main\x1b[0m\n== motherapp update finished 2026-10-21T10:01:00Z: exit 1 ==\n", false);
  assert.equal(coloured.message, "refusing: the checkout is on branch 'x', not main");
  assert.equal(coloured.finishedAt, "2026-10-21T10:01:00Z");
  const installFail = parseUpdateLog("FAIL     http                 didn't respond\nFAIL     http                 didn't respond\n== motherapp update finished t: exit 1 ==\n", false);
  assert.equal(installFail.message, "./install.sh failed: FAIL http didn't respond");
  assert.equal(parseUpdateLog("x\n== motherapp update finished t: exit 3 ==\n", false).message, "motherapp install exited with 3 (see the log)");
});

/** A Manager stand-in with just what the server touches. */
function fakeManager(tools: ToolInfo[]): Manager {
  const m = new EventEmitter() as unknown as Manager & { list: () => ToolInfo[] };
  Object.assign(m, { hosts: new Map(), list: () => tools, networkConfig: () => ({ lan: { enabled: false, trusted: [] }, localhostSubdomains: true }) });
  return m;
}

test("server: update.start / update.status over the socket; version.get carries the release and a check is broadcast", async (t) => {
  const m = fakeMachine(t);
  m.mode("wait");
  const gh = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ tag_name: "v2", html_url: "https://github.com/erkantaylan/motherapp/releases/tag/v2" }));
  });
  await new Promise<void>((r) => gh.listen(0, "127.0.0.1", r));
  t.after(() => gh.close());
  const release = new ReleaseChecker({ current: "1", enabled: true, url: `http://127.0.0.1:${(gh.address() as AddressInfo).port}/latest` });
  fs.writeFileSync(path.join(m.dir, "VERSION"), "1\n");
  const build = { version: "1", hash: "aaaaaaa", dirty: false, builtAt: null, string: "v1-aaaaaaa" };
  const version = new VersionSource(build, new Checkout({ repo: m.dir, git: async () => "a".repeat(40) + "\n" }), release);
  const server = await startServer({ manager: fakeManager([]), log: new LogService({ stdout: null }), webDir: m.dir, port: 0, version, updater: m.mk() });
  t.after(() => server.close());

  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  await new Promise((r, j) => (ws.once("open", r), ws.once("error", j)));
  t.after(() => ws.close());
  const msgs: any[] = [];
  ws.on("message", (d) => msgs.push(JSON.parse(d.toString())));
  let id = 0;
  const call = async (method: string, params: object = {}) => {
    const my = ++id;
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: my, method, params }));
    const deadline = Date.now() + 5000;
    for (;;) {
      const r = msgs.find((x) => x.id === my);
      if (r) return r;
      if (Date.now() > deadline) throw new Error(`no reply to ${method}`);
      await new Promise((res) => setTimeout(res, 10));
    }
  };

  const before = await call("version.get");
  assert.deepEqual(before.result.release, { latest: null, latestUrl: null, newer: false, checkedAt: null });
  const checked = await call("version.get", { checkRelease: true });
  assert.equal(checked.result.release.latest, "v2");
  assert.equal(checked.result.release.newer, true);
  assert.equal(checked.result.release.latestUrl, "https://github.com/erkantaylan/motherapp/releases/tag/v2");
  const deadline = Date.now() + 2000;
  while (!msgs.some((x) => x.method === "version") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  assert.equal(msgs.find((x) => x.method === "version")?.params.release.latest, "v2", "a finished check is broadcast");
  const api = (await (await fetch(`http://127.0.0.1:${server.port}/api/status`)).json()) as any;
  assert.equal(api.version.release.latest, "v2", "/api/status has it too");

  assert.equal((await call("update.status")).result.state, "idle");
  const started = await call("update.start");
  assert.equal(started.result.state, "running");
  const again = await call("update.start");
  assert.match(again.error.message, /already running/);
  m.release();
  const done = await until(async () => (await call("update.status")).result, (s: any) => s.state !== "running", "done over the socket");
  assert.equal(done.state, "done");
  assert.equal(done.summary, "v1-aaaaaaa → v2-bbbbbbb");
});
