// Links and the delivery log, kept in `~/.local/state/motherapp/inbox/` (directory 0700,
// files 0600). A token is never stored: only its SHA-256 and its last 4 characters (to tell
// links apart on the page). A token is 32 random bytes, base64url (43 characters).
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { sweepTmpFiles } from "@motherapp/tool-sdk";
import type { LinkOptions } from "./limits.ts";

export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export interface PaneRef {
  /** "%3" */
  id: string;
  /** "motherapp:0.0", as it was when the link was made. */
  target: string;
  /** The pane's pid then; a different pid means a different pane (e.g. tmux restarted). */
  pid: number;
  path: string;
}

export interface LinkRecord {
  id: string;
  /** hex SHA-256 of the token. */
  hash: string;
  last4: string;
  label: string;
  pane: PaneRef;
  /** Tunnel host the link was made with ("" if unknown). Quick-tunnel hosts change on restart. */
  host: string;
  created: number;
  expires: number;
  /** Messages accepted so far (informational; there is no per-link limit). */
  uses: number;
  revoked?: number;
}

export interface DeliveryEntry {
  seq: number;
  time: number;
  linkId: string;
  label: string;
  pane: string;
  /** The full line as typed (or as it would have been). */
  text: string;
  result: string;
  /** Sender as reported by the request (Cf-Connecting-IP, User-Agent); informational only. */
  from?: string;
}

interface LinksFile {
  version: 1;
  links: LinkRecord[];
}

interface LogFile {
  version: 1;
  seq: number;
  entries: DeliveryEntry[];
}

export const LOG_MAX = 500;
const PRUNE_AFTER_MS = 7 * 86_400_000;

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

export function newToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export type LinkStatus = "active" | "revoked" | "expired";

export function linkStatus(l: LinkRecord, now: number): LinkStatus {
  if (l.revoked !== undefined) return "revoked";
  if (now >= l.expires) return "expired";
  return "active";
}

/**
 * A stored link as written by any version. Links from before 2026-10-20 carry `maxUses` and
 * `maxLen`; those fields are dropped (no per-link limits any more), except that a link that
 * had already used up its messages stays ended (as revoked when it was made) rather than
 * coming back to life.
 */
export function normalizeLink(raw: LinkRecord & { maxUses?: unknown; maxLen?: unknown }): LinkRecord {
  const { maxUses, maxLen: _maxLen, ...l } = raw;
  l.uses = Number.isInteger(l.uses) && l.uses >= 0 ? l.uses : 0;
  if (l.revoked === undefined && typeof maxUses === "number" && l.uses >= maxUses) l.revoked = l.created;
  return l;
}

/** Writes `data` to `file` atomically, mode 0600. */
function writePrivate(file: string, data: string): void {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600); // in case the umask or an existing file got in the way
  fs.renameSync(tmp, file);
}

export class Store {
  readonly dir: string;
  private links: LinkRecord[] = [];
  private log: LogFile = { version: 1, seq: 0, entries: [] };
  /** Problems reading the files (shown on the page). */
  readonly problems: string[] = [];

  constructor(dir: string) {
    this.dir = dir;
    // Temp files of a write that was killed before its rename (#29); older than a minute only.
    for (const f of [this.linksFile, this.logFile]) sweepTmpFiles(dir, path.basename(f));
    this.load();
  }

  get linksFile(): string {
    return path.join(this.dir, "links.json");
  }

  get logFile(): string {
    return path.join(this.dir, "deliveries.json");
  }

  private ensureDir(): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.dir, 0o700);
  }

  load(): void {
    this.links = [];
    try {
      const f = JSON.parse(fs.readFileSync(this.linksFile, "utf8")) as LinksFile;
      if (Array.isArray(f.links)) this.links = f.links.filter((l) => l && typeof l.hash === "string" && /^[0-9a-f]{64}$/.test(l.hash)).map(normalizeLink);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") this.problems.push(`cannot read ${this.linksFile}: ${(e as Error).message}`);
    }
    try {
      const f = JSON.parse(fs.readFileSync(this.logFile, "utf8")) as LogFile;
      if (Array.isArray(f.entries)) this.log = { version: 1, seq: Number(f.seq) || 0, entries: f.entries };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") this.problems.push(`cannot read ${this.logFile}: ${(e as Error).message}`);
    }
  }

  private saveLinks(): void {
    this.ensureDir();
    const f: LinksFile = { version: 1, links: this.links };
    writePrivate(this.linksFile, JSON.stringify(f, null, 2) + "\n");
  }

  private saveLog(): void {
    this.ensureDir();
    writePrivate(this.logFile, JSON.stringify(this.log) + "\n");
  }

  all(): LinkRecord[] {
    return this.links.map((l) => structuredClone(l));
  }

  active(now: number): LinkRecord[] {
    return this.links.filter((l) => linkStatus(l, now) === "active").map((l) => structuredClone(l));
  }

  get(id: string): LinkRecord | undefined {
    const l = this.links.find((x) => x.id === id);
    return l && structuredClone(l);
  }

  /** Makes a link. The token is returned once and never stored. */
  create(opts: LinkOptions & { label: string; pane: PaneRef; host: string }, now: number): { link: LinkRecord; token: string } {
    const token = newToken();
    let id: string;
    do id = crypto.randomBytes(4).toString("hex");
    while (this.links.some((l) => l.id === id));
    const link: LinkRecord = {
      id,
      hash: hashToken(token),
      last4: token.slice(-4),
      label: opts.label,
      pane: opts.pane,
      host: opts.host,
      created: now,
      expires: now + opts.expiresMs,
      uses: 0,
    };
    this.prune(now);
    this.links.push(link);
    this.saveLinks();
    return { link: structuredClone(link), token };
  }

  /**
   * The active link for this token, or undefined: unknown, revoked and expired tokens
   * all look the same. The hash is compared with every stored hash in constant time.
   */
  verify(token: string, now: number): LinkRecord | undefined {
    const wanted = Buffer.from(hashToken(TOKEN_RE.test(token) ? token : "x".repeat(43)), "hex");
    let found: LinkRecord | undefined;
    for (const l of this.links) {
      const same = crypto.timingSafeEqual(wanted, Buffer.from(l.hash, "hex"));
      if (same && found === undefined) found = l;
    }
    if (!TOKEN_RE.test(token) || !found || linkStatus(found, now) !== "active") return undefined;
    return structuredClone(found);
  }

  recordUse(id: string): void {
    const l = this.links.find((x) => x.id === id);
    if (!l) return;
    l.uses++;
    this.saveLinks();
  }

  /** Revokes an active link; false when there is no such link or it already ended. */
  revoke(id: string, now: number): boolean {
    const l = this.links.find((x) => x.id === id);
    if (!l || linkStatus(l, now) !== "active") return false;
    l.revoked = now;
    this.saveLinks();
    return true;
  }

  /** Forgets links that ended more than a week ago. */
  prune(now: number): void {
    const before = this.links.length;
    this.links = this.links.filter((l) => linkStatus(l, now) === "active" || Math.max(l.expires, l.revoked ?? 0) > now - PRUNE_AFTER_MS);
    if (this.links.length !== before) this.saveLinks();
  }

  deliveries(): DeliveryEntry[] {
    return this.log.entries.map((e) => ({ ...e }));
  }

  addDelivery(e: Omit<DeliveryEntry, "seq">): DeliveryEntry {
    const entry: DeliveryEntry = { seq: ++this.log.seq, ...e };
    this.log.entries.push(entry);
    if (this.log.entries.length > LOG_MAX) this.log.entries.splice(0, this.log.entries.length - LOG_MAX);
    this.saveLog();
    return { ...entry };
  }
}
