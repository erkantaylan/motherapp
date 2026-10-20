// Stand-in for ddcWorker.ts: answers like the real worker, but blocks its thread synchronously
// (as a libddcutil call does) for the buses tests use to simulate slow or stuck monitors.
//   bus 1: answers 48/100   bus 9: blocks 300 ms, then answers   bus 8: blocks for 5 s
import { parentPort, workerData } from "node:worker_threads";

const port = parentPort!;
const block = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

if ((workerData as { soname?: string }).soname === "fatal.so") {
  port.postMessage({ type: "fatal", message: "fatal.so: cannot open shared object file: No such file or directory" });
} else {
  port.on("message", (req: { id: number; op: string; bus?: number }) => {
    if (req.op === "detect") {
      port.postMessage({ id: req.id, ok: true, result: [{ bus: 1, mfg: "MSI", model: "MSI G274QPF", serial: "x" }] });
    } else if (req.op === "read" && req.bus === 1) {
      port.postMessage({ id: req.id, ok: true, result: { current: 48, max: 100 } });
    } else if (req.op === "read" && req.bus === 9) {
      block(300);
      port.postMessage({ id: req.id, ok: true, result: { current: 9, max: 100 } });
    } else if (req.op === "read" && req.bus === 8) {
      block(5000);
      port.postMessage({ id: req.id, ok: true, result: { current: 8, max: 100 } });
    } else if (req.op === "write") {
      port.postMessage({ id: req.id, ok: false, error: { message: "ddca_set_non_table_vcp_value: DDCRC_RETRIES", status: -3007, rcName: "DDCRC_RETRIES" } });
    } else {
      port.postMessage({ id: req.id, ok: true, result: null });
    }
  });
  port.postMessage({ type: "ready", version: "1.4.1-fake" });
}
