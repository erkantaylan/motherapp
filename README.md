# motherapp

A locally served control panel for my Linux desktop: an always-running background service with a
web UI (sidebar + sections). The core is a generic manager; every feature — audio, monitor
brightness, and later logs, storage, networking — is an independent CLI tool that also works on
its own, and the manager is just a UI over them.

[DESIGN.md](DESIGN.md) is the source of truth for what is decided and what is still open.
[docs/extension-contract.md](docs/extension-contract.md) describes how to write a tool.

## Layout

| Path | What |
|---|---|
| `core/` | The manager: discovers `tools/*/manifest.json`, supervises each tool's `serve` process (crash backoff), caches state, log service, HTTP + WebSocket on `127.0.0.1:7323`. |
| `packages/protocol/` | Shared message types plus the tiny JSON-RPC / state runtime. |
| `packages/tool-sdk/` | Helper for implementing `<tool> serve`. |
| `web/` | Frontend (plain TS + Vite): sidebar shell, declarative renderer, Logs and Settings pages. |
| `tools/demo/` | Demo tool that exercises the contract. Not a real feature; disabled by default. |
| `packaging/motherapp.service` | systemd user unit. |
| `reference/audio-switch/` | The predecessor, for reference only. |

## Run

Needs **Node 24** (`node --version`).

```sh
npm install
npm run build      # builds web/ into web/dist
npm start          # core on http://127.0.0.1:7323/
npm run dev        # core (auto-restart) + Vite dev server with hot reload
npm test           # node:test, includes an end-to-end test with the demo tool
npm run typecheck
```

Config lives in `~/.config/motherapp/config.json` (created on first start: `port`, enabled
tools), state and `log.jsonl` in `~/.local/state/motherapp/`. Enable the demo tool on the
Settings page to try the widgets.

## Install

On the target machine (Ubuntu 24.04, GNOME, Wayland), from a clone of this repo:

```sh
./install.sh               # or: make install
./install.sh --check       # or: make check / npm run doctor - report only, changes nothing
./install.sh --uninstall   # or: make uninstall - stop + remove the user service (keeps config/state)
```

`make help` lists the other targets (`make purge` = `--uninstall --purge`, which also deletes
`~/.config/motherapp` and `~/.local/state/motherapp`).

The installer checks Node >= 24, the PipeWire tools (`pw-dump`, `pw-play`, `pw-record`,
`pw-metadata`, `wpctl`), the freedesktop test sounds, the PipeWire user services, `ddcutil`,
`libddcutil`, the `i2c-dev` module, `/dev/i2c-*` and `i2c` group membership. It offers to fix
what is missing and asks y/N before every `sudo`/apt step (`--yes` accepts everything). Then it
runs `npm ci` and `npm run build`, writes `~/.config/systemd/user/motherapp.service` from
`packaging/motherapp.service` (a template: real Node and repo paths are filled in), asks before
`systemctl --user enable --now motherapp`, and checks that `http://127.0.0.1:7323/` responds.
Every status line starts with `OK`, `MISSING`, `WARN`, `FAIL` or `SKIP`, the last line is
`RESULT: OK` or `RESULT: FAIL`, and the exit code is 0 only when everything required is OK.
Re-running it is safe; re-run it after moving the checkout or changing Node.
It also puts each tool's command in `~/.local/bin` (e.g. `audioctl`, a small wrapper that runs it
with that Node), for terminals and GNOME keyboard shortcuts; `--uninstall` removes them.

```sh
journalctl --user -u motherapp -f    # one JSON line per log entry
```
