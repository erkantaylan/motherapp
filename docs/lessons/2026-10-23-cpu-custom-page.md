# CPU tool custom page, vendor detection (2026-10-23, sub-agent on the user's machine: CPU page v2)

Replaced the CPU tool's declarative page with `tools/cpu/page.ts` (Die map + Tuning console +
a disabled Stock | Underclock | Overclock selector), moved the page's shared logic into the
import-free `src/view.ts`, added a capped `events` list to the service, and (a mid-task
requirement) vendor detection: title "CPU - AMD" / "CPU - Intel", AMD-only parts hidden
elsewhere, Intel coretemp / no_turbo / hybrid P-/E-cores, no cpu.json on non-Ryzen CPUs.

## Lessons

- [both] **The sidebar title came from the manifest only**, never from `describe`
  (`core/src/manager.ts` `info()`). Now `host.describe?.title || m.title`; all other tools'
  describe titles equal their manifest titles, so nothing else changed. A tool that wants a
  runtime title must set it in `createTool({ title })` before `serve()`.
- [both] Arrays in tool state work (`events`, `cores.N.threads`), but `diffState` replaces an
  array whole, so keep arrays short. State can't hold `null`: "stock" is a missing
  `profiles.active`, an unset profile value a missing field; `diffState` deletes the key when
  it goes away.
- [both] Re-reading cpu.json every tick while watched (a few hundred bytes) is simpler than
  mtime checks and makes edits show up live; the service compares a JSON key of
  settings + problems and only publishes, logs or records events when it changed. A broken
  file reads as "both unset", so it must not be diffed against the last good settings, or a
  typo logs "active profile now Stock".
- [local] Real 3900X `topology/core_id`: 0,1,2 | 4,5,6 | 8,9,10 | 12,13,14. The stride between
  CCXs (4) gives the slot count per CCX (`slots`), so the page can say "3 of 4 active" without
  guessing which slot is fused off. `amd_pstate_lowest_nonlinear_freq` = 1727728 (what idle
  threads read), `cpuinfo_min_freq` = 575910; the heat scale starts at the former.
- [both] On an Intel hybrid, E-cores' `scaling_max_freq` is below the P-cores' max: the old
  "lowest scaling_max < highest cpuinfo_max = capped" rule would report "capped at 3900 MHz".
  A cap is now a thread held below **its own** `cpuinfo_max_freq`. Differing max clocks are
  not used to detect hybrids either (Turbo Boost Max 3.0 favoured cores differ too); only
  `/sys/devices/cpu_core/cpus` + `cpu_atom/cpus`.
- [local] Playwright `fullPage` screenshots break `position: fixed` bottom sheets (the viewport
  is stretched to the page height, so the sheet lands mid-page, open-looking). For a phone
  view, scroll and take viewport screenshots (`scratchpad/cpu-page-v2/phone.mjs`). Also
  `pointerleave` fired during the fullPage capture and cleared a hover readout; check hover
  state with `page.textContent` instead of trusting the picture.
- [both] Layout-shift check that caught a real problem: hovering the I/O die put 8 rows in the
  details panel (502 px) next to a 446 px map, pushing the console down 58 px. Measure the
  panel's `scrollHeight` per selection at 1280/1000/800 px; trimmed the I/O die rows so every
  selection fits the panel's `min-height`.
- [local] Live check as in the 2026-10-22 entry: three scratch cores (7399 real `/`, 7398 an
  Intel hybrid fixture tree, 7397 a Ryzen 5 3600 tree, written with `writeTree` from
  `test/fixtures.ts`), stopped by matching `XDG_CONFIG_HOME` in `/proc/<pid>/environ`. The
  user's service (PID unchanged) was never restarted.

## Open

- Nothing was checked in Firefox, or on the real Intel machine: the Intel support is fixture
  based (an i9-12900K shape). Check there that coretemp labels match `core_id` (assumed),
  that `cpu_core`/`cpu_atom` exist, and the title reads "CPU - Intel".
- The user's running service still has the old declarative page until it restarts (or
  `motherapp install`); then the sidebar says "CPU - AMD".
- A cpu.json with 4 CCX values on a 2-CCX Ryzen shows CCX3/CCX4 rows in the profile cards (the
  file's own values); the model's detail line notes the mismatch, the page doesn't yet.
- Applying profiles (SMU), reading which core slot is fused off, Vcore/PPT: later steps.
