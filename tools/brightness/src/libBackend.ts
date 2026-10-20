// Backend over libddcutil, kept loaded in a worker thread (ddcWorker.ts). The main thread only
// posts messages, so a slow monitor never blocks the JSON-RPC loop. If the worker stops
// answering for `hangMs`, it is terminated and replaced on the next call.
import { Worker } from "node:worker_threads";
import { BackendError } from "./backend.ts";
import type { Backend, MonitorInfo, Reading } from "./backend.ts";
import { DDCRC, SONAME } from "./ddca.ts";
import type { WorkerError, WorkerMessage, WorkerRequest } from "./ddcWorker.ts";

export interface LibBackendOptions {
  /** Library to load. Default libddcutil.so.4. */
  soname?: string;
  /** Worker script (tests swap in a fake). Default ./ddcWorker.ts. */
  workerUrl?: URL;
  drmRoot?: string;
  /** How long loading the library may take. Default 10 s. */
  startTimeoutMs?: number;
  /** A call that has not returned after this long means the worker is stuck. Default 60 s. */
  hangMs?: number;
}

// errno values libddcutil passes through as negative status codes
const ENOENT = -2, EIO = -5, ENXIO = -6, EBUSY = -16, ENODEV = -19, ETIMEDOUT = -110, EREMOTEIO = -121;
const NO_ANSWER = new Set<number>([DDCRC.RETRIES, DDCRC.NULL_RESPONSE, DDCRC.DDC_DATA, -3004, -3006, -3011, EIO, ETIMEDOUT, EREMOTEIO]);
const GONE = new Set<number>([DDCRC.INVALID_DISPLAY, DDCRC.ARG, DDCRC.NOT_FOUND, ENOENT, ENXIO, ENODEV]);
const BUSY = new Set<number>([DDCRC.LOCKED, DDCRC.ALREADY_OPEN, EBUSY]);
const UNSUPPORTED = new Set<number>([DDCRC.REPORTED_UNSUPPORTED, DDCRC.DETERMINED_UNSUPPORTED]);

/** A worker error as a message for the failed dot. */
export function toBackendError(e: WorkerError): BackendError {
  const s = e.status;
  const code = e.rcName ? ` (${e.rcName})` : "";
  if (s !== undefined && NO_ANSWER.has(s)) return new BackendError(`no answer over DDC/CI, is it switched on?${code}`);
  if (s !== undefined && GONE.has(s)) return new BackendError(`not reachable any more, unplugged or switched off?${code}`, { gone: true });
  if (s !== undefined && BUSY.has(s)) return new BackendError(`busy, another program is talking to it${code}`);
  if (s !== undefined && UNSUPPORTED.has(s)) return new BackendError(`doesn't support brightness over DDC/CI${code}`);
  return new BackendError(e.message);
}

interface Pending {
  resolve(v: unknown): void;
  reject(e: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class LibBackend implements Backend {
  readonly kind = "libddcutil" as const;
  description = "libddcutil";
  private opts: LibBackendOptions;
  private worker: Worker | undefined;
  private starting: Promise<Worker> | undefined;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private closed = false;

  private constructor(opts: LibBackendOptions) {
    this.opts = opts;
  }

  /** Starts the worker and loads the library; rejects with the reason if that fails. */
  static async start(opts: LibBackendOptions = {}): Promise<LibBackend> {
    const b = new LibBackend(opts);
    await b.ensureWorker();
    return b;
  }

  private ensureWorker(): Promise<Worker> {
    if (this.worker) return Promise.resolve(this.worker);
    if (this.starting) return this.starting;
    this.starting = new Promise<Worker>((resolve, reject) => {
      const url = this.opts.workerUrl ?? new URL("./ddcWorker.ts", import.meta.url);
      const w = new Worker(url, {
        workerData: { soname: this.opts.soname ?? SONAME, drmRoot: this.opts.drmRoot },
        stdout: false,
        stderr: false,
      });
      w.unref();
      let ready = false;
      const fail = (msg: string) => {
        clearTimeout(timer);
        this.starting = undefined;
        void w.terminate();
        reject(new Error(msg));
      };
      const timer = setTimeout(() => fail(`loading ${this.opts.soname ?? SONAME} took longer than ${(this.opts.startTimeoutMs ?? 10_000) / 1000} s`), this.opts.startTimeoutMs ?? 10_000);
      w.on("message", (m: WorkerMessage) => {
        if (m.type === "ready") {
          ready = true;
          clearTimeout(timer);
          this.description = `libddcutil ${m.version}`;
          this.worker = w;
          this.starting = undefined;
          resolve(w);
        } else if (m.type === "fatal") {
          fail(m.message);
        } else {
          this.settle(m);
        }
      });
      w.on("error", (e) => {
        if (!ready) fail(e.message);
        else this.dropWorker(w, `libddcutil worker failed: ${e.message}`);
      });
      w.on("exit", (code) => {
        if (!ready) fail(`libddcutil worker exited (code ${code})`);
        else this.dropWorker(w, "libddcutil worker exited");
      });
    });
    return this.starting;
  }

  private settle(m: Extract<WorkerMessage, { id: number }>): void {
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.ok) p.resolve(m.result);
    else p.reject(toBackendError(m.error));
  }

  private dropWorker(w: Worker, reason: string): void {
    if (this.worker !== w) return;
    this.worker = undefined;
    void w.terminate();
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new BackendError(reason, { gone: true }));
      this.pending.delete(id);
    }
  }

  private async call<T>(req: WorkerRequest extends infer R ? (R extends unknown ? Omit<R, "id"> : never) : never): Promise<T> {
    if (this.closed) throw new BackendError("brightness backend is shut down");
    const w = await this.ensureWorker();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => this.dropWorker(w, `libddcutil stopped answering (a ${req.op} call took over ${(this.opts.hangMs ?? 60_000) / 1000} s)`), this.opts.hangMs ?? 60_000);
      timer.unref();
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      w.postMessage({ ...req, id });
    });
  }

  detect(redetect: boolean): Promise<MonitorInfo[]> {
    return this.call<MonitorInfo[]>({ op: "detect", redetect });
  }

  read(bus: number): Promise<Reading> {
    return this.call<Reading>({ op: "read", bus });
  }

  async write(bus: number, raw: number): Promise<void> {
    await this.call({ op: "write", bus, raw });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    const w = this.worker;
    if (w) {
      try {
        await Promise.race([this.call({ op: "close" }), new Promise((r) => setTimeout(r, 2000).unref())]);
      } catch {
        // closing is best effort
      }
    }
    this.closed = true;
    if (w) await w.terminate();
    this.worker = undefined;
  }
}
