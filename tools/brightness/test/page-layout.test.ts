// Issue #12, measured in a real browser: while a slider's write is in flight (and after it is
// confirmed), no slider, control row or list row on the Brightness page may move. Runs the real
// core and brightness tool against the fake ddcutil (500 ms per call, never real monitors), the
// web frontend built from this checkout, and a headless Chrome/Chromium driven over the DevTools
// protocol (no Playwright dependency). Skipped when no browser is installed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { MACHINE_MONITORS, fakeDdcutil, waitFor } from "./fakes.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..", "..");
const MAX_MOVE_PX = 0.5;

function findBrowser(): string | undefined {
  const fromEnv = process.env.MOTHERAPP_TEST_CHROME;
  if (fromEnv) return fs.existsSync(fromEnv) ? fromEnv : undefined;
  for (const name of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]) {
    for (const dir of (process.env.PATH ?? "").split(":").filter(Boolean)) {
      const f = path.join(dir, name);
      if (fs.existsSync(f)) return f;
    }
  }
  // Playwright's downloaded browsers, if any.
  const cache = path.join(os.homedir(), ".cache", "ms-playwright");
  if (fs.existsSync(cache)) {
    for (const d of fs.readdirSync(cache).sort().reverse()) {
      for (const rel of ["chrome-linux64/chrome", "chrome-linux/chrome", "chrome-linux64/chrome-headless-shell", "chrome-linux/headless_shell"]) {
        const f = path.join(cache, d, rel);
        if (d.startsWith("chromium") && fs.existsSync(f)) return f;
      }
    }
  }
  return undefined;
}

const browserBin = findBrowser();

/** Minimal DevTools protocol client for one page. */
class Cdp {
  private ws: WebSocket;
  private id = 0;
  private waiting = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on("message", (d) => {
      const m = JSON.parse(d.toString()) as { id?: number; result?: unknown; error?: { message: string } };
      const w = m.id !== undefined ? this.waiting.get(m.id) : undefined;
      if (!w) return;
      this.waiting.delete(m.id!);
      if (m.error) w.rej(new Error(m.error.message));
      else w.res(m.result);
    });
  }
  open(): Promise<void> {
    return new Promise((res, rej) => {
      this.ws.once("open", () => res());
      this.ws.once("error", rej);
    });
  }
  send(method: string, params: object = {}): Promise<any> {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.waiting.set(id, { res, rej }));
  }
  /** Evaluates `expr` (may return a promise) in the page and returns its JSON value. */
  async eval<T>(expr: string): Promise<T> {
    const r = await this.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value as T;
  }
  close(): void {
    this.ws.close();
  }
}

// In the page: change one slider like a user would (an `input` event; the page sends the action),
// then sample the boxes of every slider input, control row and list row every frame while the
// write is in flight and until the confirming read is done. Returns the largest movement.
const MEASURE = String.raw`
async (which, sampleMs) => {
  const tracked = [...document.querySelectorAll(".content input[type=range], .content .control, .content .list-row")];
  const name = (e) => {
    const row = e.closest(".list-row");
    return (row ? "row " + row.querySelector(".row-title").textContent + ": " : "") + e.tagName.toLowerCase() + "." + [...e.classList].join(".");
  };
  const box = (e) => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; };
  const base = tracked.map(box);
  let max = 0, worst = "", framesInFlight = 0, frames = 0;
  const check = () => {
    frames++;
    if (document.querySelector('.dot[data-status="setting"]')) framesInFlight++;
    tracked.forEach((e, i) => {
      const d = Math.max(...box(e).map((v, k) => Math.abs(v - base[i][k])));
      if (d > max) { max = d; worst = name(e); }
    });
  };
  const sliders = [...document.querySelectorAll(".content .w-slider input[type=range]")];
  const input = which === "all" ? sliders.find((i) => !i.closest(".list-row")) : sliders.find((i) => i.closest(".list-row"));
  const v = Number(input.value);
  input.value = String(v >= 90 ? v - 9 : v + 9);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  check();
  const end = performance.now() + sampleMs;
  while (performance.now() < end) {
    await new Promise((r) => setTimeout(r, 16));
    check();
  }
  return { max, worst, frames, framesInFlight, tracked: tracked.length, stillSetting: !!document.querySelector('.dot[data-status="setting"]') };
}`;

const READY = String.raw`
(async () => {
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    const rows = document.querySelectorAll(".content .list-row input[type=range]").length;
    if (rows === 2 && !document.querySelector(".content .stale") && !document.querySelector('.dot[data-status="setting"]')) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
})()`;

test("Brightness page: nothing moves while a slider write is in flight or after it is confirmed (issue #12)", { skip: !browserBin && "no Chrome/Chromium found (set MOTHERAPP_TEST_CHROME)", timeout: 120_000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ma-bright-layout-"));
  const procs: ChildProcess[] = [];
  t.after(() => {
    for (const p of procs) if (p.exitCode === null) p.kill("SIGKILL");
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // The frontend as it is in this checkout.
  const webDir = path.join(tmp, "web");
  const vite = path.join(repo, "node_modules", "vite", "bin", "vite.js");
  const build = spawnSync(process.execPath, [vite, "build", "--outDir", webDir, "--emptyOutDir", "--logLevel", "error"], { cwd: path.join(repo, "web"), encoding: "utf8", timeout: 60_000 });
  assert.equal(build.status, 0, build.stderr);

  // Core + brightness only, with the fake ddcutil (500 ms per call, like the real monitors).
  const ddc = fakeDdcutil(tmp, MACHINE_MONITORS);
  const cfgDir = path.join(tmp, "config", "motherapp");
  fs.mkdirSync(cfgDir, { recursive: true });
  const tools: Record<string, { enabled: boolean }> = {};
  for (const id of fs.readdirSync(path.join(repo, "tools"))) {
    if (fs.existsSync(path.join(repo, "tools", id, "manifest.json"))) tools[id] = { enabled: id === "brightness" };
  }
  fs.writeFileSync(path.join(cfgDir, "config.json"), JSON.stringify({ port: 0, tools }));
  const core = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(repo, "core/src/main.ts")], {
    env: {
      ...process.env,
      PATH: `${ddc.bin}:${process.env.PATH}`,
      XDG_CONFIG_HOME: path.join(tmp, "config"),
      XDG_STATE_HOME: path.join(tmp, "state"),
      MOTHERAPP_TOOLS_DIR: path.join(repo, "tools"),
      MOTHERAPP_WEB_DIR: webDir,
      MOTHERAPP_PORT: "0",
      BRIGHTCTL_BACKEND: "cli",
      BRIGHTCTL_DDCUTIL: ddc.command,
      FAKE_DDC_DELAY_MS: "500",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  procs.push(core);
  let port: number | undefined;
  let buf = "";
  core.stdout!.setEncoding("utf8");
  core.stdout!.on("data", (c: string) => {
    buf += c;
    const parts = buf.split("\n");
    buf = parts.pop()!;
    for (const p of parts) {
      try {
        port ??= (JSON.parse(p) as { fields?: { port?: number } }).fields?.port;
      } catch {
        // not a log line
      }
    }
  });
  core.stderr!.resume();
  await waitFor(() => port !== undefined, "core listening", 15_000);

  // Headless browser with the DevTools protocol on a free port.
  const chrome = spawn(
    browserBin!,
    ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${path.join(tmp, "chrome")}`, "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--disable-extensions", "about:blank"],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  procs.push(chrome);
  let devtools: string | undefined;
  let chromeErr = "";
  chrome.stderr!.setEncoding("utf8");
  chrome.stderr!.on("data", (c: string) => {
    chromeErr += c;
    devtools ??= chromeErr.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1];
  });
  await waitFor(() => devtools !== undefined, "browser DevTools endpoint", 20_000).catch((e: Error) => {
    throw new Error(`${e.message}\n${chromeErr}`);
  });
  const http = new URL(devtools!).host;
  let pageWs: string | undefined;
  for (let i = 0; i < 100 && !pageWs; i++) {
    const targets = (await (await fetch(`http://${http}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
    pageWs = targets.find((x) => x.type === "page")?.webSocketDebuggerUrl;
    if (!pageWs) await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(pageWs, "a page target");
  const cdp = new Cdp(pageWs);
  await cdp.open();
  t.after(() => cdp.close());

  for (const width of [1000, 620]) {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/#/tool/brightness` });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await cdp.eval<boolean>(READY), true, `${width}px: page ready with two monitor rows`);
    for (const which of ["monitor", "all"]) {
      // 3 s: the write (0.5 s), the confirming read 1.5 s later (0.5 s), and some margin.
      const r = await cdp.eval<{ max: number; worst: string; frames: number; framesInFlight: number; tracked: number; stillSetting: boolean }>(`(${MEASURE})(${JSON.stringify(which)}, 3000)`);
      const what = `${width}px, ${which === "all" ? "All monitors" : "a monitor's"} slider`;
      assert.ok(r.tracked >= 6, `${what}: found the sliders and rows (${r.tracked})`);
      assert.ok(r.framesInFlight >= 5, `${what}: measured while the write was in flight (${r.framesInFlight} of ${r.frames} frames)`);
      assert.equal(r.stillSetting, false, `${what}: the write finished within the sampling time`);
      assert.ok(r.max <= MAX_MOVE_PX, `${what}: ${r.worst} moved ${r.max.toFixed(1)} px`);
    }
  }
});
