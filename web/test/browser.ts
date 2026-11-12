// Shared by the browser-driven web tests: the real core against a temp tools dir, the web
// frontend built from this checkout, and a headless Chrome/Chromium over the DevTools protocol
// (no Playwright dependency). The same approach as settings-layout.test.ts, which keeps its own
// copy. Not a test file itself (the test glob takes *.test.ts).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const here = path.dirname(fileURLToPath(import.meta.url));
export const repo = path.resolve(here, "..", "..");

export function findBrowser(): string | undefined {
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

export async function waitFor(cond: () => boolean, what: string, timeoutMs: number): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Minimal DevTools protocol client for one page. */
export class Cdp {
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
  /** A pinned viewport at scale 1, whatever the machine's display is. */
  viewport(width: number, height: number): Promise<unknown> {
    return this.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  }
  /** Loads `url` afresh: a navigation that differs only after `#` would keep the old document. */
  async load(url: string): Promise<void> {
    await this.send("Page.navigate", { url: "about:blank" });
    await this.until(`location.href === "about:blank"`, "the blank page");
    await this.send("Page.navigate", { url });
  }
  close(): void {
    this.ws.close();
  }
}

export interface Site {
  port: number;
  cdp: Cdp;
  /** The temp dir (config in `config/motherapp/config.json`). */
  tmp: string;
}

/** A tool for the temp tools dir: an id under tools/ or an absolute dir; enabled unless said. */
export type SiteTool = string | { dir: string; enabled: boolean };

/**
 * Builds the frontend, starts a core over copies of `tools`, and a headless browser with one page. Everything is stopped
 * and removed in `t.after`. The core gets MOTHERAPP_NOTIFY=off and MOTHERAPP_TRAY=off: nothing reaches the desktop.
 */
export async function startSite(t: { after(fn: () => unknown): void }, browserBin: string, name: string, tools: SiteTool[]): Promise<Site> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `ma-${name}-`));
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

  // node_modules is linked in so the copied tools resolve @motherapp/tool-sdk.
  const toolsDir = path.join(tmp, "tools");
  fs.mkdirSync(toolsDir);
  fs.symlinkSync(path.join(repo, "node_modules"), path.join(tmp, "node_modules"));
  const enabled: Record<string, { enabled: boolean }> = {};
  for (const tool of tools) {
    const dir = typeof tool === "string" ? tool : tool.dir;
    const src = path.isAbsolute(dir) ? dir : path.join(repo, "tools", dir);
    const id = path.basename(src);
    fs.cpSync(src, path.join(toolsDir, id), { recursive: true, filter: (f) => !f.includes(`${path.sep}test`) });
    enabled[id] = { enabled: typeof tool === "string" || tool.enabled };
  }
  const cfgDir = path.join(tmp, "config", "motherapp");
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, "config.json"), JSON.stringify({ port: 0, tools: enabled }));
  const core = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(repo, "core/src/main.ts")], {
    env: {
      ...process.env,
      XDG_CONFIG_HOME: path.join(tmp, "config"),
      XDG_STATE_HOME: path.join(tmp, "state"),
      MOTHERAPP_TOOLS_DIR: toolsDir,
      MOTHERAPP_WEB_DIR: webDir,
      MOTHERAPP_PORT: "0",
      MOTHERAPP_NOTIFY: "off",
      MOTHERAPP_TRAY: "off",
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
  const chrome = spawn(browserBin, [...chromeArgs, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
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
  return { port: port!, cdp, tmp };
}
