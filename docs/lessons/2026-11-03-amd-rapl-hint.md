# AMD package-power hint is a dead end (2026-11-03, main session on the user's machine)

User asked what the CPU page's "Package power needs read access to the RAPL energy counter: run
`motherapp install` and allow the "CPU limits" step." means, saying motherapp is already latest.

## Lessons
- [local] The machine is a Ryzen 9 3900X. AMD Zen 2 exposes `/sys/class/powercap/intel-rapl:0`
  (`package-0`, plus `intel-rapl:0:0` = `core`) with `energy_uj` (`-r--------` root) but **no**
  `constraint_*` files. So `src/power.ts` finds the zone and fails with EACCES.
- [both] `install.sh` gates the whole CPU access step on `cpu_is_intel` (GenuineIntel), so on AMD
  it records "not an Intel CPU … nothing to set up" and never offers the unit. The page's hint
  (`NO_ENERGY_ACCESS` in `tools/cpu/src/power.ts`) sends the user to a step that doesn't exist on
  their machine. `motherapp-cpu-access.service` was not installed.
- [both] "Already on the latest version" doesn't matter for anything the installer does with
  sudo: updates don't install or refresh system units.
- [both] Dropping the Intel gate isn't a fix as-is: the helper also grants g+w on cpufreq
  `scaling_max_freq` / governor / EPP / `boost`, which exist under amd_pstate too, and that breaks
  "AMD stays read-only". An AMD path should grant only `g+r` on package `energy_uj`.

## Open
- The user hasn't decided on the fix (an AMD-only energy-read mode for the unit, or changing the hint).
- Workaround until reboot: `sudo chgrp kappa /sys/class/powercap/intel-rapl:0/energy_uj && sudo chmod g+r /sys/class/powercap/intel-rapl:0/energy_uj`.
