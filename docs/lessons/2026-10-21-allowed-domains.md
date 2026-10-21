# Host names, the Local network switch and trusted networks (2026-10-21, sub-agent)

Started as an "Allowed domains" list on Settings; the user replaced it twice while it was being
built. What landed: `*.localhost` accepted (Settings toggle, `localhostSubdomains`, on by
default), and a **Local network** switch (`lan.enabled`, off) that opens the core to
private/link-local sources only on a network the user trusted (NetworkManager connection UUID +
gateway MAC, `lan.trusted`). No domain list of any kind remains. Code: `core/src/access.ts`
(pure rules), `core/src/netIdentity.ts` (nmcli/ip), `core/src/lan.ts` (listeners, monitor),
Settings → Network (`web/src/networkView.ts` holds the DOM-free logic).

## Lessons

- [both] **A `0.0.0.0` (or `::`) bind on the core's port fails with `EADDRINUSE` while
  `127.0.0.1` is bound** (checked on Node 24, Linux). Closing the loopback listener to make room
  would leave a gap and could lose the port. → The LAN side is one extra `http.Server` per
  non-loopback interface address with the same handlers, re-synced on every network check.
  `reusePort` would avoid it but silently lets a second core share the port.
- [cloud] The container has **no IPv6 at all** (`listen("::")` gives `EAFNOSUPPORT`) and its only
  non-loopback address is `192.0.2.2` (TEST-NET-1, so "public"). → Listener tests bind a fake
  interface at `127.0.0.2` (any 127/8 address works on Linux loopback) and pick the client's
  source with `localAddress`. The real-interface test asserts "served iff the address is
  private/link-local", so it passes here (refused) and on the machine (served).
- [cloud] Tests that pass a hand-made fake `Manager` to `startServer` (`core/test/updater.test.ts`,
  `version.test.ts`) **hung `make verify` for 10+ minutes** once the server called a new Manager
  method on every request: the request handler threw and the client waited forever. → When
  adding a Manager method that server.ts calls, grep `fakeManager` and extend the fakes.
- [both] `net.BlockList.check("::ffff:192.168.1.5", "ipv6")` matches an IPv4 subnet rule, but
  `access.ts` strips the `::ffff:` prefix and the `%zone` itself anyway, so the classifier
  doesn't depend on that.
- [both] Changing settings needs a loopback **source** and a localhost **Host** (and Origin).
  Through a LAN listener the source isn't loopback; through a local relay (portgate is fine, it
  uses `*.localhost`) the Host would give it away. A tab whose name stops being accepted (LAN
  closed, `*.localhost` turned off) is disconnected, and its reconnect gets the 403.
- [cloud] The worktree guard refused a `bash script.sh > log; grep …` chain. → Put the logging
  and the grep inside the scratch script (`ah-a21e-verify.sh`) and run just `bash <script>`.

## Open (check on the machine)

- `nmcli -t -f NAME,UUID,DEVICE,TYPE connection show --active` and `ip neigh show <gw> dev <dev>`
  output there; the parsers were written from memory (fixtures in `core/test/network.test.ts`).
- Whether `nmcli monitor` prints a line on a cable unplug / Wi-Fi switch (else the 30 s re-check
  catches it), and that it stops with the switch off.
- IPv6 link-local binds (`fe80::…%<iface>`) were never tried: no IPv6 in the container. A failed
  bind is logged once as a warn and skipped.
- A phone on the trusted network opening `http://<machine IP>:7323`; the same phone refused after
  "Remove"; a lookalike network (same name, other router) staying closed.
