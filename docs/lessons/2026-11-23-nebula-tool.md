# Nebula tool, built in the nebula repo (2026-11-23, sub-agent: implementation)

The tool from DESIGN.md § 3 "Nebula tool" now exists in `~/Desktop/projects/nebula` (not
committed there): `nebula motherapp serve | install | uninstall`, the manifest and page sources in
its `motherapp/` folder, embedded in the binary. Nothing in this repo was changed except this
file. Follows `2026-11-23-nebula-investigation.md`.

## Lessons

- [both] A tool in another language needs very little of the protocol. The whole tool side is:
  answer `describe`, `state.get`, `action`, `stream.open`/`stream.close`; send `state`, `log`,
  `notify`; ignore `watch` and anything else without an id; exit when stdin closes. The Rust
  version is about 100 lines (`src/motherapp/rpc.rs` in nebula). What had to be copied from
  `packages/protocol/src/rpc.ts` rather than guessed: only a number or string `id` makes a
  request (an `id: null` message is a notification and gets no reply), a batch array is handled
  element by element, an unparseable line goes to stderr and is not answered, and a missing
  result is `null`.
- [both] The SDK drops the state changes made before `serve()`, so the core never sees a `state`
  notification ahead of the `describe` reply. → A hand-written tool should do its first read
  before it reads stdin and publish nothing for it.
- [local] An absolute path as `serve[0]` works as documented (`resolveCommand` resolves a command
  with a `/` against the tool dir, and an absolute path stays itself). Extra arguments in the
  array are the way to hand a setting to a tool, since the manifest has no `env`:
  `nebula motherapp install` adds `--home <NEBULA_HOME>` when that variable is set at install time.
- [local] A private core for trying an external tool, checked on this machine:
  `XDG_CONFIG_HOME=<tmp> XDG_STATE_HOME=<tmp> MOTHERAPP_PORT=17391 MOTHERAPP_TOOLS_DIR=<tmp>/tools
  MOTHERAPP_EXTERNAL_TOOLS_DIR=off MOTHERAPP_NOTIFY=off MOTHERAPP_TRAY=off
  MOTHERAPP_RELEASE_URL=off /usr/bin/node core/src/main.ts` from the checkout. Without
  `XDG_STATE_HOME` its log lines go into the user's real `log.jsonl`; without
  `MOTHERAPP_EXTERNAL_TOOLS_DIR=off` (or the temp `XDG_CONFIG_HOME`) it would also load the
  user's own external tools. `/usr/bin/node` is Node 24 here; the shell's `node` is 22.
- [local] No Playwright in this repo, but `/usr/bin/google-chrome` drives fine headless:
  `google-chrome --headless=new --user-data-dir=<tmp> --remote-debugging-port=<port> about:blank`,
  then the DevTools protocol over the repo's own `ws` package (`Runtime.evaluate`,
  `Page.captureScreenshot`, `Emulation.setDeviceMetricsOverride` for a phone width). The page
  route is `/#/tool/<id>`. `navigator.clipboard.writeText` is rejected in it until
  `Emulation.setFocusEmulationEnabled {enabled: true}` and `Browser.grantPermissions` for the
  origin; that rejection says nothing about a real browser.
- [local] `pkill -f "<words from my own command line>"` kills the shell that runs it, because the
  pattern is in that shell's own arguments. → Find the pid by its listening port
  (`ss -ltnp | grep :<port>`) and `kill` that.
- [both] A custom page may only use erasable TypeScript, and "one self-contained file" is easy to
  check before a browser sees it: `tsc -p` with `erasableSyntaxOnly`, `verbatimModuleSyntax` and
  `paths` for `@motherapp/protocol` and `@motherapp/protocol/page` pointing into this checkout,
  and `module.stripTypeScriptTypes(source)` on Node 24.
- [both] A button made with `ctx.render` and a `confirm` shows the shell's dialog with "Cancel"
  beside the widget's own label. A widget labelled "Cancel run" gives a dialog with "Cancel" and
  "Cancel run". → Don't start such a label with the bare word; the page says "Cancel this run".
- [both] `ctx.render` buttons give no access to the action's result, only the status dot. Text
  the user must read before acting (what cancelling does not stop) therefore went into the
  `confirm` text, not into a message after the fact.
- [local] Of the two points left open in the investigation entry: reading while a run writes
  output works (seen with a local `nebula go` run appending every second beside a running
  daemon; an upload over HTTP from a remote machine was not tried). A read-only SQLite connection with no statement open does not hold up
  `PRAGMA wal_checkpoint(TRUNCATE)`; there is a test for it in nebula's `src/db.rs`. A database
  from another Nebula version is reported as `db: "error"` with the old runs marked stale; it was
  tried with a file that is no database at all, not with a real older schema.

## Open

- The "Local network" switch was not turned on for the test, so the core refusing `view` and
  `oneLiner` with `-32004` for a LAN client, and the page's fallback for it (list and states only,
  a note instead of the output), were not seen working. With the switch off a request under a
  non-localhost `Host` is refused whole (HTTP 403), which is all that could be observed.
- Discovery of `~/.config/motherapp/tools/nebula/` by the user's real service was not tried (the
  rule was not to touch it): `nebula motherapp install` has only been run against a temp folder
  given to a private core through `MOTHERAPP_TOOLS_DIR`.
- A desktop popup and its sound were not seen (`MOTHERAPP_NOTIFY=off`); the notifications did
  arrive in the core's history and on the bell. The manifest's default sounds (`complete`,
  `dialog-warning`) exist in `/usr/share/sounds/freedesktop/stereo` here, but nobody has heard
  whether they suit.
- DESIGN.md § 3 "Nebula tool" still says "not built" and lists the serve-mode-in-Rust part as
  "proposed, not yet accepted"; the main session should update the row.
- The tool publishes the newest 100 runs (plus all open ones). Whether the history needs paging
  or a search is undecided.
