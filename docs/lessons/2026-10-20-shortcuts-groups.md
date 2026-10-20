# Shortcuts in groups (2026-10-20, sub-agent: shortcuts groups, issue #19)

Added `tools/shortcuts/src/groups.ts` (browser-safe, shared by the page and `shortcutsctl list`),
collapsible groups on the page, an optional Group field (`group` arg on the `add`/`edit` actions,
`--group` on the CLI), `list --flat`, and `group` in `list --json`. Refers to
`2026-10-20-shortcuts-tool.md`.

## Lessons

- [both] The rules run in order and a shortcut takes the **first rule that yields a group of 2+**
  (or a group of that name that already exists): name prefix before `": "`, then (motherapp's
  own only) the tool from the wrapper's name, then the same program path. So a lone
  `"Audio: mute mic"` falls through into the Audio tool group and shows as "mute mic" there.
  Two different programs with the same file name get "run.sh (/usr/bin)" for the second.
  Launchers (`env`, `flatpak`, `xdg-open`, `sh` without `-c`, …) never group by program, or
  every Flatpak app would land in "flatpak".
- [both] The page needs each `bin` command's tool title to group by tool, so the service now
  publishes a `binTools` state key (`{ audioctl: "Audio", … }`) read from the manifests.
- [both] The page's `kbd` key labels were **invisible** (white on white, dark on dark) since the
  Bootstrap 6 restyle: Bootstrap's reboot sets `kbd` `color`, and `.msc kbd` only overrode the
  background. Fixed with `color: var(--fg)`. → When a custom page overrides a reboot-styled
  element's background, override its color too, and look at a screenshot.
- [cloud] A CSS-rotated "▸" caret looked crooked in headless Chromium. Swapping the text
  ("▸"/"▾") is simpler and needs no reduced-motion rule.
- [cloud] Worktree isolation refused `cat >> file <<'EOF'` with `${…}` inside, and Python
  heredocs with backticks. → Write the edit script with the Write tool into the scratchpad and
  run `python3 <file>`; append test cases with the Edit tool.
- [cloud] `tools/shortcuts/test/fakes.ts` has `MACHINE_19`: the 8 shortcuts with the names and
  bindings from #19 (segments and commands still made up). `machineStore(entries)` takes it. The
  old `MACHINE` (names like `dc-map-fit`, CopyQ on `<Super>v`) stays: it covers the
  same-program rule and the toggle-message-tray conflict.

## Open

- On the machine: whether the real Dead Cells commands all call one script (the fixture
  assumes `~/.local/bin/dc-map`); it doesn't matter for grouping, since the prefix wins.
- Firefox: the `<datalist>` suggestions on the Group field, and Enter/Space on the group headers.
