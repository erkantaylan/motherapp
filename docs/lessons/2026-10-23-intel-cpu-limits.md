# Intel CPU limits (2026-10-23, main session on the user's machine)

Made the CPU tool write on Intel: clock caps, turbo, governor/EPP, PL1/PL2 (`tools/cpu/src/intel.ts`),
the `useProfile` / `saveProfile` / `reapply` / `setApplyOnStart` actions, a Limits card on the
page, `cpuctl limits` / `cpuctl use`, and `motherapp-cpu-access.service` (installer step) that
grants the user's group write access to just those sysfs files at boot and resume.

## Lessons

- [local] The real i9-13900K: favoured P-cores (cpus 8-11) have `cpuinfo_max_freq` 5800000, the
  others 5500000, E-cores 4300000; `cpuinfo_min_freq` 800000. So a group's cap is the **highest**
  `scaling_max_freq` in it (writing 5800 to every P-core is "stock"; the kernel clamps the
  5500 ones). The lowest would read 5500 and look like a cap.
- [local] RAPL here: `intel-rapl:0` = `package-0` with constraint 0 `long_term` (PL1), 1
  `short_term` (PL2), 2 `peak_power`; subzones `intel-rapl:0:0` (core) and `:0:1` (uncore)
  also have a `long_term`. No `intel-rapl-mmio`. Find constraints by `constraint_N_name`, and
  only touch zones whose `name` starts with `package`. `constraint_0_max_power_uw` (125 W) is
  below the set PL1 (253 W): it is not a ceiling, don't use it as one.
- [both] intel_pstate refuses (EBUSY) a non-`performance` EPP while the governor is
  `performance`; write the governor first and skip EPP otherwise. `no_turbo=1` drops every
  core to its base clock, so stock caps can't be met then: `targetOf` drops them and the
  read-back check doesn't flag them.
- [both] Stock is snapshotted right before the first write of a boot (keyed by
  `/proc/sys/kernel/random/boot_id`), not at tool start: a tool restart after applying must not
  take the applied values for stock.
- [both] Fixture sysfs files belong to the test user, so writes "work" and access is `full`;
  the no-access path is tested with `chmod 0444` (skipped as root, where chmod doesn't block).
- [local] The headless Playwright MCP saves screenshots relative to the repo root
  (`./intel-1280.png`) and leaves `.playwright-mcp/`: delete both before committing.
- [local] `scripts/test-install.sh` takes about 3 minutes here; run it in the background (the
  2-minute Bash timeout cut the first run). `--check` on a fresh fake machine exits 1 (nothing
  installed yet), so don't assert exit 0 there.

## Open

- Nothing has written to the real sysfs yet: this session had no sudo. After `motherapp install`
  (say yes to "CPU limits access") check on the machine that `cpuctl limits` says writable,
  that `cpuctl use underclock` sticks (PL1/PL2 read back 125/188; a BIOS lock would show as
  "reads … after writing"), and that the values survive suspend/resume (the BIOS may reset
  RAPL limits on resume; the page would show drift, and Re-apply fixes it, but nothing
  re-applies automatically).
- Undervolting (MSR 0x150, needs the BIOS undervolt protection off) and ratio overclocking are
  not done; AMD is still read-only (SMU step).
- Firefox not checked; phone width shows the Limits table scrolling inside its card.
