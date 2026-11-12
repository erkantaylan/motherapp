# Tool strip, notification panel, Settings UI (2026-11-10, sub-agent: notifications stage 2 of 3)

The web page now has a tool strip on the right edge with a bell, a notification panel that docks
beside the page, and Settings sections "Notifications" and "Desktop" (DESIGN.md § 3 "Tool strip
and notification panel"). Code: `web/src/toolStrip.ts`, `notifyPanel.ts`, `notifications.ts`,
`trayText.ts`, `pages/settings.ts`. Follows `2026-11-10-notification-service.md` and
`2026-11-10-tray-icon.md`.

## Lessons

- [both] **Anything that takes width from the page can break a page that pairs `@media` with
  `@container`.** The tmux page hides the document's scrollbar from a 1100 px *window* and goes
  two-column from 820 px of *its own* width, which only agree while the shell's chrome is the
  220 px sidebar. A first strip of 40 px left it 816 px wide at 1104 px: one column, 1338 px
  tall, and `overflow-y: hidden`, so the rest couldn't be reached. → The strip is 32 px (820 px
  exactly at 1100) and the panel docks only from 1480 px, where the page is still as wide as at
  1100 px without it. `$dock-min` in `styles.scss` and `DOCK_MIN_PX` in `toolStrip.ts` must
  agree. If the strip or panel ever grows, measure `.mtx` at 1100 px again, or make the tmux
  page pick its layout from one signal.
- [local] A private core started from a shell inside tmux inherits `TMUX`, and tmux then uses
  that socket whatever `TMUX_TMPDIR` says: the test core listed the user's real sessions and
  their screens. → `env -u TMUX -u TMUX_PANE` in front, besides `TMUX_TMPDIR=<short dir>`,
  `MOTHERAPP_NOTIFY=off` and `MOTHERAPP_TRAY=off`. Kill the private tmux server afterwards.
- [both] With `scrollbar-gutter` reserved, `documentElement.clientWidth` is the window's width
  while `body` is 15 px narrower, so "the strip is at the right edge" compared with
  `clientWidth` fails (1585 of 1600). → Compare with `.shell`'s right edge. A `position: fixed;
  inset: 0` panel also ends at the gutter.
- [both] `▶` in a button came out as a colour emoji in headless Chrome (a blue box). → An inline
  SVG triangle. The bell is an SVG for the same reason.
- [both] To drop the page's WebSocket in a CDP test: `Page.addScriptToEvaluateOnNewDocument`
  with a `WebSocket` subclass that records its instances, then `__sockets.at(-1).close()`. The
  page reconnects by itself after 500 ms.
- [both] `cdp.send("Page.navigate")` to the same URL with another `#` keeps the old document
  (as `page.goto` in the tmux round-2 entry). `Cdp.load()` in `web/test/browser.ts` goes
  through `about:blank` first.
- [both] `notifications.previewSound` answers without an error on a core with `delivery` false
  and plays nothing. The play button is disabled there, or its green dot would claim a sound.
- [both] Settings rows are updated in place and rebuilt only when the tools, kinds or sounds
  change: the core pushes `notifications.settings` after the user's own change too, and a
  rebuild would take the focus from the switch just used.
- [local] Playwright's own Chromium (`~/.cache/ms-playwright/chromium-1234`) can't start here
  without `--no-sandbox` ("No usable sandbox", AppArmor user namespaces), so
  `MOTHERAPP_TEST_CHROME=<that>` fails both browser tests at "browser DevTools endpoint".
  `/usr/bin/google-chrome` works and is what the tests find.

## Open

- Not seen on a real phone or in Firefox; the three widths were checked in headless Chrome only.
- The badge counts by the core's timestamps: two notifications in the same millisecond, one
  seen and one not, would count as both seen.
- The sound preview's "this computer" is judged by the page's address (`isLocalPage`), not by
  the core. A page opened on the desktop itself through its LAN address gets no play button.
- `web/test/browser.ts` holds the core + Chrome harness for new browser tests;
  `settings-layout.test.ts` still has its own copy.
- GNOME's own switches (Settings → Notifications → motherapp) apply on top of these and are
  not mentioned in the page.
