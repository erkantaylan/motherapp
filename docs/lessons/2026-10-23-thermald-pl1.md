# thermald overrides PL1 (2026-10-23, main session on the user's machine)

User saw "Changed outside this profile: PL1 253 W (wanted 125 W)" although Underclock applied.
PL2 held. Cause: `thermald --systemd --dbus-enable --adaptive` (Ubuntu's default unit).

## Lessons

- [local] Measured by writing 125 W to `constraint_0_power_limit_uw` and polling every 250 ms
  (a `node -e` loop; `bc` isn't installed and a bash `read -t` loop on /dev/zero didn't wait):
  125 W -> 99.5 W at 25.5 s -> 253 W at 26.5 s, then the 99.5/253 flip every 15-20 s. PL2
  (`constraint_1`) was never touched. `journalctl -u thermald` showed nothing: it doesn't log
  these writes.
- [both] When a value "doesn't stick", watch the sysfs file over a minute before blaming the
  write path; the apply log here showed every write succeeding.
- [local] `scripts/test-install.sh` must run with `</dev/null` from an agent shell: run
  through the harness, stdin is an open socket, and the shortcuts `--uninstall` case's `ask`
  waits on it forever. An earlier run sat there for over an hour unnoticed.
- [local] In this session's zsh, `$(( 0x8000001000000000 | ... ))` truncates ("number
  truncated after 15 digits"); bash handles the 64-bit MSR values. Test MSR arithmetic with
  `bash -c`.

## Open

- thermald is turned off only after the user runs `motherapp install` and says yes.
- Undervolting: the probe (run with sudo by the user) read back 0 mV after writing −5 mV, OC
  lock bit 0: ASUS PRIME Z690-A BIOS 4505 has Undervolt Protection on. The user turns it off in
  the BIOS, then re-runs the probe; build the helper only after it reads back −4.9 mV. The probe
  is in the session scratchpad; move it into the helper as `cpu-voltage probe` when building.
