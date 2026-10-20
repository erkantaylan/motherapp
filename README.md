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

## Dependencies

Target: **Ubuntu 24.04, GNOME, Wayland**. `./install.sh` checks the Node, audio, brightness and
FSearch rows and offers to install what's missing (asking before every `sudo`/apt step). `tmux`,
`gsettings`/`dconf` and `cloudflared` aren't checked by the installer: a tool whose command is
missing says so on its page.

| Needed for | Dependency | Ubuntu package / source |
|---|---|---|
| Everything | **Node ≥ 24** | nvm/fnm (`nvm install 24`), or the NodeSource apt repo (`nodejs`) |
| Everything | systemd user session, `curl` | `systemd`, `curl` |
| Audio | `pw-dump`, `pw-play`, `pw-record`, `pw-metadata`, `wpctl`; PipeWire, WirePlumber and pipewire-pulse user services | `pipewire-bin`, `wireplumber` |
| Audio (L/R test) | freedesktop test sounds | `sound-theme-freedesktop` |
| Brightness | `ddcutil`, `libddcutil`, the `i2c-dev` module, `/dev/i2c-*`, membership of the `i2c` group | `ddcutil`, `libddcutil4` |
| tmux tool | `tmux` | `tmux` |
| Shortcuts tool | `gsettings`, `dconf` (GNOME) | `libglib2.0-bin`, `dconf-cli` |
| Inbox tool | `cloudflared` (quick tunnels, no account) | Cloudflare's package |
| File search (optional) | **FSearch** | its PPA, `ppa:christian-boxdoerfer/fsearch-stable` (not in Ubuntu's archive) |

Build only (installed by `npm ci`, not system-wide): TypeScript, Vite, Bootstrap 6 (pinned alpha),
Dart Sass, koffi.

## Install

On the target machine (Ubuntu 24.04, GNOME, Wayland), from a clone of this repo:

```sh
./install.sh               # or: make install
./install.sh --check       # or: make check / motherapp check - report only, changes nothing
./install.sh --uninstall   # or: make uninstall - stop + remove the user service (keeps config/state)
```

After the first install, update with **`motherapp install`** (alias `motherapp update`) from any
directory: it runs `git fetch` and `git pull --ff-only` on `main`, then `./install.sh --yes`, and
prints the old → new version, the new commits and the HTTP check. It refuses when the checkout
has local changes, isn't on `main` or has diverged (it never stashes, resets or merges), and
says "already up to date" when there is nothing new. `motherapp status` shows the service, the
running vs checkout version and each tool's state; `motherapp help` lists the rest (`version`,
`check`, `logs`, `open`, `uninstall`). Versions look like `v1-abc1234`: the number in `VERSION`
(bumped by hand), the short git hash, and `-dirty` for a build with uncommitted changes. The
sidebar footer and Settings show the running version.

`make help` lists the other targets (`make purge` = `--uninstall --purge`, which also deletes
`~/.config/motherapp` and `~/.local/state/motherapp`).

The installer checks Node >= 24, the PipeWire tools (`pw-dump`, `pw-play`, `pw-record`,
`pw-metadata`, `wpctl`), the freedesktop test sounds, the PipeWire user services, `ddcutil`,
`libddcutil`, the `i2c-dev` module, `/dev/i2c-*` and `i2c` group membership. It offers to fix
what is missing and asks y/N before every `sudo`/apt step (`--yes` accepts everything except an
install that would remove packages; add `--allow-removals` for that). FSearch is optional: it is
added from its PPA after a simulated install, and never if apt would remove anything. For Node 24 it first
offers `nvm install 24` or `fnm install 24` if you have nvm or fnm (no sudo, removes nothing; the
unit and wrappers then use that version's path under `~/.nvm`, so re-run the installer after
upgrading or removing it). Otherwise it offers the NodeSource apt repo in two steps: adding the
repo, then installing `nodejs`, after a simulation (`apt-get -s`) that lists what the install would
remove. With Ubuntu's own `nodejs` installed, that's `npm` and every `node-*` package. Then it
runs `npm ci` and `npm run build`, writes `~/.config/systemd/user/motherapp.service` from
`packaging/motherapp.service` (a template: real Node and repo paths are filled in), asks before
`systemctl --user enable --now motherapp`, and checks that `http://127.0.0.1:7323/` responds.
Every status line starts with `OK`, `MISSING`, `WARN`, `FAIL` or `SKIP`, the last line is
`RESULT: OK` or `RESULT: FAIL` (with counts of warnings and of optional steps skipped), and the exit code is 0 only when everything required is OK.
Re-running it is safe; re-run it after moving the checkout or changing Node.
It also puts each tool's command in `~/.local/bin` (e.g. `audioctl`, a small wrapper that runs it
with that Node), plus the `motherapp` command, for terminals and GNOME keyboard shortcuts;
`--uninstall` removes them.

```sh
journalctl --user -u motherapp -f    # one JSON line per log entry
```
