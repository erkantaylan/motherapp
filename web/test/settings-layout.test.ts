// Settings, measured in a real browser: every tool row's drag handle, Enabled switch, Restart
// button and status dot sit in the same columns whether or not the row has a Restart button
// (a disabled tool has none), at desktop and phone widths; the handle's arrow keys and a mouse
// drag both reorder. Runs the real core against a temp tools dir (demo running, a crashing
// fixture, two disabled fixtures), the web frontend built from this checkout, and a headless
// Chrome/Chromium over the DevTools protocol (no Playwright dependency). Skipped when no browser
// is installed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const MAX_OFF_PX = 0.5;

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
  for (const cache of [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(os.homedir(), ".cache", "ms-playwright")]) {
    if (!cache || !fs.existsSync(cache)) continue;
    for (const d of fs.readdirSync(cache).sort().reverse()) {
      for (const rel of ["chrome-linux64/chrome", "chrome-linux/chrome"]) {
        const f = path.join(cache, d, rel);
        if (d.startsWith("chromium-") && fs.existsSync(f)) return f;
      }
    }
  }
  return undefined;
}

const browserBin = findBrowser();

async function waitFor(cond: () => boolean, what: string, timeoutMs: number): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

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
  async eval<T>(expr: string): Promise<T> {
    const r = await this.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value as T;
  }
  /** Polls `expr` in the page until it is truthy. */
  async until(expr: string, what: string, timeoutMs = 10_000): Promise<void> {
    const end = Date.now() + timeoutMs;
    while (!(await this.eval<boolean>(`!!(${expr})`))) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  close(): void {
    this.ws.close();
  }
}

const ORDER = `[...document.querySelectorAll(".tool-order .list-row")].map((r) => r.dataset.tool)`;

// Per column: the left edge of that part in every row that shows it.
const COLUMNS = String.raw`
(() => {
  const rows = [...document.querySelectorAll(".tool-order .list-row")];
  const left = (e) => (e && e.getClientRects().length ? e.getBoundingClientRect().left : null);
  const col = (sel) => rows.map((r) => left(r.querySelector(sel))).filter((x) => x !== null);
  return {
    rows: rows.length,
    restartShown: col(".row-restart").length,
    handle: col(".drag-handle"),
    switch: col("input[role=switch]"),
    restart: col(".row-restart"),
    dot: col(".dot"),
  };
})()`;

test("Settings: tool rows keep their columns with or without Restart; keys and drag reorder", { skip: !browserBin && "no Chrome/Chromium found (set MOTHERAPP_TEST_CHROME)", timeout: 120_000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ma-settings-layout-"));
  const procs: ChildProcess[] = [];
  t.after(() => {
    for (const p of procs) if (p.exitCode === null) p.kill("SIGKILL");
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const webDir = path.join(tmp, "web");
  const vite = path.join(repo, "node_modules", "vite", "bin", "vite.js");
  const build = spawnSync(process.execPath, [vite, "build", "--outDir", webDir, "--emptyOutDir", "--logLevel", "error"], { cwd: path.join(repo, "web"), encoding: "utf8", timeout: 60_000 });
  assert.equal(build.status, 0, build.stderr);

  // Tools: demo (running), crash (keeps failing), ok and custom (disabled, so no Restart).
  // node_modules is linked in so the copied tools resolve @motherapp/tool-sdk.
  const toolsDir = path.join(tmp, "tools");
  fs.mkdirSync(toolsDir);
  fs.symlinkSync(path.join(repo, "node_modules"), path.join(tmp, "node_modules"));
  fs.cpSync(path.join(repo, "tools", "demo"), path.join(toolsDir, "demo"), { recursive: true, filter: (f) => !f.includes(`${path.sep}test`) });
  for (const id of ["crash", "ok", "custom"]) fs.cpSync(path.join(repo, "core", "test", "fixtures", "tools", id), path.join(toolsDir, id), { recursive: true });
  const cfgDir = path.join(tmp, "config", "motherapp");
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, "config.json"), JSON.stringify({ port: 0, tools: { demo: { enabled: true }, crash: { enabled: true }, ok: { enabled: false }, custom: { enabled: false } } }));
  const core = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(repo, "core/src/main.ts")], {
    env: {
      ...process.env,
      XDG_CONFIG_HOME: path.join(tmp, "config"),
      XDG_STATE_HOME: path.join(tmp, "state"),
      MOTHERAPP_TOOLS_DIR: toolsDir,
      MOTHERAPP_WEB_DIR: webDir,
      MOTHERAPP_PORT: "0",
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

  const chromeArgs = ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${path.join(tmp, "chrome")}`, "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--disable-extensions"];
  if (process.getuid?.() === 0) chromeArgs.push("--no-sandbox");
  const chrome = spawn(browserBin!, [...chromeArgs, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
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

  // ---- alignment ----
  for (const width of [1280, 390]) {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/#/settings` });
    await cdp.until(`document.querySelectorAll(".tool-order .list-row").length === 4`, `${width}px: four tool rows`);
    const c = await cdp.eval<{ rows: number; restartShown: number; handle: number[]; switch: number[]; restart: number[]; dot: number[] }>(COLUMNS);
    assert.equal(c.restartShown, 2, `${width}px: Restart on the two enabled rows only`);
    for (const k of ["handle", "switch", "restart", "dot"] as const) {
      const xs = c[k];
      assert.equal(xs.length, k === "restart" ? 2 : 4, `${width}px: ${k} found`);
      const spread = Math.max(...xs) - Math.min(...xs);
      assert.ok(spread <= MAX_OFF_PX, `${width}px: ${k} lefts differ by ${spread.toFixed(1)} px (${xs.join(", ")})`);
    }
    const scroll = await cdp.eval<number>("document.documentElement.scrollWidth - document.documentElement.clientWidth");
    assert.ok(scroll <= 0, `${width}px: no horizontal scroll (${scroll} px)`);
  }

  // ---- keyboard: ArrowUp on the second row's handle, then End ----
  const before = await cdp.eval<string[]>(ORDER);
  const id = before[1]!;
  await cdp.eval(`document.querySelector('.tool-order .list-row[data-tool="${id}"] .drag-handle').focus()`);
  const key = (k: string, code: number) =>
    cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: k, code: k, windowsVirtualKeyCode: code }).then(() => cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: k, windowsVirtualKeyCode: code }));
  await key("ArrowUp", 38);
  await cdp.until(`${ORDER}[0] === ${JSON.stringify(id)}`, "ArrowUp moved the row to the top");
  const focused = `document.activeElement === document.querySelector('.tool-order .list-row[data-tool="${id}"] .drag-handle')`;
  assert.equal(await cdp.eval<boolean>(focused), true, "focus stays on the moved row's handle");
  await cdp.until(`document.querySelector('.content [role=status]').textContent.includes("moved to position 1 of 4")`, "the move is announced");
  await key("End", 35);
  await cdp.until(`${ORDER}[3] === ${JSON.stringify(id)}`, "End moved the row to the bottom");
  assert.equal(await cdp.eval<boolean>(focused), true, "focus still on the handle after End");
  await waitFor(() => {
    const cfg = JSON.parse(fs.readFileSync(path.join(cfgDir, "config.json"), "utf8")) as { order?: string[] };
    return cfg.order?.[3] === id;
  }, "the keyboard order saved to config.json", 10_000);

  // ---- mouse drag: the top row's handle to below the last row ----
  const top = (await cdp.eval<string[]>(ORDER))[0]!;
  const pts = await cdp.eval<{ x: number; y: number; endY: number }>(`(() => {
    const rows = [...document.querySelectorAll(".tool-order .list-row")];
    const h = rows[0].querySelector(".drag-handle").getBoundingClientRect();
    const last = rows.at(-1).getBoundingClientRect();
    return { x: h.left + h.width / 2, y: h.top + h.height / 2, endY: last.bottom - 2 };
  })()`);
  const mouse = (type: string, y: number, buttons: number) => cdp.send("Input.dispatchMouseEvent", { type, x: pts.x, y, button: "left", buttons, clickCount: 1 });
  await mouse("mousePressed", pts.y, 1);
  for (let i = 1; i <= 10; i++) await mouse("mouseMoved", pts.y + ((pts.endY - pts.y) * i) / 10, 1);
  await mouse("mouseReleased", pts.endY, 0);
  await cdp.until(`${ORDER}[3] === ${JSON.stringify(top)}`, "the drag moved the top row to the bottom");
  await waitFor(() => {
    const cfg = JSON.parse(fs.readFileSync(path.join(cfgDir, "config.json"), "utf8")) as { order?: string[] };
    return cfg.order?.[3] === top;
  }, "the dragged order saved to config.json", 10_000);
});
