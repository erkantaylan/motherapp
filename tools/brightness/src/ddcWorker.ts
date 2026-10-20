// Worker thread that owns libddcutil. Every libddcutil call blocks (a brightness read is
// ~0.5 s, an absent monitor can take seconds of retries), so they all run here, one at a
// time, on this one thread: libddcutil keeps per-thread state (output redirection, the
// verify setting, which thread opened a display), so a single owning thread is the safe use.
// The serve loop on the main thread stays free to answer the core.
//
// Messages in:  { id, op: "detect", redetect } | { id, op: "read", bus } | { id, op: "write", bus, raw } | { id, op: "close" }
// Messages out: { type: "ready", version } | { type: "fatal", message } | { id, ok: true, result } | { id, ok: false, error }
import { parentPort, workerData } from "node:worker_threads";
import { DdcaError, VCP_BRIGHTNESS, loadDdca } from "./ddca.ts";
import type { Ddca } from "./ddca.ts";
import type { MonitorInfo } from "./backend.ts";
import { connectorForBus } from "./sysfs.ts";

export interface WorkerError {
  message: string;
  status?: number;
  rcName?: string;
}

export type WorkerRequest =
  | { id: number; op: "detect"; redetect: boolean }
  | { id: number; op: "read"; bus: number }
  | { id: number; op: "write"; bus: number; raw: number }
  | { id: number; op: "close" };

export type WorkerMessage =
  | { type: "ready"; version: string }
  | { type: "fatal"; message: string }
  | { type?: undefined; id: number; ok: true; result: unknown }
  | { type?: undefined; id: number; ok: false; error: WorkerError };

const port = parentPort!;
const opts = (workerData ?? {}) as { soname?: string; drmRoot?: string };

let ddca: Ddca;
try {
  ddca = loadDdca(opts.soname);
} catch (e) {
  const soname = opts.soname ?? "libddcutil.so.4";
  const msg = (e as Error).message;
  port.postMessage({ type: "fatal", message: msg.includes(soname) ? msg : `${soname}: ${msg}` } satisfies WorkerMessage);
  process.exit(0);
}

interface Display {
  dref: bigint;
  dh?: bigint;
}
const displays = new Map<number, Display>();

function closeHandle(d: Display): void {
  if (d.dh === undefined) return;
  const dh = d.dh;
  delete d.dh;
  try {
    ddca.close(dh);
  } catch {
    // the handle is dropped either way
  }
}

function closeAll(): void {
  for (const d of displays.values()) closeHandle(d);
}

function detect(redetect: boolean): MonitorInfo[] {
  if (redetect) {
    closeAll();
    displays.clear();
    ddca.redetect(); // invalidates every display ref and handle
  }
  const found = ddca.listDisplays().filter((d) => d.ioMode === 0); // DDCA_IO_I2C
  const seen = new Set<number>();
  const out: MonitorInfo[] = [];
  for (const d of found) {
    seen.add(d.bus);
    const old = displays.get(d.bus);
    if (!old || old.dref !== d.dref) {
      if (old) closeHandle(old);
      displays.set(d.bus, { dref: d.dref });
    }
    const info: MonitorInfo = { bus: d.bus, mfg: d.mfg, model: d.model, serial: d.serial };
    const connector = connectorForBus(d.bus, opts.drmRoot);
    if (connector) info.connector = connector;
    out.push(info);
  }
  for (const [bus, d] of displays) {
    if (!seen.has(bus)) {
      closeHandle(d);
      displays.delete(bus);
    }
  }
  return out;
}

function handle(bus: number): bigint {
  const d = displays.get(bus);
  if (!d) throw Object.assign(new Error(`no display on /dev/i2c-${bus} in the last detection`), { status: -3020, rcName: "DDCRC_INVALID_DISPLAY" });
  if (d.dh === undefined) d.dh = ddca.open(d.dref);
  return d.dh;
}

/** Runs a call on an open display; on any error the handle is closed so the next call reopens. */
function withDisplay<T>(bus: number, fn: (dh: bigint) => T): T {
  const dh = handle(bus);
  try {
    return fn(dh);
  } catch (e) {
    const d = displays.get(bus);
    if (d) closeHandle(d);
    throw e;
  }
}

function run(req: WorkerRequest): unknown {
  switch (req.op) {
    case "detect":
      return detect(req.redetect);
    case "read":
      return withDisplay(req.bus, (dh) => ddca.getVcp(dh, VCP_BRIGHTNESS));
    case "write":
      withDisplay(req.bus, (dh) => ddca.setVcp(dh, VCP_BRIGHTNESS, req.raw));
      return null;
    case "close":
      closeAll();
      return null;
  }
}

port.on("message", (req: WorkerRequest) => {
  try {
    port.postMessage({ id: req.id, ok: true, result: run(req) } satisfies WorkerMessage);
  } catch (e) {
    const err = e as Error & { status?: number; rcName?: string };
    const error: WorkerError = { message: err.message };
    if (e instanceof DdcaError) {
      error.status = e.status;
      error.rcName = e.rcName;
    } else if (typeof err.status === "number") {
      error.status = err.status;
      if (err.rcName) error.rcName = err.rcName;
    }
    port.postMessage({ id: req.id, ok: false, error } satisfies WorkerMessage);
  }
});

port.postMessage({ type: "ready", version: ddca.version } satisfies WorkerMessage);
