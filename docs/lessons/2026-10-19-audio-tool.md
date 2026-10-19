# Audio tool (2026-10-19, sub-agent: audio tool builder)

Built `tools/audio/` (`audioctl`) in a cloud container with no PipeWire. Everything below the
command line was tested against hand-written fixtures and fake binaries, never a real graph.

## Lessons

- [cloud] There is no PipeWire here, so nothing about real `pw-dump` output could be checked. →
  Every spawn goes through an injectable `Runner` (`tools/audio/src/runner.ts`). Tests use
  `FakeRunner`, and the end-to-end test puts shell wrappers for `pw-dump`/`wpctl`/`pw-play`/
  `pw-record` first on PATH (`tools/audio/test/fake-pipewire.ts`). Copy this pattern for
  brightness (`ddcutil`).
- [cloud] The fixtures (`tools/audio/test/fixtures/`) come from `generate.mjs`, written from
  what I know of PipeWire 1.0 shapes. They were **not captured on the machine**. → The first
  local run should save a real `pw-dump > dump.json` and a short `pw-dump --monitor` capture
  (plug in headphones, play and stop a Firefox tab), and compare them to the fixtures. If they
  differ, fix the generator and the tests.
- [both] Assumptions about `pw-dump` that the code depends on, none of them verified here:
  - a removal in `--monitor` is `{ "id": N, "info": null }`;
  - a node update repeats the whole `info.props` and each `info.params.<Name>` (the model
    replaces those keys and keeps the rest, so partial updates work too);
  - a metadata update lists only the changed entries, and `value: null` deletes one. The
    model merges entries by (subject, key). If pw-dump actually sends the full list, a removed
    key is kept, but an unknown default name just shows "no default";
  - the `default` metadata's `default.audio.sink`/`.source` value is `{ "name": "<node.name>" }`
    (a JSON string is accepted too);
  - metadata objects have `props` at the top level, not under `info`;
  - with stdout on a pipe there are no colours (`NO_COLOR=1` is set as well).
- [both] Volume scale: `channelVolumes` in pw-dump are **linear**, and `wpctl` shows and sets the
  **cube root**. The UI shows `round(cbrt(avg(channelVolumes)) * 100)` and sets
  `wpctl set-volume <id> <percent/100>`. Whether WirePlumber 0.4's mixer averages the channels
  or takes the max is unverified; it only matters for unbalanced channels.
- [cloud] Worktree-isolated agents get compound shell commands refused (`$VAR` in `sed`/`export`,
  `cd && …` with complex tails, inline `python3 - <<EOF`). → Use the Edit tool for edits, and for
  multi-step shell checks write a small script into the scratchpad and run `sh script.sh`.
- [cloud] SDK quirk: if a `tool.stream` handler throws, the stream name stays registered as
  open, so later `stream.open` calls for it silently do nothing. → Stream handlers should log
  and return instead of throwing (the audio tool does). Worth fixing in the SDK.
- [cloud] The SDK calls `process.exit(0)` right after SIGTERM, so code after `await serving`
  doesn't run on a normal stop. → Kill child processes from a `process.on("exit")` handler
  (`RealRunner` does that), otherwise `pw-dump --monitor` lives on until its next write.

## Open

- Real `pw-dump` shapes on PipeWire 1.0.5 / WirePlumber 0.4.17 (see above).
- Whether Firefox, with several tabs playing, shows up as one `application.name` ("Firefox") on
  every stream.
- Which `media.role` GNOME's event sounds actually carry on the machine (the code skips `event`
  and `Notification`, case-insensitively).
- `pw-play --target <node.name>` and `pw-record --target <node.name> … -` behave as they did in
  audio-switch (assumed, since audio-switch used exactly these).
- `audioctl` isn't on PATH after install; keybindings need `tools/audio/audioctl.ts` by full path
  (or a symlink into `~/.local/bin`).
