# tmux details card collapse (2026-11-24, sub-agent: tmux dashboard)

The details card on the tmux page has a toggle in its header; the choice is kept in
`localStorage` (`motherapp.tmux.detailsCollapsed`). Follows `2026-11-07-tmux-dashboard-round-2.md`.

## Lessons

- [both] Measure what "frees room" before promising it. In the wide layout the preview is a fixed
  `56vh` and the details card sits below the send box, in a column that scrolls: at 1400x900 only
  15 px of the card were on screen. Collapsed, the column becomes a flex column and the preview
  grows into what is left, 504 → 540 px there. The visible gain is that the column no longer
  scrolls, not a much bigger preview. Stacked, the preview is as tall as its text (cap `60vh`), so
  collapsing only shortens the page.
- [both] A layout rule for a state, such as `.mtx-main[data-details="collapsed"] { display: flex }`,
  has the same specificity as the page's `.mtx-main[hidden] { display: none }` and comes later, so
  it would show a hidden element. → Add `:not([hidden])` to any rule that sets `display`.
- [both] A box that shrinks keeps its `scrollTop` and fires no `scroll` event, so a live preview
  that was at its bottom is silently no longer there. → After the toggle, set `scrollTop` to the
  bottom when the page is following; leave it alone when the user has scrolled up.
- [both] On a phone, collapsing while scrolled to the page's bottom moves the toggle: the page got
  shorter and the browser clamps the scroll (toggle top 226 → 792 px in the run). Nothing above
  the card moves otherwise. Not worked around.
- [both] `Page.addScriptToEvaluateOnNewDocument` does nothing over CDP until `Page.enable` was sent,
  and it reports no error: the "no storage" check ran against working storage. → Send `Page.enable`
  first, and assert in the page that the stand-in took effect. Overriding `window.localStorage`
  was not needed: making `Storage.prototype.getItem`/`setItem` throw is enough.
- [both] A browser test for a tool page can use `web/test/browser.ts` (`startSite`) from
  `tools/<id>/test/` with the tool's fake command first on PATH; `tools/tmux/test/fake-tmux.ts`
  now prints `$FAKE_TMUX_DIR/screen.txt` for `capture-pane` when it exists, for a screen taller
  than its box.
- [local] To see Claude's rows without a real Claude: write `<CLAUDE_CONFIG_DIR>/sessions/<pane
  pid>.json` (`pid`, `sessionId`, `status: "idle"`, `name`, `startedAt`, `version`) for the pane's
  shell and a transcript `projects/p/<sessionId>.jsonl` with `ai-title`, `last-prompt` and an
  `assistant` record. Appending an `assistant` record makes the details refresh on demand.
- [local] `motherapp.tmux.picked` survives between runs in one browser profile: a check that waits
  for the first session's screen hangs after an earlier step clicked another row. → Clear it too.

## Open

- Not looked at in a real phone browser or with touch, only headless Chrome at 390x844.
- A real Claude session wasn't used: the Claude rows came from stand-in files.
