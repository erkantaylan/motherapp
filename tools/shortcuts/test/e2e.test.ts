// End to end: the real core starts the shortcuts tool, which runs fake `gsettings`/`dconf`
// put first on PATH. Talks to the core over WebSocket like the browser does, and fetches the
// custom page's modules the way the browser would.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import type { Store } from "./fake-gnome-core.ts";
import { DIR, LIST, MACHINE_PATHS, machineSnapshot, machineStore, waitFor } from "./fakes.ts";

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
    await waitFor(() => this.msgs.some((m) => m.id === id), `reply to ${method}`, 15_000);
    return this.msgs.find((m) => m.id === id)!;
  }
  changes(): { path: string; value: any }[] {
    return this.msgs.filter((m) => m.method === "state" && m.params.tool === "shortcuts").flatMap((m) => m.params.changes);
  }
  notes(method: string) {
    return this.msgs.filter((m) => m.method === method).map((m) => m.params);
  }
}

test("core + shortcuts tool with fake gsettings/dconf: list, add, conflict, remove, page modules", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ma-shortcuts-e2e-"));
  const bin = path.join(tmp, "bin");
  const fake = path.join(tmp, "gnome");
  const home = path.join(tmp, "home");
  fs.mkdirSync(bin);
  fs.mkdirSync(fake);
  fs.mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
  fs.writeFileSync(path.join(home, ".local", "bin", "audioctl"), "#!/bin/sh\n", { mode: 0o755 });
  const storeFile = path.join(fake, "store.json");
  fs.writeFileSync(storeFile, JSON.stringify(machineStore()));
  const store = () => JSON.parse(fs.readFileSync(storeFile, "utf8")) as Store;
  const before = machineSnapshot(store());
  for (const name of ["gsettings", "dconf"]) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nexec "${process.execPath}" --disable-warning=ExperimentalWarning "${path.join(here, "fake-gnome.ts")}" ${name} "$@"\n`, { mode: 0o755 });
  }
  const cfgDir = path.join(tmp, "config", "motherapp");
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, "config.json"), JSON.stringify({ port: 0, tools: { audio: { enabled: false }, brightness: { enabled: false }, tmux: { enabled: false } } }));
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_GNOME_DIR: fake,
    XDG_CONFIG_HOME: path.join(tmp, "config"),
    XDG_STATE_HOME: path.join(tmp, "state"),
    MOTHERAPP_TOOLS_DIR: path.join(repo, "tools"),
    MOTHERAPP_WEB_DIR: path.join(tmp, "noweb"),
  };
  const core = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(repo, "core/src/main.ts")], { env, stdio: ["ignore", "pipe", "pipe"] });
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
  await waitFor(() => c.notes("tools").some((p) => p.tools.find((x: any) => x.id === "shortcuts")?.status === "running"), "shortcuts running", 15_000);
  const info = c.notes("tools").at(-1).tools.find((x: any) => x.id === "shortcuts");
  assert.equal(info.page, "custom");
  assert.equal(info.title, "Shortcuts");

  // the 8 rows arrive (snapshot or delta)
  const rows = () => {
    const snap = c.notes("snapshot").filter((s) => s.tool === "shortcuts").at(-1)?.state?.shortcuts ?? {};
    const out: Record<string, any> = JSON.parse(JSON.stringify(snap));
    for (const ch of c.changes()) {
      const parts = ch.path.split(".");
      if (parts[0] !== "shortcuts") continue;
      if (parts.length === 1) {
        for (const k of Object.keys(out)) delete out[k];
        Object.assign(out, ch.value);
      } else if (parts.length === 2) {
        if (ch.value === null) delete out[parts[1]!];
        else out[parts[1]!] = ch.value;
      } else if (out[parts[1]!]) out[parts[1]!][parts[2]!] = ch.value;
    }
    return out;
  };
  await waitFor(() => Object.keys(rows()).length === 8, "8 rows", 10_000);
  assert.equal(rows()["dc-map-toggle"].binding, "<Control>F9");

  // add from the audio suggestion, on Ctrl+F9: works, with a conflict warning
  await waitFor(
    () => c.changes().some((x) => x.path === "suggestions" && x.value["audio-1"]) || c.notes("snapshot").some((s) => s.tool === "shortcuts" && s.state.suggestions?.["audio-1"]),
    "suggestions",
    10_000,
  );
  const add = await c.call("action", { tool: "shortcuts", name: "add", args: { name: "Mute Firefox", binding: "<Control>F9", command: `${home}/.local/bin/audioctl app-mute firefox toggle` } });
  assert.equal(add.error, undefined, JSON.stringify(add.error));
  assert.deepEqual(add.result.warnings, ["Ctrl+F9 is also used by custom shortcut 'dc-map-toggle'."]);
  await waitFor(() => rows()["motherapp-mute-firefox"]?.owned === true, "new row", 10_000);
  const s1 = store();
  assert.deepEqual(s1.values[LIST], [...MACHINE_PATHS, `${DIR}motherapp-mute-firefox/`]);
  assert.equal(s1.values[`${DIR}motherapp-mute-firefox/command`], `${home}/.local/bin/audioctl app-mute firefox toggle`);
  assert.deepEqual(machineSnapshot(s1), before);

  // a foreign entry can't be removed
  const foreign = await c.call("action", { tool: "shortcuts", name: "remove", args: { id: "custom0" } });
  assert.match(foreign.error?.message ?? "", /read-only here/);

  // remove ours: gone from the array and from dconf, the 8 untouched
  const rm = await c.call("action", { tool: "shortcuts", name: "remove", args: { id: "motherapp-mute-firefox" } });
  assert.equal(rm.error, undefined);
  await waitFor(() => rows()["motherapp-mute-firefox"] === undefined, "row removed", 10_000);
  const s2 = store();
  assert.deepEqual(s2.values[LIST], MACHINE_PATHS);
  assert.ok(!Object.keys(s2.values).some((k) => k.includes("motherapp-")));
  assert.deepEqual(machineSnapshot(s2), before);

  // every gsettings call ran with a UTF-8 locale
  const calls = fs.readFileSync(path.join(fake, "calls.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(calls.length > 10);
  assert.ok(calls.every((x) => x.lcAll === "C.UTF-8"));

  // the custom page and its imports are served as JavaScript the browser can parse
  for (const file of ["page.ts", "src/accel.ts", "src/command.ts", "src/conflicts.ts"]) {
    const res = await fetch(`http://127.0.0.1:${port}/tools/shortcuts/${file}`);
    assert.equal(res.status, 200, file);
    assert.match(res.headers.get("content-type") ?? "", /javascript/);
    const js = await res.text();
    assert.ok(!/^\s*import type /m.test(js), `${file}: types stripped`);
    const out = path.join(tmp, `check-${path.basename(file, ".ts")}.mjs`);
    fs.writeFileSync(out, js);
    const chk = spawnSync(process.execPath, ["--check", out], { encoding: "utf8" });
    assert.equal(chk.status, 0, `${file} parses: ${chk.stderr}`);
  }
  assert.equal(info.pageUrl, "/tools/shortcuts/page.ts");
  assert.ok(lines.some((l) => l.tool === "shortcuts" && l.src === "tool" && l.msg === "shortcuts tool serving"));
  c.ws.close();
});
