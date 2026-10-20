# Brightness sliders jump during a write, measured (2026-10-20, sub-agent: issue #12, third pass)

Issue #12 was closed twice while the sliders still moved on the machine. This time it was
measured first: real core + brightness tool, the fake `ddcutil` with `FAKE_DDC_DELAY_MS=500`,
the frontend built from the checkout, headless Chromium, `getBoundingClientRect()` of every
slider, `.control` and `.list-row` sampled every frame.

## Lessons

- [both] **Why the earlier fix (`a2083ea`) missed it:** it was checked on the `allNote` case only
  (text appearing between the sliders), not with a write in flight. The second cause only shows
  while a write is pending: `write()` published the pending value `stale: true`, the renderer
  put `.stale` on the control, and `.stale::after { content: "stale"; margin-inline-start: 6px }`
  added ~38 px of text inside the flex row. The monitor rows' controls are right-aligned, so the
  slider of the monitor being set (and, for the All slider, of every monitor) slid 38.1 px left
  for as long as the write took, then back. Measured at 1280, 900 and 700 px wide, keyboard and
  drag alike; 0 px after the fix (also at 560 px, and 0 % ↔ 100 %).
- [both] **Verify a layout fix with a write in flight**, not only with an idle page: give the fake
  a delay (`FAKE_DDC_DELAY_MS`, `FakeBackend.delayMs`) and assert you actually sampled frames
  while the dot was `setting`. `tools/brightness/test/page-layout.test.ts` does this and fails
  on the old code with "div.control.w-slider.stale moved 38.1 px".
- [both] Stale now means "we don't know the real value" (cached before a restart, a failed
  read/write), never "the user's own change is on its way"; the status dot shows that
  (docs/extension-contract.md § 2). The stale look is opacity only plus a "Not confirmed yet"
  tooltip, so it can never take space. Don't add pseudo-element text to state classes.
- [cloud] The layout test drives Chrome/Chromium over the DevTools protocol with the `ws`
  package, so the repo needs no Playwright. It looks for `MOTHERAPP_TEST_CHROME`, then
  `chromium`/`google-chrome` on PATH, then `~/.cache/ms-playwright/chromium*`, and **skips**
  when none exists (likely in a cloud container), so a passing `make verify` there doesn't prove
  this. It builds the web frontend into a temp dir with Vite (~1 s) and takes ~15 s.
- [local] Headless Chromium hides scrollbars (Playwright passes `--hide-scrollbars`); pass
  `ignoreDefaultArgs: ["--hide-scrollbars"]` to measure what a scrollbar appearing does. On
  this page, `allNote` coming and going at the bottom moved nothing above it, with or without a
  scrollbar.

## Open

- On the machine: drag both kinds of slider with the real monitors and confirm nothing moves.
  Only Chromium was measured, not Firefox.
