# Per-tool "On the network" switch (2026-11-23, sub-agent: per-tool network availability)

Settings → Tools has an "On the network" switch per tool (config.json `tools.<id>.network:
false`, `tool.setOnNetwork`, `ToolInfo.onNetwork`). Off: the tool doesn't exist for a LAN
client. DESIGN.md § 3 "Network switch scope" and § 4.3 have the rules; code in
`core/src/server.ts` (`Client.sees`), `core/src/toolVisibility.ts`, `manager.ts`.

## Lessons

- [both] **`127.0.0.2` is a localhost name** (`isLocalhostName` takes all of 127/8), so a browser
  at `http://127.0.0.2:<port>/` is "this computer", not a LAN client. The in-process tests get a
  LAN client by sending another Host header (`kappa.local`) to 127.0.0.2, which a browser can't
  do. → For a browser as a LAN client, open the machine's own private address (the tmux
  dashboard entry's method); a `--host-resolver-rules` mapping would also work but wasn't needed.
- [both] **A spawned core can be made to "trust the current network" without a real one:** put
  stand-in `ip` and `nmcli` shell scripts first on its PATH (`ip route …` → one default route,
  anything else → a neighbour line with the MAC; `nmcli monitor` → `exec sleep 600`, otherwise
  one `NAME:UUID:DEVICE:TYPE` line) and write a matching `lan.trusted` entry. The core then
  listens on the machine's real addresses. `web/test/tool-network.test.ts` does this, and
  `startSite` in `web/test/browser.ts` now takes `{ config, env }` and returns `newPage()` for
  a second tab. The LAN half skips itself on a machine without a private IPv4 address.
- [both] **"Hide X from some clients" is mostly about the lists nobody thinks of.** The tool's
  own messages were the easy part. The leaks were the core's own log lines that list every id
  ("discovered N tool(s)" with `fields.tools`, "tool order changed" with `fields.order`), the
  `limit` of a backlog (filter first, then take the newest N, or a LAN client gets fewer),
  "Reset to default order" (it would move a tool the client can't see), and error texts: a
  hidden tool must get the very answer an unknown id gets (`-32003` for actions, but `-32602`
  from the notification settings, and the type checks must still come first), and the
  "only from this computer" refusal must come before the id is looked at.
- [both] **Dropping the connection is the simplest correct "apply at once".** No message takes a
  notification or a log line back, and the page's reconnect already rebuilds the tool list,
  snapshots, the notification history (the backlog replaces the list), the settings and the
  logs page. The first version of the tests used `ws.once("close")` to wait for it, and a
  mutation that removed the drop made `node --test` hang for good: there is no default test
  timeout. → Wait with `waitFor(() => ws.readyState === CLOSED)`.
- [both] **Two page bugs only a vanishing tool shows** (a tool never left the list before): the
  tool page kept the old widgets under "Unknown tool." (`toolPage.ts` returned early without
  clearing the body), and the logs page kept the gone tool in its filter. Both fixed. Seen in a
  browser, not by a test that only read the sidebar.
- [both] Mutation-check new "must not leak" tests: after writing them, break each filter in
  turn and see a test fail. One didn't (the `sees` check on stream pushes): a LAN client can't
  hold a stream on a hidden tool, because hiding drops its connection. It stays as a second lock.
- [both] The fake Managers in `core/test/version.test.ts` and `updater.test.ts` list "just what
  the server touches". A new Manager method the server calls on connect breaks them with
  "x is not a function" → add it there (`isOnNetwork`).
- [local] A background shell command that outlives its 120 s limit keeps running, including the
  file edits later in the same command line. A mutation loop that hung had to be stopped by
  hand before the source was restored. → One mutation per command, each under `timeout`.
- [local] Settings at 1280 px has a horizontal scrollbar on this machine with the LAN open: the
  "Reachable at" line lists every Docker bridge and IPv6 address without wrapping. It was there
  before this change (same on a page without the new column). Not fixed here.

## Open

- The live service was not restarted, so the real core doesn't have the setting yet; until it
  is, the rebuilt frontend simply shows no switch (the field is absent).
- What another tool says about a hidden one in its own state isn't filtered: the shortcuts tool
  lists the `commands` of the tools in `tools/`.
- An action a LAN client has in flight on another tool fails with "disconnected" when the user
  flips any tool's switch. If that ever matters, the change needs per-client corrections
  instead of the drop (and a way to take back notifications and log lines already shown).
- Not seen on a real second device or in Firefox: the LAN side was a headless Chrome on this
  machine opening its own LAN address.
