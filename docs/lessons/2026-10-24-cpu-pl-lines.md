# CPU page: PL1/PL2 as dashed lines, unlabelled event markers (2026-10-24, sub-agent for the Live rail)

The PL band and its text on the power chart covered the grid labels. Now `plot()` takes an
optional `lines` list (`[value, title][]`) drawn as `.mcpu-lim` (1px dashed, accent mixed 60 %
into `--bg`), one per limit, a single line when PL1 = PL2. The clock chart's target band is
unchanged. Event markers (`.mcpu-mk`) lost their visible text on all plots (only the power plot
had one); the `title` hover hint stays. Supersedes the band/label notes in
`2026-10-24-cpu-power-axis.md`.

## Lessons
- [both] Plot overlays are absolutely positioned siblings with no z-index, so DOM order is the
  stacking order: the limit lines are pushed into `kids` before the grid lines, and the grid
  labels' `background: var(--bg)` paints over them. No z-index needed.
- [both] A `title` on a 1px line is nearly impossible to hover; `.mcpu-lim::before` adds an
  invisible 8px-tall hit area (hovering a pseudo-element shows the host element's title).
- [both] The power-only band-label shift (`field === "w" && band[1] >= b`) and the
  `.mcpu-mk span` CSS were removed as dead code.

## Open
- Not looked at in a browser (the user's running app serves the installed build): check the
  line colour reads in both themes and that a line clamped to 250 W at the plot's top edge is
  visible against the chart's top.
