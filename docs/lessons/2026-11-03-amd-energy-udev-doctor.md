# AMD energy counter udev rule, `motherapp doctor` (2026-11-03, sub-agent on the user's machine)

Follows `2026-11-03-amd-rapl-hint.md`. Added `packaging/motherapp-energy.rules` +
`packaging/motherapp-energy-access.sh` (installed as `/etc/udev/rules.d/70-motherapp-energy.rules`
and `/usr/local/lib/motherapp/energy-access`), the AMD branch of install.sh's CPU check, and
renamed `check` / `--check` to `doctor` / `--doctor` (now offers fixes, asking before each).
Nothing was run with sudo: the user still has to run `motherapp doctor`.

## Lessons
- [both] udev `GROUP=` / `MODE=` only apply to device nodes; a sysfs attribute such as
  `energy_uj` needs `RUN+=` (the classic backlight-rule pattern). `systemd-udevd.service` on
  Ubuntu 24.04 (systemd 255) has no `ProtectSystem`/`ProtectKernelTunables`, so a RUN program
  can chgrp/chmod in /sys.
- [both] The powercap zones are class devices with uevents (`udevadm info
  /sys/class/powercap/intel-rapl:0` shows `U: powercap`, `M: intel-rapl:0`), so `%k` is the
  zone name. `KERNEL=="intel-rapl:[0-9]*"` also matches `intel-rapl:0:0`: the helper refuses
  anything that isn't `^intel-rapl(-mmio)?:[0-9]+$` with a `name` starting with `package`.
- [both] `udevadm verify FILE` (systemd >= 254) checks a rules file without root;
  `udevadm trigger --settle` waits for the RUN programs, so the installer's re-check right
  after sees the new permission.
- [both] Suspend/resume (kernel source, `drivers/powercap/intel_rapl_{common,msr}.c`): the PM
  notifier only saves/restores power limits; `rapl_cpu_down_prep` removes a package only when
  its last CPU goes offline, and CPU 0 stays online through suspend. So the zone and its file
  mode survive resume. Not tried on the machine: no suspend since the 18:59 boot, and the
  manual chmod (`-r--r----- root kappa`) was still in place at 23:31.
- [both] `motherapp install` doesn't run install.sh at all when the checkout is up to date and
  the service runs, so "run `motherapp install` and allow the X step" was a dead end even on
  Intel. Hints now say `motherapp doctor`.
- [local] `doctor` on a fresh fake machine exits 1 (no unit installed yet), like `--check` did:
  don't assert exit 0 there; assert the row isn't MISSING/FAIL. The fake energy files are
  readable by the test user, so "unreadable" needs `chmod 000` (skipped as root).
- [both] `run_installer` inherits the suite's stdin. `--check` never asked, `--doctor` does, so a
  run started with an open stdin (a background shell) hung in the first case with a missing
  Node. → `scripts/test-install.sh` now does `exec </dev/null` at the top; cases that answer
  still use `run_installer <<<"y"`.
- [local] `pkill -f scripts/test-install.sh` killed the calling shell too (exit 144), as the
  2026-10-23 lesson warned: use `pgrep` and exclude your own pid.
- [local] `make verify` failed once, unrelated: `tools/brightness/test/page-layout.test.ts`'s
  after hook got `ENOTEMPTY` from `rmSync` on `/tmp/ma-bright-layout-*` (Chrome still writing its
  profile). A rerun passed; that cleanup could retry (`maxRetries`) if it shows up again.

## Open
- On the machine: run `motherapp doctor`, answer yes, then check `ls -l
  /sys/class/powercap/intel-rapl:0/energy_uj` shows group kappa and the CPU page shows watts;
  after a reboot and after a suspend/resume, check it again.
