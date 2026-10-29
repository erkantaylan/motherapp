# Audio outputs = routes, not nodes (2026-10-30, sub-agent: audio routes, local machine)

User report: a Bluetooth headset showed one output where GNOME shows two; then GNOME 8 outputs,
motherapp 4. A card only has nodes for its active profile. GNOME lists every port (route,
`EnumRoute` on the Device object) whose `available` isn't "no". Built that in
`tools/audio/src/pipewire.ts` (`readCard`, `routeTarget`, `routeNode`) and `src/select.ts`.

## Lessons
- [local] **Real fixtures now exist**: `tools/audio/test/fixtures/pw-dump-real.json` (a full
  `pw-dump` of the machine, machine-id and the BT address scrubbed) and
  `pw-dump-real-to-hfp.txt` (the `pw-dump --monitor` batches right after
  `wpctl set-profile 148 261`). Use them for anything about cards, profiles or routes instead of
  `generate.mjs`, whose Device objects have empty `EnumRoute`.
- [both] A profile switch **removes the old nodes first, then** sends the Device with the new
  `Profile`, then the new nodes, and **ids get reused** (A2DP sink 98 → HFP source 98, HFP sink
  129). So "wait for a node id we haven't seen" is wrong; wait for "card's Profile is in the
  route's `profiles` and a node with that `card.profile.device` exists".
- [both] `EnumProfile.classes` differs by API: ALSA `[count, [cls, n, "card.profile.devices", [ids]], …]`,
  bluez5 the same without the leading count. `profileDevices()` handles both.
- [both] bluez5's `Route[].profile` is an internal number (2) that isn't an EnumProfile index;
  use the Device's `Profile` param, not that field.
- [local] A one-shot `pw-dump` taken while a card switches prints **several JSON arrays** (the
  dump, then updates). `JSON.parse` fails with "Unexpected non-whitespace character after
  JSON". `readView` in `cli.ts` now runs it through `JsonStreamParser` and applies every array.
- [local] wpctl 0.4.17 has no `set-route`. `pw-cli set-param <card> Route '{ index: 5, device: 11, save: true }'`
  works (tried with the already-active route, a no-op).
- [local] Measured: switching the JBL A2DP ↔ HFP from the page took 50–80 ms to the action
  reply, from `audioctl set-default` 250–300 ms. WirePlumber restores the default by node name,
  and the HFP sink has the same name as the A2DP one.
- [local] zsh doesn't word-split `$A` (`A="node x.ts"; $A list` → "no such file or directory").
  Use a shell function.

## Open
- The ALSA cases (Line Out on the Starship card, HDMI 1 on the GA102, the HyperX speakers, the
  S/PDIF inputs) weren't switched live: the user's audio was on those cards. Check one: the
  chosen profile (e.g. Starship → 1 "Analog Stereo Duplex"), that the mic node survives, and
  whether `pw-cli` set-route is ever needed after the switch.
- GNOME titles the active ports "<port> – <card>" too; motherapp keeps `deviceTitles` for rows
  that have a node (coordinator's call), so active and inactive rows of one card read differently.
