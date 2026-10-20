// libddcutil 1.4 prints to C stdout from its load-time constructor (e.g. "No video cards
// found in /sys/class/drm…"), before ddca_set_fout() can be called. In serve mode fd 1 is the
// JSON-RPC channel, and for `brightctl list --json` it is the JSON. So before the library is
// loaded, the real stdout is duplicated to a new fd that Node writes to, and fd 1 is pointed
// at stderr: whatever C code prints ends up in the log (or on the terminal's stderr) instead.
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as net from "node:net";
import * as tty from "node:tty";
import type { Writable } from "node:stream";

/** Returns a stream on the real stdout and redirects fd 1 to stderr; undefined if that fails. */
export function isolateStdout(): Writable | undefined {
  let fd: number;
  try {
    const require = createRequire(import.meta.url);
    const koffi = require("koffi") as typeof import("koffi");
    const libc = koffi.load("libc.so.6");
    const dup = libc.func("int dup(int oldfd)");
    const dup2 = libc.func("int dup2(int oldfd, int newfd)");
    fd = dup(1) as number;
    if (fd < 0) return undefined;
    if ((dup2(2, 1) as number) < 0) {
      fs.closeSync(fd);
      return undefined;
    }
  } catch {
    return undefined;
  }
  // Same choice Node makes for process.stdout.
  const st = fs.fstatSync(fd);
  if (tty.isatty(fd)) return new tty.WriteStream(fd);
  if (st.isFIFO() || st.isSocket()) {
    const s = new net.Socket({ fd, readable: false, writable: true });
    // Like process.stdout on Linux: blocking writes, so nothing is lost at exit.
    (s as unknown as { _handle?: { setBlocking?(b: boolean): void } })._handle?.setBlocking?.(true);
    return s;
  }
  return fs.createWriteStream("", { fd });
}
