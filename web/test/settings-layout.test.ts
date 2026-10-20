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

/** Two animation frames: layout and paint have caught up with the last change. */
const settle = (cdp: Cdp) => cdp.eval(`new Promise((r) => { requestAnimationFrame(() => requestAnimationFrame(r)); setTimeout(r, 500); })`);

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
  t.after(async () => {
    // Wait for the processes to be gone: a dying Chrome still writes to its profile in `tmp`,
    // and removing the dir under it fails with ENOTEMPTY.
    await Promise.all(
      procs.map((p) =>
        p.exitCode !== null || p.signalCode !== null
          ? undefined
          : new Promise<void>((res) => {
              const done = setTimeout(res, 5000);
              p.once("exit", () => (clearTimeout(done), res()));
              p.kill("SIGKILL");
            }),
      ),
    );
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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

  // The order is on disk, and the page has the core's answer (the order dot left "setting"; the
  // `tools` broadcast comes before it), so the next step starts from a settled page.
  const savedAt = async (i: number, want: string, what: string) => {
    await waitFor(() => {
      const cfg = JSON.parse(fs.readFileSync(path.join(cfgDir, "config.json"), "utf8")) as { order?: string[] };
      return cfg.order?.[i] === want;
    }, what, 10_000);
    await cdp.until(`document.querySelector(".order-bar .dot").dataset.status !== "setting" && ${ORDER}[${i}] === ${JSON.stringify(want)}`, `${what}: the page has the answer`);
  };

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
  await savedAt(3, id, "the keyboard order saved to config.json");

  // ---- drag, without input timing: pointer events dispatched to the handle in the page ----
  // The same handlers as a real drag (pointerdown on the handle; moves and up on the window),
  // with no browser input pipeline in between. A script-made pointer can't be captured, which
  // startDrag allows for.
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await settle(cdp);
  const scripted = (await cdp.eval<string[]>(ORDER))[0]!;
  const scriptedResult = await cdp.eval<{ order: string[]; dragging: boolean }>(`(() => {
    const rows = [...document.querySelectorAll(".tool-order .list-row")];
    const handle = rows[0].querySelector(".drag-handle");
    const h = handle.getBoundingClientRect();
    const x = h.left + h.width / 2, y0 = h.top + h.height / 2, y1 = rows.at(-1).getBoundingClientRect().bottom - 2;
    const ev = (type, y, buttons) => new PointerEvent(type, { pointerId: 7, pointerType: "mouse", isPrimary: true, button: 0, buttons, clientX: x, clientY: y, bubbles: true, cancelable: true, composed: true });
    const list = document.querySelector(".tool-order");
    handle.dispatchEvent(ev("pointerdown", y0, 1));
    for (let y = y0; y < y1; y += 4) list.dispatchEvent(ev("pointermove", y, 1));
    list.dispatchEvent(ev("pointermove", y1, 1));
    list.dispatchEvent(ev("pointerup", y1, 0));
    return { order: ${ORDER}, dragging: list.classList.contains("is-dragging") };
  })()`);
  assert.equal(scriptedResult.order[3], scripted, `scripted drag moved the top row to the bottom (${scriptedResult.order.join(", ")})`);
  assert.equal(scriptedResult.dragging, false, "scripted drag ended on pointerup");
  await savedAt(3, scripted, "the scripted drag's order saved to config.json");

  // Escape during a drag puts the rows back.
  const beforeEsc = await cdp.eval<string[]>(ORDER);
  const escResult = await cdp.eval<{ mid: string[]; after: string[] }>(`(() => {
    const rows = [...document.querySelectorAll(".tool-order .list-row")];
    const handle = rows[0].querySelector(".drag-handle");
    const h = handle.getBoundingClientRect();
    const ev = (type, y) => new PointerEvent(type, { pointerId: 8, pointerType: "mouse", isPrimary: true, button: 0, buttons: 1, clientX: h.left + 4, clientY: y, bubbles: true, cancelable: true });
    handle.dispatchEvent(ev("pointerdown", h.top + 2));
    window.dispatchEvent(ev("pointermove", rows.at(-1).getBoundingClientRect().bottom - 2));
    const mid = ${ORDER};
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    return { mid, after: ${ORDER} };
  })()`);
  assert.notDeepEqual(escResult.mid, beforeEsc, "the scripted move showed while dragging");
  assert.deepEqual(escResult.after, beforeEsc, "Escape cancels the drag");

  // ---- real mouse drag through Chrome's input pipeline: the top row's handle to the bottom ----
  // Robust to another Chrome, fonts and timing (issue #25: on the machine the page was taller,
  // so the handle's focus() had scrolled it and the press landed above the top row). Here: a
  // pinned 1280x900 viewport at scale 1, the list scrolled into view and checked to fit, the
  // press point checked to hit the handle, small steps, and each step waits until the page has
  // seen that move. Retried once, with a note in the test output, if the browser loses it anyway.
  const realDrag = async (): Promise<void> => {
    await cdp.eval(`(() => {
      document.querySelector(".tool-order").scrollIntoView({ block: "center" });
      window.__seen = { down: 0, up: 0, y: null };
      if (!window.__probe) {
        window.__probe = true;
        addEventListener("pointerdown", () => window.__seen.down++, true);
        addEventListener("pointerup", () => window.__seen.up++, true);
        addEventListener("pointermove", (e) => (window.__seen.y = e.clientY), true);
      }
    })()`);
    await settle(cdp);
    const top = (await cdp.eval<string[]>(ORDER))[0]!;
    const p = await cdp.eval<{ x: number; y: number; endY: number; listTop: number; listBottom: number; vh: number; hit: boolean }>(`(() => {
      const rows = [...document.querySelectorAll(".tool-order .list-row")];
      const handle = rows[0].querySelector(".drag-handle");
      const h = handle.getBoundingClientRect();
      const list = document.querySelector(".tool-order").getBoundingClientRect();
      const x = Math.round(h.left + h.width / 2), y = Math.round(h.top + h.height / 2);
      const at = document.elementFromPoint(x, y);
      return { x, y, endY: Math.round(rows.at(-1).getBoundingClientRect().bottom - 3), listTop: list.top, listBottom: list.bottom, vh: innerHeight, hit: !!at && handle.contains(at) };
    })()`);
    assert.ok(p.listTop >= 0 && p.listBottom <= p.vh, `the tool list fits the viewport for the drag (${p.listTop}..${p.listBottom} of ${p.vh} px)`);
    assert.ok(p.hit, `the press point ${p.x},${p.y} hits the top row's handle`);
    const mouse = (type: string, y: number, buttons: number) => cdp.send("Input.dispatchMouseEvent", { type, x: p.x, y, button: "left", buttons, clickCount: 1 });
    await mouse("mouseMoved", p.y, 0);
    await mouse("mousePressed", p.y, 1);
    await cdp.until(`window.__seen.down === 1 && document.querySelector(".tool-order").classList.contains("is-dragging")`, "the press started a drag", 5000);
    for (let y = p.y + 4; ; y = Math.min(y + 4, p.endY)) {
      await mouse("mouseMoved", y, 1);
      await cdp.until(`window.__seen.y !== null && Math.abs(window.__seen.y - ${y}) < 0.5`, `the page saw the move to y=${y}`, 5000);
      if (y === p.endY) break;
    }
    await mouse("mouseReleased", p.endY, 0);
    await cdp.until(`window.__seen.up === 1 && !document.querySelector(".tool-order").classList.contains("is-dragging")`, "the release ended the drag", 5000);
    await cdp.until(`${ORDER}[3] === ${JSON.stringify(top)}`, "the drag moved the top row to the bottom", 5000);
    await savedAt(3, top, "the dragged order saved to config.json");
  };
  try {
    await realDrag();
  } catch (e) {
    // Let go of the button whatever state the first try left, then once more from the start.
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 1, y: 1, button: "left", buttons: 0, clickCount: 1 }).catch(() => {});
    await cdp.until(`!document.querySelector(".tool-order").classList.contains("is-dragging")`, "the failed drag ended", 5000);
    const note = `real mouse drag failed once, retrying: ${(e as Error).message}`;
    t.diagnostic(note);
    console.error(`settings-layout: ${note}`);
    await realDrag();
  }
});
