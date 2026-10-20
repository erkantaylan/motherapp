# CLI pipes, double SIGTERM, shared shortcut groups, volume range (2026-10-21, sub-agent: fixes for #26–#29)

## Lessons

- [both] **Every CLI subcommand must survive its reader going away.** `audioctl list | head -1`
  died with `Error: write EPIPE … Unhandled 'error' event` and exit 1, because Node ignores
  SIGPIPE and turns the failed write into a stream `error` nobody handled. → Each tool entry calls
  `exitOnBrokenPipe()` from `@motherapp/tool-sdk` in its non-`serve` branch (EPIPE → exit 0,
  anything else still throws). A CLI that writes to another stream than `process.stdout`
  (brightctl's duplicated fd from `isolateStdout`) must pass that stream too. Never in `serve`:
  there stdout is the JSON-RPC channel.
- [cloud] A deterministic EPIPE in a test: spawn the CLI with `stdio: [.., "pipe", ..]` and call
  `child.stdout.destroy()` right away; the child is still starting, so its first write fails.
  `packages/tool-sdk/test/cli-epipe.test.ts` does that for all five CLIs against their fakes,
  plus a real `| head -1` in bash.
- [both] **`process.once("SIGTERM")` is a trap.** After the first signal the listener is gone,
  Node restores the default action, and a second SIGTERM kills the process at once, even in the
  middle of synchronous code (a `writeFileSync` + `renameSync` save). Under systemd's default
  `KillMode=control-group` every process gets SIGTERM and the core sends its tools another, so
  tools died mid-save (empty `audio.json.<pid>.tmp`, 37× "killed by SIGTERM" on the machine).
  → Use `process.on` with a "stopping" flag. The unit now has `KillMode=mixed` (only the core gets
  systemd's SIGTERM; the leftovers get SIGKILL when it exits) and `TimeoutStopSec=15` (> the
  core's 3 s per-tool kill grace).
- [cloud] To test "a signal lands mid-save", patch `fs.writeFileSync` in the child and call
  `syncBuiltinESMExports()` so the SDK's `import * as fs` sees it; write half, print SAVING,
  block with `Atomics.wait`, and have the parent send the second SIGTERM on SAVING. With the old
  `once` this reproduces the machine exactly (`signal: SIGTERM`). To imitate control-group mode,
  spawn the core `detached: true` and `process.kill(-pid, "SIGTERM")`.
- [both] Atomic writers leave `<file>.<pid>[.<hex>].tmp` when killed anyway. `sweepTmpFiles()`
  in the SDK removes ones older than a minute on startup (SDK state, inbox store); a younger one
  may be another process's write in progress.
- [both] A setter's parser should reject, not clamp, an absolute value out of range: clamping
  hid `audioctl volume 151` and put the user's speakers at 150 %. Relative steps may clamp.
- [cloud] `core/test/e2e.test.ts`'s first test waited for "any snapshot" and then looked for the
  demo's; with the real tools enabled their snapshots arrived first now and then (seen once in
  this session). → Disable every other tool in e2e configs (the tool-order lesson says the
  same) and wait for the snapshot you then read.
- [cloud] npm isn't in the `npx node@24` bin dir. → Put `/opt/node22/bin` after it on PATH
  (`npm ci` then runs under Node 24, since npm uses the `node` first on PATH).

## Open

- On the machine: after `motherapp install`, `systemctl --user show motherapp -p KillMode`
  should say `mixed`; a `systemctl --user restart motherapp` should log each tool as
  "stopped (exited with code 0)" and leave no new `*.tmp` in `~/.local/state/motherapp/`.
- Firefox: the "Shared groups" card and the Group field's datalist (only prefixes in use).
