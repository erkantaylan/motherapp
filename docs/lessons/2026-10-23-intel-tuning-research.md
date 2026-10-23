# Intel tuning research (2026-10-23, main session on the user's machine)

User asked why Intel XTU on Windows refused to tune with virtualization on, and whether that
blocks over/underclocking here. Research only, no code. Findings are in DESIGN.md Q20.

## Lessons

- [local] This checkout's machine is an **i9-13900K**, not the 3900X the earlier CPU lessons
  were written on. Don't assume the Ryzen-only parts of the CPU tool are what the user sees.
- [both] Hyper-V/VBS (Windows) and KVM (Linux) are different shapes: under Hyper-V the Windows
  kernel is a guest and MSR writes are filtered; KVM leaves the host kernel on bare metal. So
  "virtualization on" is not a blocker on Linux. Check `/sys/kernel/security/lockdown`,
  `mokutil --sb-state` and the BIOS undervolt/OC lock instead.
- [local] Reading MSR 0x150 / 0x610 lock bits needs root (`/dev/cpu/*/msr` is 0600 root);
  this session didn't use sudo, so whether Undervolt Protection is on is unknown.

## Open

- Undervolt Protection state, RAPL lock bit (MSR 0x610 bit 63), turbo ratio lock: need
  `sudo rdmsr` (msr-tools isn't checked) on the machine.
