# tmux dashboard, round 2 (2026-11-07, sub-agent: tmux dashboard)

Needs-you strip, projects with git state, sub-agent list, stale flag, scrollback. Follows
`2026-11-07-tmux-dashboard.md`. All measured on the user's real sessions (read-only) and on a
private tmux server with a real Claude.

## Lessons

- [local] Check the real data before designing. a parent folder, where 4 of the 7 sessions sit,
  isn't a repo; their transcripts' latest `cwd` says they work in a repo below it. Git on
  `pane_current_path` would have shown nothing for them. → A Claude's folder comes from its
  transcript, and a project is the git top level.
- [local] All 7 real sessions have `history_size` 0 and `alternate_on` 1: Claude's TUI uses the
  alternate screen, so `capture-pane -S` gives only the screen. A tmux-only scrollback would have
  passed every test on a shell and done nothing for the user. → Claude panes use the transcript.
- [local] `history_size` is not the test for that. A Claude started from a shell showed
  `hist=11 alt=1`: the shell's lines still count, and `capture-pane -S` returned those 11 plus
  the screen. It took a real Claude started the other way to find this. → Use `alternate_on`.
- [local] A temporary `XDG_CONFIG_HOME` also moves git's global ignore file: the test core
  counted `.claude/` as untracked and showed "1 uncommitted" where the real service shows 0. It
  looked like a cache bug. → `ln -s ~/.config/git <test config>/git`.
- [local] `page.goto()` to the URL already open, differing only after `#`, is a same-document
  navigation: the old page module stays loaded and the test runs old code. A check of a CSS value
  gave it away (`scroll-margin-top: 0px`). → `page.reload()` after changing a page. The core
  serves pages with `no-cache`, so users aren't affected.
- [both] Selecting a row clears the preview, so the page gets shorter and `scrollIntoView` stops at
  the shorter page's bottom. → Scroll once the new content has arrived.
- [both] Anything that appears above a list moves it under the pointer (contract § 4). → The strip
  shares one fixed-height line with the summary. The row's top was 139.08 px before and after.
- [cloud] A screen that fits its box has no scrollbar, so there's no `scroll` event to hook for
  "load more". → Listen for `wheel` as well, and keep a button for touch.
- [local] Claude's trust dialog defaults to "No, exit" in a git repo and to accepting otherwise, so a
  blind Enter leaves you at a shell. `strace -p` on a tool gave nothing here; logging shims first
  on PATH (`exec /usr/bin/git "$@"`) measured spawns instead: 41 `list-panes` and 7 `git status`
  over 62 s unwatched, 0 captures.

## Open

- The first-load selection of `Vpn` (see the earlier entry) never reproduced, so its cause is
  unknown. Selection no longer depends on it: only a click is remembered, as `<id>@<created>`, and
  anything else follows the first row.
- A Claude that moves to another repo moves to that group on the next poll, so rows can reorder.
  It hasn't been seen to happen often; if it's annoying, group by the first folder instead.

## UI pass

- [local] A long path should lose its start, not its end: `direction: rtl` on the box puts the
  ellipsis first, and a `<bdi>` around the text keeps the path's own order. Without the `<bdi>`
  the leading `~/` and `/` get reordered.
- [local] A state dot is only 8 px, too small to hover reliably, so `.mtx-state` adds padding with
  a matching negative margin. The tooltip opens to the left, so the list's `overflow-y` can't clip it.
