// "New version available": the latest GitHub release of the (public) repo, compared with the
// running build's number (DESIGN.md § 3 "Releases"). Unauthenticated
// GET https://api.github.com/repos/erkantaylan/motherapp/releases/latest at start, every 6 h,
// and on demand (Settings -> "Check for updates"). The answer and its ETag are cached in
// ~/.local/state/motherapp/release-check.json, so a check after a restart is a conditional
// request (a 304 doesn't count against GitHub's 60/h limit). Never throws, never blocks the
// core: a network error, a timeout (10 s) or a rate limit only sets `error`, and the last good
// answer is kept. `updateCheck: false` in config.json turns the network check off.
import * as fs from "node:fs";
import * as path from "node:path";
import type { JsonObject, ReleaseInfo } from "@motherapp/protocol";

export const LATEST_RELEASE_URL = "https://api.github.com/repos/erkantaylan/motherapp/releases/latest";

/** The number of a release tag "v<N>", or undefined for anything else. */
export function releaseNumber(tag: string): number | undefined {
  const m = /^v([0-9]{1,9})$/.exec(tag.trim());
  return m ? Number(m[1]) : undefined;
}

/** True when the tag's number is higher than the running build's (a VERSION number, or "?"). */
export function isNewerRelease(tag: string | null, current: string): boolean {
  if (tag === null || !/^[0-9]{1,9}$/.test(current)) return false;
  const n = releaseNumber(tag);
  return n !== undefined && n > Number(current);
}

type Fetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;

export interface ReleaseCheckerOptions {
  /** The running build's VERSION number ("2"), or "?". */
  current: string;
  /** false: `updateCheck: false` in config.json. */
  enabled: boolean;
  url?: string;
  /** Where the answer and its ETag are kept across restarts. */
  cacheFile?: string;
  fetch?: Fetch;
  now?: () => number;
  timeoutMs?: number;
  intervalMs?: number;
  log?: (level: "info" | "warn", msg: string, data?: JsonObject) => void;
}

interface Cached {
  etag?: string;
  latest: string | null;
  latestUrl: string | null;
  checkedAt: string | null;
}

export class ReleaseChecker {
  private opts: Required<Omit<ReleaseCheckerOptions, "cacheFile" | "log">> & Pick<ReleaseCheckerOptions, "cacheFile" | "log">;
  private cached: Cached = { latest: null, latestUrl: null, checkedAt: null };
  private error: string | undefined;
  private rateLimitedUntil = 0;
  private inflight: Promise<ReleaseInfo> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private listeners = new Set<(info: ReleaseInfo) => void>();
  /** Network requests made so far (for tests). */
  requests = 0;

  constructor(opts: ReleaseCheckerOptions) {
    this.opts = {
      url: LATEST_RELEASE_URL,
      fetch: (url, init) => fetch(url, init),
      now: Date.now,
      timeoutMs: 10_000,
      intervalMs: 6 * 60 * 60 * 1000,
      ...opts,
    };
    this.load();
  }

  info(): ReleaseInfo {
    if (!this.opts.enabled) return { latest: null, latestUrl: null, newer: false, checkedAt: null, disabled: true };
    const { latest, latestUrl, checkedAt } = this.cached;
    const out: ReleaseInfo = { latest, latestUrl, newer: isNewerRelease(latest, this.opts.current), checkedAt };
    if (this.error) out.error = this.error;
    return out;
  }

  onChange(l: (info: ReleaseInfo) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** Checks now, then every `intervalMs`. Does nothing when disabled. */
  start(): void {
    if (!this.opts.enabled || this.timer) return;
    void this.check();
    this.timer = setInterval(() => void this.check(), this.opts.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One check (concurrent calls share it). Resolves with the new info; never rejects. */
  check(): Promise<ReleaseInfo> {
    if (!this.opts.enabled) return Promise.resolve(this.info());
    this.inflight ??= this.run()
      .catch((e: Error) => {
        this.error = `unexpected: ${e.message}`;
      })
      .then(() => {
        const info = this.info();
        for (const l of [...this.listeners]) l(info);
        return info;
      })
      .finally(() => (this.inflight = undefined));
    return this.inflight;
  }

  private async run(): Promise<void> {
    const { now } = this.opts;
    if (now() < this.rateLimitedUntil) {
      this.error = `rate-limited by GitHub until ${new Date(this.rateLimitedUntil).toISOString()}`;
      return;
    }
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "user-agent": `motherapp/${this.opts.current}`,
      "x-github-api-version": "2022-11-28",
    };
    if (this.cached.etag && this.cached.latest !== null) headers["if-none-match"] = this.cached.etag;
    this.requests++;
    let res: Response;
    try {
      res = await this.opts.fetch(this.opts.url, { headers, signal: AbortSignal.timeout(this.opts.timeoutMs) });
    } catch (e) {
      this.fail(networkReason(e as Error, this.opts.timeoutMs));
      return;
    }
    const at = new Date(now()).toISOString();
    if (res.status === 304) {
      this.succeed({ ...this.cached, checkedAt: at });
      return;
    }
    if (res.status === 404) {
      // No release published yet.
      this.succeed({ latest: null, latestUrl: null, checkedAt: at });
      return;
    }
    if (res.status === 403 || res.status === 429) {
      const remaining = res.headers.get("x-ratelimit-remaining");
      const reset = Number(res.headers.get("x-ratelimit-reset"));
      const retryAfter = Number(res.headers.get("retry-after"));
      if (res.status === 429 || remaining === "0" || retryAfter > 0) {
        let until = now() + 60 * 60 * 1000;
        if (retryAfter > 0) until = now() + retryAfter * 1000;
        else if (reset > 0) until = reset * 1000;
        this.rateLimitedUntil = until;
        this.fail(`rate-limited by GitHub until ${new Date(until).toISOString()}`);
        return;
      }
    }
    if (res.status !== 200) {
      this.fail(`GitHub answered HTTP ${res.status}`);
      return;
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch (e) {
      this.fail(`GitHub sent something that isn't JSON (${(e as Error).message})`);
      return;
    }
    const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    const tag = typeof b.tag_name === "string" ? b.tag_name : "";
    if (releaseNumber(tag) === undefined) {
      this.fail(`the latest release's tag ${JSON.stringify(tag.slice(0, 40))} isn't v<N>`);
      return;
    }
    const url = typeof b.html_url === "string" && b.html_url.startsWith("https://") ? b.html_url : null;
    const etag = res.headers.get("etag") ?? undefined;
    this.succeed({ ...(etag ? { etag } : {}), latest: tag.trim(), latestUrl: url, checkedAt: at });
  }

  private succeed(c: Cached): void {
    const changed = c.latest !== this.cached.latest;
    this.cached = c;
    this.error = undefined;
    this.save();
    if (changed) this.opts.log?.("info", `latest release: ${c.latest ?? "none"}`, { latest: c.latest, newer: isNewerRelease(c.latest, this.opts.current) });
  }

  private fail(reason: string): void {
    if (reason !== this.error) this.opts.log?.("warn", `release check failed: ${reason}`);
    this.error = reason;
  }

  private load(): void {
    if (!this.opts.cacheFile) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.opts.cacheFile, "utf8")) as Record<string, unknown>;
      const latest = typeof raw.latest === "string" && releaseNumber(raw.latest) !== undefined ? raw.latest : null;
      this.cached = {
        latest,
        latestUrl: latest && typeof raw.latestUrl === "string" ? raw.latestUrl : null,
        checkedAt: typeof raw.checkedAt === "string" ? raw.checkedAt : null,
        ...(latest && typeof raw.etag === "string" ? { etag: raw.etag } : {}),
      };
    } catch {
      // missing or broken: start empty
    }
  }

  private save(): void {
    const file = this.opts.cacheFile;
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.cached, null, 2) + "\n");
      fs.renameSync(tmp, file);
    } catch (e) {
      this.opts.log?.("warn", `cannot save ${file}: ${(e as Error).message}`);
    }
  }
}

function networkReason(e: Error, timeoutMs: number): string {
  if (e.name === "TimeoutError" || e.name === "AbortError") return `no answer from GitHub within ${timeoutMs / 1000} s`;
  const cause = (e as Error & { cause?: { code?: string; message?: string } }).cause;
  if (cause?.code) return `network error (${cause.code})`;
  return `network error (${cause?.message ?? e.message})`;
}
