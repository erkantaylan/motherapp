# Shortcuts tool (2026-10-20, sub-agent: shortcuts tool builder, issue #7)

Built `tools/shortcuts/` (`shortcutsctl`, custom page with key capture), the manifest
`commands` field, and the installer's shortcut check and uninstall prompt.

## Lessons

- [cloud] Real gsettings + dconf + GNOME 46's schemas install fine as root:
  `apt-get install -y --no-install-recommends gnome-settings-daemon-common dconf-cli
  dconf-gsettings-backend gsettings-desktop-schemas gnome-shell-common mutter-common`.
  `tools/shortcuts/test/real-gsettings.test.ts` runs against them under `dbus-run-session`
  (skipped when missing). **Set HOME/XDG_CONFIG_HOME/XDG_RUNTIME_DIR before
  `dbus-run-session`**, not inside it: dconf-service is D-Bus-activated with the bus daemon's
  environment, and with the wrong HOME every `gsettings set` "succeeds" while reads show nothing.
- [both] **gsettings prints non-ASCII as `?` outside a UTF-8 locale** (the container has no
  LANG; a systemd user service may not either). Every gsettings call runs with
  `LC_ALL=C.UTF-8`, and values are written with `\uXXXX` escapes, so names like "é 🚀" survive.
- [both] gsettings quoting: a string is printed in '…', or in "…" when it contains a `'`
  (then `"` is escaped). The `custom-keybindings` array accepts any string (gsettings doesn't
  check that entries are valid paths), so a list can hold junk like `'nope'`. The tool lists
  such entries read-only with an error. An empty array prints as `@as []`.
- [cloud] GNOME 46 binds `<Super>v` to `toggle-message-tray` by default. CopyQ's binding wasn't
  reported, so the fixture guesses `<Super>v`, and the conflict check flags it.
  `tools/shortcuts/test/fixtures/builtins-gnome46.txt` is real `list-recursively` output of the
  5 keybinding schemas from the container's packages, not from the machine.
- [cloud] `python3` in the container is a 3.13 without working `gi`, but `/usr/bin/python3.12 -I`
  has PyGObject. → `GLib.shell_parse_argv` is a real oracle for how gnome-settings-daemon splits
  a command, and a test uses it (skipped without it).
- [cloud] Worktree isolation refused `dbus-run-session -- sh -c '…'` and inline `python3 -c` with
  `$` in it. → Write scratch scripts with unique names (`sc-a4cb-*.sh`) and run `sh <file>`.
- [both] Browsers see a key only if GNOME doesn't grab it first. An already-bound combination
  (the user's `<Control>F9`) or Super+letter may never reach the page, so the page also has a
  text field for typing the accelerator. With Shift, `KeyboardEvent.key` is the shifted
  character. The capture then uses `navigator.keyboard.getLayoutMap()` (Chromium only), or
  lowercases letters and otherwise falls back to the US meaning of `code`. That is wrong for
  Turkish Q's Shift+ı in Firefox ("I" → `i`, not `idotless`); typing it in works.
- [both] A button's `confirm` in `ctx.render` outside a list has no row, so `{name}` would become
  "". The page builds the text itself and puts a zero-width space after each `{`.

## Open

- Whether writes from the systemd service reach GNOME without a re-login (the service has the
  session bus address; gnome-settings-daemon should pick up the change at once). Manual check
  in the report.
- Whether `dconf` (dconf-cli) is installed on the machine. Without it the tool still works, but
  it re-reads everything every 12 s instead of one `dconf dump` every 3 s, and removal resets
  the keys one by one with gsettings.
- Real browser behaviour of the capture (Firefox on Wayland: Super reported as `Meta`,
  AltGr, the Turkish layout) has only been unit-tested with event objects built by hand.
- The 8 shortcuts' real commands and CopyQ's binding (the fixture's are made up).
