# CPU tool: Overclock = 253 W + undervolt defaults (2026-10-24, main session)

The user picked an undervolt-based overclock over raising ratios. `defaultIntelSettings()` now
gives Overclock `pl1W: 253, pl2W: 253, undervoltMV: -25`. Their existing cpu.json was edited by
hand to match (only the overclock profile; the active profile stayed Underclock).

## Lessons
- [local] The installed helper answers on the real 13900K: `sudo -n /usr/local/lib/motherapp/cpu-voltage read`
  printed `core 0` / `cache 0`, so the mailbox error check (bits 39:32 = 0) holds on real hardware.
  This closes the open point in `2026-10-24-cpu-undervolt.md`.
- [both] Several tests used the empty default Overclock profile to test "nothing set yet". With
  defaults in it, empty it first (`saveProfile` with `values: {}`) instead of relying on the defaults.
- [both] Without a voltage helper (tests, `cpuctl` on a fixture), a profile's `undervoltMV` is
  silently left out: no helper means no undervolt row (`presentKeys`), so the rest still applies.
- [local] `motherapp install` stops at "already up to date" and doesn't run the installer, so a
  new installer step (like "CPU undervolt") never comes up for an up-to-date checkout. Run
  `./install.sh` in a terminal for it, and not through Claude Code's `!`, because sudo needs a TTY.
  This is still a gap in `scripts/motherapp.sh`.
