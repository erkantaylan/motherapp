# Audio master volume (2026-10-20, sub-agent: audio tool, issue #13)

Added master volume and mute for the default output and the default mic: a two-row list at the
top of the Audio page (state key `master.output` / `master.input`), the actions
`setMasterVolume` / `setMasterMute`, and `audioctl volume|mute [--input] [value]`.

## Lessons

- [both] A row that follows "the default" needs a defined state for "there is no default"
  (PipeWire restarting, a device unplugged before WirePlumber picks another). Deleting the row
  or blanking its caption would make the page jump (#12). → `refreshMaster()` in
  `tools/audio/src/service.ts` keeps the last values and marks just that row stale
  (`master.output`, not the `master` key, because `markFresh` on a child doesn't clear a stale
  ancestor). The row's caption is never empty ("No default output" before anything is known).
- [both] The master rows live in a `list` bound to `master` (sorted by an `order` field), not
  as top-level widgets. That gives a slider, a value and a mute toggle on one line, plus a
  fixed one-line caption as the row's sublabel, with no renderer change. Keep the `status`
  text below them: it comes and goes, so it must never sit above a slider.
- [both] Writes resolve the default from the model **when the coalesced write runs**, not
  when the action arrives. So the last value of a drag that outlives a default switch goes to
  the device the page shows by then. Keys `master-volume:<kind>` and `master-mute:<kind>`
  are separate, so the output and mic sliders don't queue behind each other.
- [both] `audioctl volume +N` stops at 100 unless the volume is already above 100, like
  GNOME's volume keys, so a held shortcut can't over-amplify. Absolute values still go up to
  150. With no value, `volume` prints a bare number and `mute` prints `on`/`off`, for scripts.
  Setting prints nothing. Exit codes as before: 2 for usage (checked before `pw-dump` runs),
  1 for failures such as "there is no default output right now".
- [cloud] The worktree guard refuses `python3 script.py file` for a scripted multi-edit, even
  inside the worktree. → Use the Edit tool for every source edit. Run tests from a scratchpad
  `sh` script with a unique name, since other agents share the scratchpad.
- [both] Unverified: that a sink's node `Props` `channelVolumes`/`mute` in `pw-dump --monitor`
  update when GNOME or the volume keys change the volume. WirePlumber's mixer API reads an
  ALSA node's volume through the card's `Route` param; PipeWire should mirror that into the
  node's `Props`, but nobody has checked on the machine. If the slider doesn't follow the keys
  there, read the device's `Route` props (`info.params.Route[].props`) for that node's
  `card.profile.device` instead.

## Open

- On the machine, check that the number on the slider matches `wpctl get-volume @DEFAULT_AUDIO_SINK@`
  × 100, for an analog output and for the HDMI one.
- The time from pressing a GNOME volume key to the slider moving (should be well under 1 s).
- How fast `audioctl volume +5` is from a keybinding (node startup plus one `pw-dump`). If it
  feels slow, the next step is asking the running core instead of running `pw-dump`.
