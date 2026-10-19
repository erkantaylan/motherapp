// Log service (DESIGN.md § 4.12). Every entry goes to: stdout as one JSON line (journald under
// systemd), $XDG_STATE_HOME/motherapp/log.jsonl (size-capped, rotated), and a ring buffer that
// serves the logs page.
import * as fs from "node:fs";
import * as path from "node:path";
import type { JsonObject, LogEntry, LogLevel } from "@motherapp/protocol";

export class RingBuffer<T> {
  private items: (T | undefined)[];
  private start = 0;
  private count = 0;
  readonly capacity: number;

  constructor(capacity: number) {
    if (capacity < 1) throw new Error("capacity must be >= 1");
    this.capacity = capacity;
    this.items = new Array<T | undefined>(capacity);
  }

  push(item: T): void {
    const end = (this.start + this.count) % this.capacity;
    this.items[end] = item;
    if (this.count < this.capacity) this.count++;
    else this.start = (this.start + 1) % this.capacity;
  }

  get size(): number {
    return this.count;
  }

  /** Oldest first; with `limit`, the newest `limit` items. */
  toArray(limit = this.count): T[] {
    const n = Math.min(limit, this.count);
    const out: T[] = [];
    for (let i = this.count - n; i < this.count; i++) out.push(this.items[(this.start + i) % this.capacity] as T);
    return out;
  }
}

export interface RotatingFileOptions {
  file: string;
  /** Rotate when the file would exceed this many bytes. Default 5 MiB. */
  maxBytes?: number;
  /** Rotated files kept: log.jsonl.1 ... log.jsonl.N. Default 2. */
  keep?: number;
}

/** Append-only line file with size cap and numbered rotation. */
export class RotatingFile {
  readonly file: string;
  readonly maxBytes: number;
  readonly keep: number;
  private fd: number | undefined;
  private size = 0;
  private failed = false;

  constructor(opts: RotatingFileOptions) {
    this.file = opts.file;
    this.maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
    this.keep = opts.keep ?? 2;
  }

  private open(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.fd = fs.openSync(this.file, "a");
    this.size = fs.fstatSync(this.fd).size;
  }

  private rotate(): void {
    if (this.fd !== undefined) fs.closeSync(this.fd);
    this.fd = undefined;
    if (this.keep <= 0) {
      fs.rmSync(this.file, { force: true });
    } else {
      fs.rmSync(`${this.file}.${this.keep}`, { force: true });
      for (let i = this.keep - 1; i >= 1; i--) {
        if (fs.existsSync(`${this.file}.${i}`)) fs.renameSync(`${this.file}.${i}`, `${this.file}.${i + 1}`);
      }
      if (fs.existsSync(this.file)) fs.renameSync(this.file, `${this.file}.1`);
    }
    this.open();
  }

  /** Appends one line (a trailing newline is added). Errors disable the file sink once. */
  write(line: string): void {
    if (this.failed) return;
    try {
      if (this.fd === undefined) this.open();
      const buf = Buffer.from(line + "\n");
      if (this.size > 0 && this.size + buf.length > this.maxBytes) this.rotate();
      fs.writeSync(this.fd!, buf);
      this.size += buf.length;
    } catch (e) {
      this.failed = true;
      process.stderr.write(`motherapp: log file disabled: ${(e as Error).message}\n`);
    }
  }

  close(): void {
    if (this.fd !== undefined) fs.closeSync(this.fd);
    this.fd = undefined;
  }
}

export interface LogServiceOptions {
  /** Ring buffer size. Default 5000. */
  capacity?: number;
  file?: RotatingFile;
  /** Writer for the JSON line on stdout; default process.stdout.write. Pass null to disable. */
  stdout?: ((line: string) => void) | null;
  now?: () => Date;
}

export type LogListener = (entry: LogEntry) => void;

export class LogService {
  private ring: RingBuffer<LogEntry>;
  private file: RotatingFile | undefined;
  private stdout: ((line: string) => void) | null;
  private now: () => Date;
  private listeners = new Set<LogListener>();
  private seq = 0;

  constructor(opts: LogServiceOptions = {}) {
    this.ring = new RingBuffer(opts.capacity ?? 5000);
    this.file = opts.file;
    this.stdout = opts.stdout === undefined ? (l) => process.stdout.write(l + "\n") : opts.stdout;
    this.now = opts.now ?? (() => new Date());
  }

  add(tool: string, src: LogEntry["src"], level: LogLevel, msg: string, fields?: JsonObject): LogEntry {
    const entry: LogEntry = { seq: ++this.seq, ts: this.now().toISOString(), level, tool, src, msg };
    if (fields && Object.keys(fields).length > 0) entry.fields = fields;
    const line = JSON.stringify(entry);
    this.stdout?.(line);
    this.file?.write(line);
    this.ring.push(entry);
    for (const l of this.listeners) {
      try {
        l(entry);
      } catch {
        // a broken listener must not break logging
      }
    }
    return entry;
  }

  /** Entry written by the core, about itself (tool "core") or about a tool. */
  core(level: LogLevel, msg: string, fields?: JsonObject, tool = "core"): LogEntry {
    return this.add(tool, "core", level, msg, fields);
  }

  backlog(limit?: number): LogEntry[] {
    return this.ring.toArray(limit);
  }

  subscribe(l: LogListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  close(): void {
    this.file?.close();
  }
}
