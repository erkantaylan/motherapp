# CPU page: fixed 30–250 W power axis (2026-10-24, sub-agent for the Live rail)

The user wanted the Live rail's "Package power" chart on a static Y axis instead of
`axisRange`. Now `W_AXIS_LO`/`W_AXIS_HI` (30/250) in `tools/cpu/page.ts`, grid every 50 W
(labels 50, 100, 150, 200: the grid loop skips the axis ends). Clock and temperature still
auto-range.

## Lessons
- [both] `plot()`'s polyline already clamps each sample with `Math.min(b, Math.max(a, val))`,
  so a fixed axis needs no change there: idle below 30 W and spikes above 250 W ride the edge.
  Only the HTML overlays (grid lines, the PL band) use `top(val)` unclamped, so clamp what you
  pass to them.
- [both] Stock PL1 = PL2 = 253 W sits above the fixed top. The band's edges are clamped at the
  call site (the label keeps the real numbers), and because its label normally sits *above*
  the band (`bottom: 100%`), a band touching the top of the power axis moves the label inside
  (`top: 2px`), or it would spill onto the chart's heading.

## Open
- Not looked at in a browser: check the band label at the top-right doesn't collide with an
  event marker label near "now" (those also sit at `top: 2px`, right-aligned when x > 70 %).
