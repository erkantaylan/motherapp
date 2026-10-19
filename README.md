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

## Install as a user service

```sh
cp packaging/motherapp.service ~/.config/systemd/user/
# edit ExecStart/WorkingDirectory: path to Node 24 and to this checkout
systemctl --user daemon-reload
systemctl --user enable --now motherapp
journalctl --user -u motherapp -f    # one JSON line per log entry
```
