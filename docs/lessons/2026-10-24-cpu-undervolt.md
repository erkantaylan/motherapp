# CPU tool: undervolt through a sudo helper, with a crash guard (2026-10-24, main session)

The undervolt (`undervoltMV` in Intel profiles) is set by `packaging/motherapp-cpu-voltage.sh`,
installed as `/usr/local/lib/motherapp/cpu-voltage` and run with `sudo -n` under a one-path
NOPASSWD rule. `src/voltage.ts` wraps it and holds the crash guard.

## Lessons
- [local] The BIOS's "Undervolt Protection" makes MSR 0x150 writes a silent no-op: wrmsr succeeds,
  and the read back says 0 mV. Only reading back tells you, which is why the helper's `set`
  always reads back and exits 3 with the BIOS hint. On the PRIME Z690-A, turning it off (plus IA
  CEP) made −5 mV read back as −4.9 mV (that's 1/1.024 mV units; the helper rounds back to whole mV).
- [both] JS `0x7fb << 21` is a *negative* 32-bit number (−10485760), not 0xFF600000. Use
  multiplication or a literal when comparing with the bash helper's 64-bit arithmetic.
- [both] In bash, `$(( -$2 * 1024 ))` with `$2 = -50` expands to `--50`, the decrement operator, and
  fails. Copy it into a variable first (`local mv=$2; $(( -mv * 1024 ))`).
- [both] Every helper call is a sudo run, and sudo logs each one to the journal. So the offset is
  read once and cached (`Voltage.state()`), then updated from `set`'s read-back. Never read it
  in the 1 s poll.
- [both] `/etc/sudoers.d` is 0750 root, so the installer can't compare the rule file. It checks
  `sudo -n -l /usr/local/lib/motherapp/cpu-voltage` instead (allowed without a password for a
  NOPASSWD rule). The installer test's sudo stub answers `-n -l` from the fake root and doesn't
  log it, so the "no sudo" checks still mean "nothing privileged ran".
- [both] A sudoers file is installed as `motherapp-cpu-voltage.new` first (sudo skips names
  with a dot), checked with `visudo -c -q -f`, then moved into place. A broken file in
  sudoers.d can lock sudo out.
- [both] Notices that appear when a profile is applied (voltage problem, undervolt trial,
  blocked) sit *below* the Limits table, so they never move its inputs (the earlier layout-shift
  complaint).

## Open
- The mailbox's error-code check (bits 39:32 of the answer must be 0) follows the documented
  layout, but only the fake MSRs have exercised it. After `motherapp install`, run
  `sudo -n /usr/local/lib/motherapp/cpu-voltage read` on the 13900K: expect `core 0` / `cache 0`.
- [both] Follow-up to `2026-10-24-cpu-power-axis.md`'s open point: in a browser the PL band label at
  the top of the fixed power axis did collide with the "apply" event labels (both at `top: 2px`).
  It now sits at `top: 18px`, under them.
