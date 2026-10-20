# Settings rows: fixed columns, no up/down buttons (2026-10-21, sub-agent: Settings UI fix)

User feedback from the machine: the disabled Demo row (no Restart button) had its switch and the
old up/down buttons in different places from every other row; and "we don't need up/down since
we have drag/drop". The up/down buttons from `2026-10-20-tool-order.md` are gone: the ⠿ handle is
now a `button` ("Move <tool>", described by "Use arrow keys to move") and ArrowUp/ArrowDown/
Home/End on it move the row (`keyMove` in `web/src/reorder.ts`). `focusTarget` was removed.

## Lessons

- [both] **Per-row flex layouts can't align columns**: a row missing a button shifts everything
  after it (measured: the switch 80.9 px off on the old build). → The list is one CSS grid with
  named columns (`[handle] [labels] [enabled] [restart] [dot]`) and every row is
  `grid-template-columns: subgrid`, so all rows share the tracks and a hidden Restart just leaves
  its cell empty. Subgrid also accounts for the list-group-item padding. Needs Chrome 117 /
  Firefox 71. Below 560 px the name takes the first line and the controls a second, still in
  their columns.
- [cloud] A focusable handle that also starts pointer drags: `pointerdown` with
  `preventDefault()` still focuses a `button` in Chromium, which is harmless. The key handler
  ignores keys while a drag runs and calls `preventDefault()` at the ends too, so the arrows
  never scroll the page instead.
- [cloud] `web/test/settings-layout.test.ts` checks the alignment (handle, switch, Restart, dot
  lefts equal within 0.5 px at 1280 and 390 px), the keys and a mouse drag, over raw CDP like
  `tools/brightness/test/page-layout.test.ts`. It builds a temp tools dir (demo + core fixtures
  `crash`, `ok`, `custom`) with `node_modules` symlinked next to it so the copies resolve
  `@motherapp/tool-sdk`; a symlinked tool dir would not work (the core skips non-directory
  dirents). It finds `$PLAYWRIGHT_BROWSERS_PATH/chromium-*/chrome-linux/chrome` and passes
  `--no-sandbox` when run as root; the brightness test does neither, so it skips in this container.
- [cloud] The Bash tool in a worktree-isolated agent refuses commands with computed values
  before `node`/`npm` (`PATH=$D:$PATH make verify`, `$W/...`). → Use literal paths
  (`env PATH=/root/.npm/_npx/<hash>/node_modules/node/bin:/usr/bin:/bin make verify`) or put
  the steps in a script in the scratchpad and run `bash script.sh`.

## Open

- On the machine: Tab to a handle (focus ring), arrows move the row and Orca reads "… moved to
  position N of M"; the columns line up with Demo off and on, in a narrow window too; Firefox's
  subgrid layout.
