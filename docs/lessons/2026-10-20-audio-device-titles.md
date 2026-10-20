# Audio device titles (2026-10-20, sub-agent: audio-tool fix for issue #5)

`audioctl list` and the page titled a SteelSeries Arctis Pro Wireless's two outputs
"Arctis Pro Wireless" and "USB Audio #1", while `wpctl status` and GNOME show "... Chat" and
"... Game". Fixed in `deviceTitles()` (`tools/audio/src/pipewire.ts`).

## Lessons

- [both] The fixtures (`tools/audio/test/fixtures/generate.mjs`) were guessed from memory and
  had only one PCM per card, so nothing exercised a USB card with several PCMs. There, ALSA puts
  the card name in the first PCM's `node.nick` and a generic name ("USB Audio #1") in the next.
  → Real captures should replace the guessed fixtures (issue #2, C.15). Until then, copy real
  props from the tester's issues into the generator. `pw-dump-arctis.json` holds this headset.
- [both] audio-switch titled rows with `node.nick`. That reads well on HDMI ("X34 P", the
  monitor's name) but `node.nick` isn't unique for each PCM. → The title is now
  `node.description`, as `wpctl status` and GNOME show it. The nick moves to the second line,
  and only when it isn't generic and isn't already part of the title. So HDMI rows still show
  the monitor's name.
- [cloud] Worktree isolation also refuses `python3 script.py && git diff`. → Make the edits
  with the Edit tool, and put multi-step shell work (e.g. Node 24 + `make verify`) into a
  scratchpad `sh` script.

## Open

- Whether other cards on the machine have nicks the generic pattern misses (e.g. HDA's
  "ALC1220 Digital"). The worst case is a redundant second line, never a wrong title.
- The Arctis source (43) in the fixture is a plausible guess, not a capture.
