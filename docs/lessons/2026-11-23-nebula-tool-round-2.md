# Nebula tool, round 2: colours, copy buttons, fetch details (2026-11-23, sub-agent: implementation)

Second round on the tool in `~/Desktop/projects/nebula` (not committed there): shell syntax
colours for the script, ANSI colours for the output, two copy icon buttons, and Nebula now
records where a link was fetched from and the far side's OS. Follows
`2026-11-23-nebula-tool.md`. Nothing in this repo was changed except this file.

## Lessons

- [both] A page module may have named exports beside its default class; the shell only takes the
  default. That makes the page's pure functions testable under Node without a bundler:
  `globalThis.HTMLElement = class {}` before `await import("./page.ts")`, since the class is only
  defined at import and touches `document` only when an element is made. Node 22.6+ needs
  `--experimental-strip-types`, 23.6+ nothing. `node:test` prints `ℹ fail 0` on a terminal and
  `# fail 0` (TAP) into a pipe on Node 22: match `fail 0`, not the whole line.
- [both] The theme's `--ok`, `--warn`, `--err` and Bootstrap's `--bs-primary-fg`, `--bs-info-fg`,
  `--bs-accent-fg` are light/dark pairs meant for text, but **in light mode three of them are
  under 4.5:1 on `--bg`** (measured in Chrome: `--bs-info-fg` 3.7, `--warn` 4.0, `--ok` 4.3; all
  fine in dark). → For code colours mix them towards the text colour:
  `color-mix(in oklab, var(--ok) 72%, var(--fg))` and the like gave 5:1 or better in both
  schemes. The same trick makes colours the theme knows nothing of (256-colour and RGB escape
  codes) readable in both: `color-mix(in oklab, <colour> 50%, var(--fg))`, and a background as a
  16 % wash over transparent.
- [local] Measuring contrast in headless Chrome when computed colours are `oklch()` or
  `color-mix()`: paint the computed colour onto a 1×1 canvas (background first, then the text
  colour over it) and read the pixel back; then the usual luminance formula.
  `Emulation.setEmulatedMedia {features: [{name: "prefers-color-scheme", value: "dark"}]}`
  switches the scheme, and the theme follows it.
- [local] `Page.navigate` to the same URL with only the `#/tool/<id>` part changed does not
  reload, so a re-installed `page.ts` is not picked up and the old module keeps running (I
  measured the old colours twice before noticing). → `Page.reload {ignoreCache: true}`.
  `Emulation.setFocusEmulationEnabled` lasts only for the DevTools connection that set it; a new
  connection without it gets "could not reach the clipboard" again.
- [both] Copying something that takes several requests to fetch: `navigator.clipboard.write([new
  ClipboardItem({"text/plain": promiseOfBlob})])` called straight in the click handler keeps the
  click's permission however long the promise takes (8 MiB through 32 `view` calls took 0.4 s
  here, but nothing guarantees that). `writeText` after the awaits is the fallback, then the
  hidden textarea.
- [both] A CSS rule like `.bar span { flex: 1 1 12em }` also hits every span added to the bar
  later (the copy button's wrapper and its "Copied" text were spans). → Child selectors for
  layout rules in a page that keeps growing.
- [local] `println!` panics on a closed stdout, so `nebula motherapp install | head -1` died with
  "failed printing to stdout: Broken pipe" after the first line. Both files had been written by
  then, but only by luck of the order. The subcommand now writes with `writeln!` and ignores the
  error. (`nebula service install` still uses `println!`; not touched.)
- [local] Through a tunnel a listener on 127.0.0.1 sees only the proxy, and the visitor's address
  is whatever `CF-Connecting-IP` says, which any local process can also send. hyper's
  `HeaderValue` cannot hold control characters at all (`from_bytes` refused them in the unit
  test, so such a value never reaches a handler as a header); bytes ≥ 0x80 are allowed and
  `to_str()` fails on them, so read header bytes lossily and then parse or clean.

## Open

- Not seen in a real browser with a real click: the copy buttons (headless Chrome with focus
  emulation and granted clipboard permission only), and the colours on the user's own screen.
- The real cloudflared path was not exercised: `CF-Connecting-IP` / `CF-IPCountry` were sent by
  `curl -H` to a private daemon. Whether Cloudflare's quick tunnels always send `CF-IPCountry`
  is not known.
- The tokenizer colours `case` patterns, here-documents and `$( )` by simple rules; a script
  with a `)` inside a `case` inside `$( )` gets some colours wrong (the text is always right).
- The lessons from round 1 that are still open stay open: `-32004` for a LAN client was not seen.
