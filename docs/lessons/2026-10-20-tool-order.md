# Tool order on Settings (2026-10-20, sub-agent: issue #20)

The sidebar follows a user-set order: drag handles and up/down buttons on Settings, "Reset to
default order" behind the in-page confirm, saved as `order` in `config.json`. Merge rules are in
`core/src/toolOrder.ts`, the browser side's DOM-free model in `web/src/reorder.ts`.

## Lessons

- [both] The core sends `tools` **already sorted**, so the sidebar, the default route and
  `/api/status` all follow the order with no client logic, and every tab updates from the
  existing broadcast (`manager.emit("tools")`). Keep display order in the core.
- [both] `saveConfig` used to write the normalized `Config`, which silently **dropped every key
  the core didn't know** and replaced a broken file with defaults on the next toggle. Writes now
  go through `updateConfigFile` (read raw, patch, temp + rename). A file that isn't a JSON object
  is never overwritten: the switch or the move fails with "Not saved: … fix or delete it". That
  also changes `tool.setEnabled` on a broken file (it used to overwrite it).
- [cloud] **Pointer capture on the dragged row breaks** once `KeyedList` moves that row's node
  (a moved node loses capture, so the drag ended after one step). → Capture on the list container
  (`rowsEl.setPointerCapture`), which never moves, and listen there. Moving a node can also drop
  the focus, so `sync()` puts it back (on the other arrow when the pressed one became disabled).
- [cloud] Touch drag in headless Chromium: `newContext({ hasTouch: true })` plus CDP
  `Input.dispatchTouchEvent` (touchStart/touchMove/touchEnd) produces real pointer events;
  `touch-action: none` on the handle keeps the page from scrolling instead.
- [cloud] `tools/tmux/test/e2e.test.ts` was flaky (about 1 in 5 locally, and under `make verify`):
  the inbox tool, enabled by default, also runs `tmux list-panes` against the same fake tmux, and
  the test asserted every call was `list-sessions`. → The test now disables every other tool in
  its config. Any e2e test that runs the real `tools/` dir should do the same.
- [cloud] A Playwright check that two tabs follow each other: one context, two pages, a core on
  `MOTHERAPP_PORT=0` with a temp `XDG_CONFIG_HOME`; reorder in page A, `waitForFunction` on page
  B's `.nav-tools .nav-label` order. Scripts stayed in the scratchpad, not committed.

## Open

- On the machine: drag with a real mouse and on a touchscreen (if any), Firefox's pointer
  capture on the list, and whether Orca reads "… moved to position N of M" once per move.
