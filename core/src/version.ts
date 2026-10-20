// What the running core was built from (build-info.json, written by scripts/build-info.sh at
// build time) and where the checkout is now, so the UI and `motherapp status` can say "run
// `motherapp install`". The version string is v<N>-<hash>[-dirty] (DESIGN.md § 3).
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { BuildInfo, CheckoutInfo, VersionInfo } from "@motherapp/protocol";

export function formatVersion(version: string, hash: string, dirty: boolean): string {
  return `v${version}-${hash}${dirty ? "-dirty" : ""}`;
}

const UNKNOWN = { version: "?", hash: "unknown", dirty: false } as const;

/** Reads build-info.json. Never throws: a missing or broken file gives "v?-unknown" plus `error`. */
export function readBuildInfo(file: string): BuildInfo {
  const unknown = (error: string): BuildInfo => ({ ...UNKNOWN, builtAt: null, string: formatVersion(UNKNOWN.version, UNKNOWN.hash, false), error });
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    return unknown(err.code === "ENOENT" ? `${path.basename(file)} not found (not built with npm run build or ./install.sh)` : `${path.basename(file)}: ${err.message}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return unknown(`${path.basename(file)} is not a JSON object`);
  const r = raw as Record<string, unknown>;
  const version = typeof r.version === "string" && /^[0-9]+$/.test(r.version) ? r.version : UNKNOWN.version;
  const hash = typeof r.hash === "string" && /^[0-9a-f]{4,40}$/.test(r.hash) ? r.hash : UNKNOWN.hash;
  const dirty = r.dirty === true;
  const builtAt = typeof r.builtAt === "string" && r.builtAt !== "" ? r.builtAt : null;
  const info: BuildInfo = { version, hash, dirty, builtAt, string: formatVersion(version, hash, dirty) };
  if (version === UNKNOWN.version || hash === UNKNOWN.hash) info.error = `${path.basename(file)} has no usable version/hash`;
  return info;
}

/** Runs git in the checkout; resolves stdout, rejects on failure. Injectable for tests. */
export type GitRunner = (args: string[], cwd: string) => Promise<string>;

export const realGit: GitRunner = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout: 5000, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve(stdout);
    });
  });

export interface CheckoutOptions {
  repo: string;
  git?: GitRunner;
  now?: () => number;
  /** How long a result is reused before `get()` asks git again. Default 60 s. */
  ttlMs?: number;
}

/**
 * The checkout's HEAD, cached: page loads reuse the last answer (git runs at most once per
 * `ttlMs`), and `get(true)` refreshes on demand. Concurrent calls share one git run.
 */
export class Checkout {
  private opts: Required<CheckoutOptions>;
  private cached: CheckoutInfo | undefined;
  private cachedAt = 0;
  private inflight: Promise<CheckoutInfo> | undefined;
  /** Number of git runs so far (for tests). */
  runs = 0;

  constructor(opts: CheckoutOptions) {
    this.opts = { git: realGit, now: Date.now, ttlMs: 60_000, ...opts };
  }

  async get(refresh = false): Promise<CheckoutInfo> {
    const fresh = this.cached && this.opts.now() - this.cachedAt < this.opts.ttlMs;
    if (this.cached && fresh && !refresh) return this.cached;
    this.inflight ??= this.read().finally(() => (this.inflight = undefined));
    return this.inflight;
  }

  private async read(): Promise<CheckoutInfo> {
    const { repo, git, now } = this.opts;
    this.runs++;
    let info: CheckoutInfo;
    const version = readVersionNumber(repo);
    try {
      const head = (await git(["rev-parse", "HEAD"], repo)).trim();
      if (!/^[0-9a-f]{40,64}$/.test(head)) throw new Error(`unexpected git output: ${head.slice(0, 80)}`);
      const short = head.slice(0, 7);
      info = { hash: head, short, version, string: formatVersion(version, short, false), checkedAt: new Date(now()).toISOString() };
    } catch (e) {
      info = { hash: null, short: null, version, string: null, checkedAt: new Date(now()).toISOString(), error: `git: ${(e as Error).message}` };
    }
    this.cached = info;
    this.cachedAt = now();
    return info;
  }
}

/** The number in <repo>/VERSION, or "?". */
export function readVersionNumber(repo: string): string {
  try {
    const n = fs.readFileSync(path.join(repo, "VERSION"), "utf8").trim();
    return /^[0-9]+$/.test(n) ? n : "?";
  } catch {
    return "?";
  }
}

/** Compares the running build with the checkout. */
export function compareVersions(running: BuildInfo, checkout: CheckoutInfo): VersionInfo {
  const out: VersionInfo = { running, checkout, status: "unknown" };
  if (running.hash === UNKNOWN.hash || checkout.hash === null || checkout.string === null) return out;
  const same = checkout.hash.startsWith(running.hash) && running.version === checkout.version;
  if (same) {
    out.status = "current";
    return out;
  }
  out.status = "behind";
  out.message = `running ${running.string}, checkout is at ${checkout.string}, run \`motherapp install\``;
  return out;
}

/** What the server exposes: build info read once at start, checkout looked up on demand. */
export class VersionSource {
  readonly build: BuildInfo;
  private checkout: Checkout;

  constructor(build: BuildInfo, checkout: Checkout) {
    this.build = build;
    this.checkout = checkout;
  }

  async get(refresh = false): Promise<VersionInfo> {
    return compareVersions(this.build, await this.checkout.get(refresh));
  }
}
