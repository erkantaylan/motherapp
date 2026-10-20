# Brightness tool (2026-10-20, sub-agent: brightness tool builder)

Built `tools/brightness/` (`brightctl`) in a cloud container with no monitors and no `/dev/i2c`.
The real `libddcutil.so.4` (1.4.1) was installed here and loaded through koffi. Everything
involving a monitor ran against a fake backend or a fake `ddcutil` on PATH.

## Lessons

- [both] **libddcutil 1.4 prints to C stdout from its load-time constructor**, before
  `ddca_set_fout()` can be called. In the container it printed "Unable to open directory
  /sys/class/drm… No video cards found…". In serve mode, fd 1 is the JSON-RPC channel. →
  `src/stdio.ts` calls libc `dup(1)` / `dup2(2, 1)` through koffi before the library loads, and
  gives the SDK a stream on the duplicate (the SDK's `output` option). C output then shows up
  in the log at level error. Do the same for any native library that might print.
- [cloud] `apt-get download libddcutil-dev libddcutil4` and `dpkg-deb -x` give the real 1.4.1
  headers. `koffi.type("DDCA_Display_Info")` reported size 200 with `dref` at offset 192, which
  matches the hand-computed layout. The 1.4 API has no `ddca_init`; 2.x (`.so.5`) does, so only
  `.so.4` is loaded.
- [cloud] koffi 3.x returns pointers as **BigInt** (2.x used External objects), ships its
  native code in `@koromix/koffi-<platform>` optional dependencies (all of them are in the
  lockfile), and works inside a `worker_threads` worker started from a `.ts` file on Node 24.
- [cloud] A `Worker` that has loaded koffi kept a CLI process alive after `unref()`. →
  `brightctl` always calls `service.stop()`, which terminates the worker.
- [cloud] The scratchpad directory is **shared with other agents**. Another agent overwrote my
  `verify.sh` to point at its own worktree, and the log file was shared too. → Give scratch
  files unique names (I used `bright-verify-af6c.sh`) and print `pwd` in the output.
- [both] `brightctl` goes through the running core's WebSocket (Node 24's global `WebSocket`;
  the core accepted it, so no bad Origin is sent). It talks to the monitors itself only when the
  core or the tool isn't running. This avoids two processes on one I2C bus (ddcutil 1.4 has no
  cross-process locking) and the 1 s detect on every key press.

## Not verified without real monitors (check on the machine)

- Any real DDC/CI call through libddcutil: `ddca_open_display2`, `ddca_get/set_non_table_vcp_value`
  on the MSI and the Acer, and how long each takes (the CLI takes ~0.5 s per read).
- `ddca_enable_verify(false)` (no read-back after a write): that the monitors still apply the
  value. A confirming read follows 1.5 s after the last write.
- Which status codes a switched-off or unplugged monitor really returns. The mapping in
  `libBackend.ts` (`DDCRC_RETRIES`/`EIO` → "is it switched on?", `DDCRC_INVALID_DISPLAY`/
  `ENODEV`/`ENXIO` → "unplugged?") is a guess, and so is whether an off monitor still appears
  in detection.
- The sysfs connector lookup (`/sys/class/drm/card1-DP-1/i2c-1` or a `ddc` symlink) used by the
  libddcutil backend. If it fails, the subtitle shows `/dev/i2c-N` instead of `DP-1`.
- The EDID serials as libddcutil reports them (expected `CC2H683C00058`, `#ASM1Buw5LKnd`, from
  `ddcutil detect`). Row keys are built from them.
- The fallback's `ddcutil` error texts and its "Invalid display" block format: the fake
  `ddcutil` makes them up. Only `detect --brief` and `getvcp 10` were captured on the machine.
- Whether the DP-AUX monitors misbehave if two calls hit different buses back to back. All
  libddcutil calls run on one thread, so they never overlap.

## Open

- Should `install.sh --check` test that koffi's native package installed (`npm ci` with
  optional dependencies)? A missing one only shows as the fallback warning on the page.
