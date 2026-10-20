# Flaky browser and fake-clock tests (2026-10-21, sub-agent: issue #25 fix)

`make verify` failed on the machine at `7e4182b`: the Settings drag check timed out ("the drag
moved the top row to the bottom"), and the inbox "expiry drops waiting messages" test timed out
once. Both passed in the cloud.

## Lessons

- [both] **Browser-driven tests written in the cloud must survive a different Chrome, display,
  fonts and timing.** The drag test measured the top handle, then pressed there, at whatever
  scroll the keyboard steps had left. The handle's `focus()` after End scrolls the page when it
  is taller than the viewport (the machine's fonts and a possible Version banner make it taller
  than the cloud's 912 px page in a 900 px viewport). The press then landed above the list and
  nothing dragged. Reproduced in the cloud with a 500 px viewport: the same timeout. → Before a
  real input drag: pin the viewport (`Emulation.setDeviceMetricsOverride`, scale 1), scroll the
  target into view, **assert** it fits and that `elementFromPoint` at the press point is the
  handle, move in small steps and wait after each until the page has seen it (a capture-phase
  `pointermove` probe), never fixed sleeps. Also drive the same handlers with `PointerEvent`s
  dispatched in the page, which has no input timing at all.
- [both] `setPointerCapture` throws `NotFoundError` for a pointer the browser doesn't count as
  active (a script-made event, or one released already). `startDrag` now catches it, and move/
  up/cancel are window listeners during a drag, so a drag without capture still ends on a
  release outside the list.
- [both] Cleanup race: SIGKILLing Chrome and `rmSync`-ing its profile dir right away fails now
  and then with `ENOTEMPTY` (seen with `chrome-headless-shell`). → Wait for the `exit` event,
  then `rmSync(..., { maxRetries })`. `tools/brightness/test/page-layout.test.ts` still has the
  old cleanup (it is skipped in the cloud, so I left it).
- [both] **Fake clocks: one `advance()` doesn't make a periodic job run.** The inbox service
  re-arms each job in `.finally` after its run; a run still in flight when the test advances
  arms its next timer after the advance, and with fake time that timer never fires. →
  `advanceUntil(timers, pred, what)` in `tools/inbox/test/fakes.ts` steps the clock until the
  effect shows. Also wait for state that is published after the side effect (`pending` lags
  `pane.submitted`) instead of asserting it the moment the side effect appears.
- [cloud] Checked here: Chromium 141 (`/opt/pw-browsers`), Chrome stable 155 (`npx -y
  @puppeteer/browsers install chrome@stable --path <dir>`) and chrome-headless-shell 141 (old
  headless); `MOTHERAPP_TEST_CHROME=<path>` picks one. Under 4 busy CPU loops too, for the inbox.

## Open

- The real-input drag retries once and prints `settings-layout: real mouse drag failed once,
  retrying: …` to stderr. If that line ever shows on the machine, the cause is still there: look
  at the message (which step it timed out on).
- `tools/inbox/test/real-tmux.test.ts` has one more single `advance(1000)` for the pump, after a
  100 ms real sleep; left alone since a stepping loop could make the real-tmux delivery retry
  its Enter.
