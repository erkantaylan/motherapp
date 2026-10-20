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

Target: **Ubuntu 24.04, GNOME, Wayland**. `./install.sh` checks the Node, audio and brightness
rows and offers to install what's missing (asking before every `sudo`/apt step). `tmux`,
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

Build only (installed by `npm ci`, not system-wide): TypeScript, Vite, Bootstrap 6 (pinned alpha),
Dart Sass, koffi.

## Install

One line, on the target machine (Ubuntu 24.04, GNOME, Wayland), as your own user (not root):

```sh
bash -c "$(curl -fsSL https://raw.githubusercontent.com/erkantaylan/motherapp/main/scripts/get.sh)"
```

It needs `git` and `curl` (`sudo apt-get install git curl`). It clones the repo into
`~/.local/share/motherapp`, or into `MOTHERAPP_DIR` if you set it
(`MOTHERAPP_DIR=~/src/motherapp bash -c "$(curl …)"`), and runs `./install.sh` there with its
normal y/N prompts. This form keeps your terminal as stdin, so the prompts work; `curl … | bash`
would answer every one with "no". If that folder is already a motherapp clone, it runs
`motherapp install` there (an update) instead. If it holds anything else, it refuses. If
motherapp is already installed from another checkout, it asks before moving the service over.

Or from a clone of this repo:

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
`check`, `logs`, `open`, `uninstall`). Versions look like `v2-abc1234`: the number in `VERSION`
(bumped by hand), the short git hash, and `-dirty` for a build with uncommitted changes. The
sidebar footer and Settings show the running version.

You can also update from the browser: **Settings → Update now** (after a confirm). It runs the
same `motherapp install`, but outside the service (as the systemd user unit `motherapp-update`),
so it survives the restart it causes. The page shows "Updating…" and the log, reconnects by
itself when the service is back, then shows the new version and the old → new summary. It
follows the same rules: it refuses on local changes, another branch or diverged history, and
shows that message. It never removes packages. A step that needs `sudo` with a password fails
with "run `motherapp install` in a terminal", because the browser can't ask for one. The log
is `~/.local/state/motherapp/update.log`.

**Releases** are tags `v<N>` on `main` (the `VERSION` number), each with a GitHub Release
([.github/workflows/release.yml](.github/workflows/release.yml), notes from
`docs/releases/v<N>.md`). The core asks GitHub for the latest release at start, every 6 h, and
on Settings → "Check for updates". The request is unauthenticated, and the answer and its ETag
are cached in `~/.local/state/motherapp/release-check.json`. When a newer release exists, the
sidebar says "· v3 available", and Settings shows it with a link to its release page. A failed
check shows "couldn't check: <reason>" and changes nothing else. `"updateCheck": false` in
`~/.config/motherapp/config.json` turns the check off. Updating always pulls `main`, which is at
or past the latest release, because releases are tagged on `main`.

`make help` lists the other targets (`make purge` = `--uninstall --purge`, which also deletes
`~/.config/motherapp` and `~/.local/state/motherapp`).

The installer checks Node >= 24, the PipeWire tools (`pw-dump`, `pw-play`, `pw-record`,
`pw-metadata`, `wpctl`), the freedesktop test sounds, the PipeWire user services, `ddcutil`,
`libddcutil`, the `i2c-dev` module, `/dev/i2c-*` and `i2c` group membership. It offers to fix
what is missing and asks y/N before every `sudo`/apt step (`--yes` accepts everything except an
install that would remove packages; add `--allow-removals` for that). For Node 24 it first
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
