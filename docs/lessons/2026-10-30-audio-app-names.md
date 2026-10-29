# Audio app names (2026-10-30, sub-agent: audio routes + app names, local machine)

Discord's voice output showed as "WEBRTC VoiceEngine" in Apps (GNOME does the same). Rows now
group by process binary and skip generic library names (`appDisplayName` in
`tools/audio/src/pipewire.ts`, desktop entry lookup in `src/desktop.ts`).

## Lessons
- [local] Real Discord stream props (in `test/fixtures/pw-dump-real.json`): output 84
  `application.name` "WEBRTC VoiceEngine", binary "Discord", `media.name` "playStream"; input
  123 same name, "recStream"; input 104 `application.name` "discord_capture", `media.name`
  "game capture". Only `Stream/Output/Audio` is an app row, so `discord_capture` never was one.
- [local] Spotify's **stream node has no `application.process.*`**; its Client object (via
  `client.id`) does. `buildView` now falls back to the client's props.
- [both] Mapping a binary to a desktop entry by `Exec` alone is wrong for launchers: every
  Steam game shortcut runs `steam steam://rungameid/…`, so "steam" mapped to "ARK: Survival
  Evolved". → File id and `StartupWMClass` first; an `Exec` program only when one entry name
  uses it.
- [both] Firefox plays from several content processes with one binary (`firefox-bin`), so
  grouping by pid would split it. Grouping is by binary, not pid.

## Open
- Whether the systemd user service sees snap/flatpak `XDG_DATA_DIRS`; the snap and flatpak
  export dirs are added explicitly, so it shouldn't matter.
