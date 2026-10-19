# audio-switch

A small GTK4/libadwaita window for PipeWire: click a device to make it the default output or input,
and test it right there.

- **Output rows** — click to make it the default sink (`wpctl set-default`); playing streams follow
  unless an app pinned its own device. ▶ plays the freedesktop left/right channel sounds on *that*
  device, default or not.
- **Input rows** — click to make it the default source. 🎙 toggles a live level meter;
  ⏺ records 3 s and plays it back on the default output.
- The list re-reads `pw-dump` every 2 s, so plugged/unplugged devices show up on their own.

## Requirements

PipeWire + WirePlumber (`wpctl`, `pw-dump`, `pw-play`, `pw-record`), Python 3 with PyGObject,
GTK 4 and libadwaita ≥ 1.4. All present on stock Ubuntu GNOME.

## Run / install

```sh
./audio-switch.py
# launcher entry:
cp audio-switch.desktop ~/.local/share/applications/
```

`Exec=` in the `.desktop` file is an absolute path under `/home/kappa` — fix it on another machine.
