# Poll only while watched (2026-10-21, sub-agent: demand-driven polling)

The core now counts viewers per tool (a tab showing the tool's page while visible) and sends the
tool `watch {watching}` on edges: 0→1 at once, 1→0 after 5 s. tmux, shortcuts, brightness's
2-minute re-read, the inbox's pane list and the demo poll only while watched and refresh at once
when watching starts. Browser side: `tool.watch {tool | null}` from `web/src/watch.ts`.

## Lessons

- [both] **The inbox wasn't idle**: besides its 1 s queue pump (in-process, nothing spawned when
  the queue is empty), it ran `tmux list-panes` every 3 s for the page's pane list. Delivery and
  `create` list the panes themselves, so that loop now runs only while watched too. → Before
  saying a tool "does nothing", grep its service for `every(`/`setInterval`/`setTimeout` loops
  that spawn.
- [both] A CLI that answers from the core's cached state goes stale once its tool stops polling
  unwatched. `brightctl list` read the snapshot and `inboxctl panes` read `state.panes`. → Both
  now call an action that reads (`list`, `panes`). Any new CLI that goes through the core must
  do the same for data the tool polls.
- [both] Unwatched polled values are marked stale (tmux `sessions`, shortcuts `shortcuts`, inbox
  `panes`), so a page that opens on cached state shows them dimmed until the immediate refresh.
  A publish path that sets only "if changed" must also set when the path is stale, or an
  unchanged list never turns fresh again (the inbox's `pollPanes` had that bug). Brightness
  values aren't marked stale on unwatch: they come from our own writes and confirm reads.
- [cloud] `assert.deepEqual(x, [])` narrows `x` to `never[]` in TypeScript, so a later
  `x.slice(…).filter((c) => c.startsWith(…))` fails `make verify`'s typecheck (TS2339) although
  the test runs. → Use `assert.equal(x.length, 0)` when the array is used afterwards.
- [cloud] `ToolHost.restart()` leaves `status === "running"` until the old process exits, so
  `waitFor(() => host.status === "running")` right after it passes at once. → Wait for
  `host.pid` to change as well.
- [cloud] For brightness, `t.mock.timers.enable({ apis: ["setInterval"] })` fakes only the poll
  interval while the fake backend's `sleep` (setTimeout) stays real. Let the reads' queues
  settle (a short real sleep) before the next `tick`, or the poll skips a busy monitor.
- [cloud] Playwright check (scratch, not committed): headless Chromium doesn't hide a tab on its
  own; redefine `document.visibilityState` with `Object.defineProperty` and dispatch
  `visibilitychange` to exercise the wiring. Result with the real core and a fake tmux: 0 tmux
  calls over 9 s with no page / on Logs, 1 call at once on opening the tmux page, `unwatched`
  ~5 s after hiding, 0 calls after that, an immediate call when shown again, `unwatched` 5 s
  after closing the tab.

## Open

- On the machine: with no page open, `strace -f -e trace=execve -p <core pid>` (or
  `sudo execsnoop`) for 30 s should show no `tmux`/`gsettings`/`dconf`/`ddcutil` spawns, only
  audio's long-running `pw-dump --monitor` from before. Then open the tmux page (an immediate
  list), switch tabs (stops ~5 s later), and run `tmuxctl list`, `shortcutsctl list`,
  `brightctl list` / `get` with the page closed (all fresh).
- Firefox: that `visibilitychange` fires on a tab switch and on minimizing the window under
  GNOME (Chromium was only simulated). A window that is merely covered by another stays
  "visible" by the API's rules, so it keeps polling.
- `dconf watch` as an event source for the shortcuts page (instead of the 3 s dump while
  watched) wasn't tried.
