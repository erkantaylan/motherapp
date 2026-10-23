# CPU page live column, package power (2026-10-23, main session on the user's machine)

User (1920×1080) asked for current watts and a heat graph on the right. Added the manifest's
`wide` field (core + web: `.content.content-wide`, 1600 px), a sticky "Live" column on the CPU
page (tiles + power/temp/clock charts), and package power from RAPL `energy_uj`
(`tools/cpu/src/power.ts`). The access unit now also grants read on package `energy_uj`.

## Lessons

- [both] Every tool page sat in a 960 px `.content` column: a page can't use a wide screen
  without the host's help. `mountToolPage` gets the `.content` element itself as `root`, so it
  toggles `content-wide` there and removes it on unmount.
- [both] Two-column-when-wide without duplicating the card: `.mcpu-main { display: contents }`
  on narrow pages (its children become grid items, so `order` can put the rail between the
  console and the collapsed sections), `display: grid` in a `@container (min-width: 1240px)`
  query on a wrapper (`.mcpu-cq`, `container-type: inline-size`). The query has to be on a
  wrapper: an element can't query its own size.
- [local] `/sys/class/powercap/intel-rapl:0/energy_uj` is `-r--------` root on this kernel;
  `max_energy_range_uj` is world-readable. Reset the meter when the page starts being watched,
  or the first number averages the whole unwatched gap.
- [local] The Playwright MCP refuses screenshot paths outside the repo; write them to
  `.playwright-mcp/` and delete that before committing. `pkill -f <pattern>` killed the
  calling shell too (its own command line matched): find pids with `pgrep` and exclude it.

## Open

- The user's machine needs `motherapp install` again (the helper changed; the installer offers
  the update) before package power shows; until then the Live column says why it's missing.
- Not checked in Firefox (container queries are supported there since 110).

## Addendum: layout shift when switching profiles (same day)

- [both] The Limits header added the "Active" badge only to the active column, so its height
  went 34 → 38 px on every switch, and the first switch also added a result line to the
  toolbar (+31 px). Measure, don't eyeball: click through Stock/Underclock in the browser and
  record the header height and the first input's page Y (`getBoundingClientRect().top +
  scrollY`) after each click. Fixes: the badge is always rendered and toggled with
  `visibility`; a success is a one-line, non-wrapping status beside the switch (`flex: 1 1 0;
  min-width: 0`), and only problems get their own line.
- [local] The headless browser kept the old `page.ts` module after a code change although the
  core serves it `no-cache`: a module already imported in that document stays. Navigate to a
  new URL (`/?r=2#/tool/cpu`) to load the new one.
