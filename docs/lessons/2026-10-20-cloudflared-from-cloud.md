# cloudflared quick tunnels from a cloud session (2026-10-20, main session, issue #11 step 1)

## Lessons

- [cloud] You **can't host** a cloudflared tunnel from the cloud container. The download works
  (`github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64`,
  version 2026.10.2), and `cloudflared tunnel --url …` even prints a `*.trycloudflare.com` URL. But
  it never registers a connection: its precheck fails on DNS SRV lookups
  (`_v2-origintunneld._tcp.argotunnel.com` via `8.8.8.8:53: no such host`), on raw UDP/TCP to
  `region{1,2}.v2.argotunnel.com`, and on `api.cloudflare.com`. The container only has HTTPS through
  the agent proxy, with no direct DNS, UDP or TCP. → Never plan to run a tunnel endpoint in a cloud
  session.
- [cloud] Normal HTTPS to Cloudflare works through the proxy (`www.cloudflare.com` 200,
  `api.trycloudflare.com` 405 to a GET, which is reachable). A `*.trycloudflare.com` hostname with
  no live tunnel behind it fails as `CONNECT tunnel failed, response 502` (curl exit 56, code 000),
  most likely because the name doesn't resolve. → From the cloud you can't tell "blocked" apart from
  "no tunnel". The only conclusive test is a tunnel that's live on the user's machine, curled from
  the cloud session.
- [cloud] To test egress, compare a known-good host (`example.com`), the service's API host and the
  target host in one loop. Check `curl -sS "$HTTPS_PROXY/__agentproxy/status"` for the proxy's
  `noProxy` list and recent failures.

## Open

- Whether a cloud agent can reach a quick tunnel running on the user's machine. That needs a
  throwaway tunnel there and a `curl` from a cloud session (see issue #11).
