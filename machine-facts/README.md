# Target machine facts (2026-10-19)

Answers to the "To confirm on the machine" block in DESIGN.md § 6. Full verbatim output is in
[`raw-output.txt`](raw-output.txt), produced by [`collect.sh`](collect.sh). That script is
read-only and can be re-run any time.

## Summary

| Question | Answer |
|---|---|
| OS | **Ubuntu 24.04.5 LTS**, GNOME Shell 46.0, **Wayland** session. The 24.04 assumption in Q9/Q14 holds. |
| WirePlumber | **0.4.17** (`wireplumber` / `libwireplumber-0.4-0` 0.4.17-1ubuntu4.1). `wpctl` has no `--version` flag, so the version comes from dpkg. |
| PipeWire | **1.0.5** (`pipewire`, `pipewire-pulse` 1.0.5-1ubuntu3.3). |
| pipewire-pulse running? | **Yes.** `pipewire-pulse.socket` and `pipewire-pulse` are active, and the socket `/run/user/1000/pulse/native` exists. `pactl` is **not installed** (`pulseaudio-utils` is not installed but available in apt, candidate 1:16.1+dfsg1-2ubuntu10.1), so "Server Name" couldn't be read. The socket being up is what a pulse-protocol client needs. |
| WirePlumber typelib | **Not installed.** No `Wp-*.typelib` (and no `Gvc`) under `girepository-1.0`. `gir1.2-wp-0.4` is available in apt (candidate 0.4.17-1ubuntu4.1). There's no 0.5 package. |
| ddcutil | **1.4.1** (1.4.1-1build2). `libddcutil` is not installed. |
| Runtimes | **Node v22.23.2**, **Bun 1.3.14**, GJS 1.80.2. Deno is **not installed**. |

## DDC/CI measurements

Both monitors answer DDC/CI and report brightness (VCP 0x10) on a 0–100 scale:

| Bus | Connector | Monitor | Brightness now | `getvcp 10 --bus N` |
|---|---|---|---|---|
| `/dev/i2c-1` | DP-1 | MSI G274QPF (2560×1440) | 48 / 100 | ~0.52 s |
| `/dev/i2c-3` | DP-2 | Acer X34 P (3440×1440, primary) | 52 / 100 | ~0.54 s |

- `ddcutil detect --brief` takes about **1.0 s** (measured twice).
- A single read with `--bus` already skipping detection still takes **~0.5 s** on ddcutil 1.4.1.
  This is the slow end of the range DESIGN.md assumed. Debouncing, one call at a time per
  monitor, and caching the bus are required, not optional.
- `setvcp` wasn't timed, to avoid changing the brightness. Expect it to be similar to or slower
  than a read.
