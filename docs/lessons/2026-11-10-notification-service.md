# Notification service in the core (2026-11-10, sub-agent: notifications stage 1 of 3)

The core now delivers every tool's notifications (`core/src/notifications.ts`,
`core/src/notifyDelivery.ts`); the tmux tool only says when (`tool.notify`). This overrides the
`MOTHERAPP_TMUX_NOTIFY` parts of `2026-11-07-tmux-dashboard.md`: that variable and
`tools/tmux/src/notify.ts` are gone, the switch is `MOTHERAPP_NOTIFY=off` on the core.

## Lessons

- [local] The `desktop-entry` hint works on GNOME Shell 46 (Wayland): after one popup sent with
  `notify-send -a motherapp -h string:desktop-entry:motherapp`, `gsettings get
  org.gnome.desktop.notifications application-children` had `'motherapp'` and
  `…/application/motherapp/ application-id` was `'motherapp.desktop'`. Without the desktop file
  the same popup is filed under no application at all.
- [local] The shell needs a moment to see a new desktop file. A popup sent within a second of
  writing `~/.local/share/applications/motherapp.desktop` was shown but not attributed (no entry
  in `application-children`); the next one, about a minute later, was. → After a first install,
  don't judge the attribution by the first popup. No `update-desktop-database` was needed.
- [local] `~/.local/share/icons/hicolor/` has an `icon-theme.cache` on this machine, so an icon
  copied there isn't found by name until the cache is rebuilt. → The desktop entry's `Icon=` is
  the absolute path of the installed copy, and the core passes `web/public/icon.png` by path to
  `notify-send -i`. Nothing depends on the icon name `motherapp`.
- [both] A core started by a test must not reach the desktop. → `deliveryEnabled()` is false
  under `node --test` (`NODE_TEST_CONTEXT`, inherited by the cores the tests spawn) unless
  `MOTHERAPP_NOTIFY=on`, the same trick `main.ts` uses for the release check. A test file run
  as plain `node x.test.ts` doesn't set it, so the two e2e tests that could notify
  (`core/test/e2e.test.ts`, `tools/tmux/test/e2e.test.ts`) also pass `MOTHERAPP_NOTIFY=off`.
  A private core started by hand needs `MOTHERAPP_NOTIFY=off` in its environment.
- [both] Kinds live in the manifest, not in `describe`/`createTool`: Settings has to list them
  for a tool that is stopped or disabled, and the core validates them once at discovery. A bad
  `notifications` entry makes the whole manifest invalid (the tool is skipped, with a log line).
- [both] `scripts/test-install.sh` copies a hand-picked list of files into its fake repos. A
  new `packaging/` template or anything else `install.sh` reads must be added to `new_case`
  there, or the installer under test silently takes its "missing" branch.
- [both] An optional row in `--doctor` still counts as a warning in `RESULT:`, so adding the
  desktop entry and icon rows changed the count one existing case pins (`bin-no-node`).
- [both] gdbus takes each argument as GVariant text: a newline inside a quoted string has to be
  written `\n`, and the hints dict is `{'desktop-entry': <'motherapp'>}`.

## Open

- The gdbus fallback was only unit-tested (argument shape); `notify-send` is installed here.
- Sound: one real `pw-play …/bell.oga` was played through the real delivery class; the popup
  and the sound were not checked through a whole running core, only through its classes, the
  unit tests and the e2e tests (which run with delivery off).
- `notifications.previewSound` plays on the computer the core runs on, also for a LAN client
  (all-or-none). If the Settings UI wants the phone to hear it, that needs a different design.
- Whether GNOME's own per-app switches (Settings → Notifications → motherapp) should be
  mentioned in the Settings UI: they apply on top of motherapp's.
