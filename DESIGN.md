# motherapp — design notes

Status: **design phase, no code yet.** This file is the source of truth for what has been decided
and what is still open. It was distilled from a discussion that started as "add per-app volume to
audio-switch" and grew into a general, locally served control panel.

---

## 1. The idea in one paragraph

motherapp is an always-running background service on my Linux desktop that serves a web UI
(sidebar + content area). The core is a generic **manager**: it knows nothing about audio,
brightness or anything else. Every feature is an **independent CLI tool** that works on its own
from a terminal, a keybinding or a script; the manager is just a UI over those tools. Think
"extension manager": the core hosts, the tools are the extensions.

## 2. Where it came from

The predecessor is **audio-switch**, a single-file Python GTK4/libadwaita app (copied into
`reference/audio-switch/` for context; the original lives in a private dotfiles repo). It:

- lists PipeWire sinks/sources from `pw-dump`, clicking a row makes it the default (`wpctl set-default`)
- output rows: ▶ plays freedesktop left/right test sounds on that device (`pw-play --target`)
- input rows: live level meter (`pw-record` → RMS → LevelBar) and a 3 s record-and-playback test
- re-polls `pw-dump` every 2 s and **rebuilds the whole page** on any device-list change

That last point is the structural problem: fine for devices (rarely change), broken for app
streams (notification sounds, browser tabs appear and vanish constantly — every rebuild would
kill running mic monitors and yank sliders mid-drag). Any successor must be event-driven and
update rows in place.

Per-app volume is currently covered by a third-party GNOME Shell extension, **Per App Volume**
(`per-app-volume@gcampax.github.com`, ~360 lines of GJS over `Gvc`, declares GNOME 45–48). It
shows playback streams only, skips event streams, has no per-app routing. Once motherapp's audio
tool does per-app volume, that extension becomes redundant — and it would stop working past
GNOME 48 unless its author updates it.

## 3. Decided

| Topic | Decision |
|---|---|
| Name | **motherapp** |
| Rewrite | Allowed; the tech stack may change entirely. audio-switch is reference, not a base. |
| Shape | One app, **sidebar** with sections (audio, brightness, more later), not separate tools/windows. |
| Delivery | **Web UI served locally** by a background service. |
| Always running | Yes — a **systemd user service** (must run in the login session to reach PipeWire's socket under `$XDG_RUNTIME_DIR`; no root). |
| Language | **TypeScript for backend and frontend** where possible, with shared types for API messages. |
| Architecture | Core = generic manager (web server, sidebar shell, WebSocket channel, extension loader, enable/disable). **No domain logic in the core.** |
| Features | Each feature is a **standalone CLI tool**, usable without the manager. The manager is just a UI over them. Consequence: tools are separate executables, so they *can* be in any language. |
| Network | **Localhost only by default.** A switch in the UI opens it to the LAN; off by default. Phone control is not a goal right now, but the switch keeps the door open. |
| Per-app audio scope | **Playback streams only** (apps playing sound), not recording apps. |
| Cockpit | **Not** used as the host, but borrow ideas: **logs, storage, networking** pages. |
| First features | Audio (device switching + test tools + per-app volume), then monitor brightness. |
| Repo layout | **One repo** for the core and all tools. |
| Next after audio + brightness | **Logs**. Storage and networking come later. |
| Cockpit-style pages | **Write actions from the start**, not read-only first. |
| Network switch scope | **All or none.** When it is on, everything is reachable from the LAN. No per-action local-only flag for now. |
| Network pairing | QR + one-time-token pairing is **nice to have**, not required for the first version. **No auto-off**: no timeout, nothing on screen lock. |
| Control feedback | The UI shows the last known value immediately (the brightness tool holds its last set value). Each control has a **small status dot**: setting / set / failed. Set is shown for ~2 s, then fades; failed stays until the next success. |
| Retiring predecessors | Retire audio-switch and the Per App Volume extension once the audio tool ships. **The user decides when.** |
| UI model | **Hybrid** (§ 4.1, § 4.5): declarative pages by default, TS custom pages as the escape hatch. |
| Protocol, contract, discovery, crashes | As written in **§ 4.6–4.9**, accepted 2026-10-19. |
| Runtime | **Node 24 LTS** (§ 4.10). It gets installed on the machine. |
| Frontend | **Plain TS + Vite + Bootstrap 6 (alpha, pinned)**, web components for custom pages (§ 4.11). |
| Launcher | **Served on the web only**: open `http://127.0.0.1:7323` in a browser. No tray icon for now. |
| Audio scope, first version | **Master volume and mute** for the default output and the default input (mic), following whichever device is the default (#13). **Per-app volume and mute** for apps that are playing sound. Per-app output routing comes later ([#1](https://github.com/erkantaylan/motherapp/issues/1)). |
| Per-app rows | **One row per app.** All of an app's streams are grouped, e.g. one Firefox row. |
| Audio test tools | **Keep audio-switch's**: L/R test, live mic meter, record-and-playback. |
| Device volume | **Master sliders only** (default output + default mic, #13). No volume slider on each device row: tried as a mockup (Option B) and rejected as too crowded. |
| Brightness UI | **Both**: a slider per monitor plus a linked "all monitors" slider. |
| Brightness backend | **`libddcutil` kept loaded** in the brightness tool's serve process. It needs installing on the machine. |
| Brightness FFI | **`koffi`** (npm, prebuilt binaries, so no compiler or dev headers on the machine) loads `libddcutil.so.4` by soname. All libddcutil calls run on one `worker_threads` worker, because they block and the library keeps per-thread state; the serve loop never waits on DDC/CI. Before the library loads, fd 1 is pointed at stderr, because libddcutil 1.4 prints to C stdout from its constructor. If the library can't be loaded, the tool falls back to the `ddcutil` command and shows a warning. Built in `tools/brightness/` (`brightctl`). |
| Shared storage | Each tool keeps its own files in `~/.config/motherapp/` (settings) and `~/.local/state/motherapp/` (state). **SQLite** (`node:sqlite`) is added only where something needs searching, likely log history; when is Claude's call. |
| Install | An **installer** that checks every dependency. It installs the missing ones, asking before anything uses `sudo`/apt, or explains how to install them. Then it builds the app and sets up the systemd user service. Built as `install.sh` (bash, since Node 24 may be missing): `--check`, `--yes [--allow-removals]`, `--uninstall [--purge]`. Node 24: `nvm`/`fnm install 24` is offered first when one is present (no sudo, removes nothing). Otherwise the NodeSource apt repo is offered, after an `apt-get -s` simulation that lists what the install would remove; `--yes` alone never accepts removals (issue #3). |
| Tool CLIs on PATH | The installer writes wrappers in `~/.local/bin` (e.g. `audioctl`) that run the tool with the installer's Node 24; removed by `--uninstall`. |
| Testing on the machine | When a build is ready to try, a **GitHub issue with step-by-step test instructions** is opened for a Claude session on the user's computer to follow. |
| Branching | **Work directly on `main`.** No feature branches. |
| Audio backend (Q9) | **PipeWire CLI route**: `pw-dump --monitor` for events, `wpctl` for default/volume/mute, `pw-play`/`pw-record` for the tests. No `pactl`, no GObject bindings. Built in `tools/audio/` (`audioctl`). |
| Build order | 1. Core infra (manager). 2. A **log service in the core** that every extension uses, plus its logs page (§ 4.12). 3. The **audio tool**: audio-switch parity plus per-app volume and mute. This replaces § 4.4. |
| tmux tool | `tools/tmux/` per issue #6: polled every 2 s, copy and kill-with-confirm per session. |
| Shortcuts tool | `tools/shortcuts/` per issue #7: owns only `motherapp-*` custom keybindings; key capture via a custom page. Groups (#19) are derived, never stored: a `"Group: "` name prefix, else (motherapp's own) the tool whose wrapper the command calls, else the same program; at least 2 per group, 3+ start collapsed. |
| Inbox tool | `tools/inbox/` per #11: own 127.0.0.1 listener exposed only via a cloudflared **quick tunnel** (never named tunnels: user's call, 2026-10-20; a cloud session can reach it, #16); hashed tokens, delivery without reading the screen by default (`checkScreen: false`, #22); with `checkScreen: true`, idle-only delivery plus a confirmed "Deliver now" override on the page, peer-message rule in CLAUDE.md. A link has just a **label and an expiry** in hours (default 24); no per-link message count or length. Fixed guards stay: 32 KiB body cap, text cleaning, 6 messages/min per link, 10 queued per link. A narrow exception to the all-or-none network switch. |
| Inbox screen check | **Off by default, accepted** (user, 2026-10-21): messages are typed and submitted without reading the screen, so an Enter can answer a permission prompt that happens to be open. Accepted because links are the user's own, short-lived and revocable. `checkScreen: true` in `inbox.json` turns the check back on. |
| Version scheme | **`v<N>-<hash>[-dirty]`** (#17): `<N>` is a hand-bumped number in `VERSION` (starts at `1`; the npm `0.1.0` fields are never shown), `<hash>` the short git hash, `-dirty` when `git status --porcelain` isn't empty at build time. `scripts/build-info.sh` computes it; `npm run build` and `install.sh` write the gitignored `build-info.json` (`version`, `hash`, `dirty`, `builtAt`), which the core reads at start (missing → `v?-unknown`). Shown in the sidebar footer, Settings, the "motherapp core starting" log entry, `motherapp --version` and `install.sh` (`OK version …`). The core caches the checkout's HEAD (`git rev-parse`, at most once a minute, "Check again" refreshes) and reports "running v1-abc1234, checkout is at v1-def5678, run `motherapp install`" via `version.get` and `/api/status`. |
| `motherapp` command | `~/.local/bin/motherapp` (#17), written by `install.sh` like the tool wrappers; runs `scripts/motherapp.sh` (bash; Node only reads the core's status JSON). `install`/`update`: `git fetch` + `git pull --ff-only` on `main`, refusing on local changes, another branch or diverged history (never stashes, resets or merges), then `./install.sh --yes`: unattended, but it **never removes apt packages** (user's call, 2026-10-20: an update has no reason to remove anything; if one ever would, the installer stops and says so; sudo itself may still ask for a password), then old → new version, the new commits and the HTTP check; "already up to date" re-installs only when the build is missing or stale. Also `status`, `version`/`--version`, `check`, `logs`, `open`, `uninstall`, `help`. `make doctor`/`npm run doctor` are gone; `check` stays. |
| Tool order | user-set in Settings (drag the handle, or arrow keys on it), saved as `order` in config.json; new tools are appended |

## 4. Details

4.1 and 4.5–4.11 were accepted on 2026-10-19 (see § 3). 4.4 is superseded by the build order in
§ 3. 4.12 is what is being built; revise it if it's wrong.

### 4.1 Hybrid UI model (declarative by default, custom pages as escape hatch)

Two tiers:

- **Declarative (default).** A tool describes its UI as data and its state separately, e.g.
  `audioctl describe --json` (layout) and `audioctl watch --json` (state stream). Controls bind to
  a state path and name an action. Layout/state split means a volume change is a tiny state
  delta, not a re-render. Pros: any language, consistent look, phone-friendly for free, zero
  frontend code per tool. Cons: we own a widget vocabulary, every new widget type is core work.
  Starting vocabulary: list, radio, slider, toggle, meter, button, text. Buttons later gained
  `copy` (client-side clipboard copy) and `confirm` (an in-page confirm dialog), for tmux (#6)
  and other tools (#8).
- **Custom page (escape hatch).** The extension ships a TS module the shell mounts in the content
  area, with a client bound to its tool (subscribe to state, call actions) and the shared theme.
  Pros: anything goes (log viewer with live tail and filters, storage charts). Cons: TS only,
  consistency is on discipline. Load in-page (ES module / web component), not in an iframe —
  isolation protects against strangers' code, and there is none.

Rule of thumb: grow the widget vocabulary only when a second extension needs the same widget;
until then a custom page is the cheaper answer. Avoid turning the declarative layer into an
accidental UI framework.

### 4.2 Each tool has three layers

logic → CLI front (`audioctl set-default headphones`, `brightctl set 60`) → adapter the manager
speaks to (stdio JSON). If that stdio protocol were MCP, the same tools would also be drivable
by Claude Code for free — optional, but cheap if we're designing a protocol anyway.

### 4.3 Network switch details

- Flipping it rebinds the listener `127.0.0.1` → LAN address; the switch itself is only
  operable from localhost (a remote client must not be able to keep it on).
- Pairing (nice to have, see § 3): desktop shows a QR code with a one-time token, phone scans
  it, that device is trusted. Unpaired clients get nothing.
- Dropped: a per-action `remote: false` flag. § 3 decided all-or-none instead.

### 4.4 Build order

Build audio and brightness first with a clean seam to the core, then extract the extension
contract from what the two actually share. Freezing a contract from a single example is
designing in a vacuum.

### 4.5 Recommendation on the hybrid UI (Q1): accept it

The first three features already need both tiers. Audio and brightness are lists and sliders,
which the declarative tier covers. Logs needs a live tail with filters, which is a custom page.
"Custom pages are TS only" costs nothing, since everything is TS anyway.

### 4.6 Manager ↔ tool protocol (Q2)

- Each tool has a long-running **`<tool> serve`** mode. The core starts it once and talks to it
  over stdin/stdout. The same executable keeps its plain CLI subcommands for terminal and
  keybinding use.
- Messages are **JSON-RPC 2.0, one message per line**. That gives request/response matching
  and standard error objects for free, and it is also the base layer of MCP, so moving to MCP
  later stays cheap.
- **State lives in the tool.** The tool keeps current values in memory and saves the last known
  ones to `$XDG_STATE_HOME/motherapp/<tool>.json`. After a restart, brightness shows its last
  set value immediately, then re-reads the monitor in the background.
- **The core caches the latest state of every tool.** Opening a page is served from that cache,
  with no tool call and no 0.5 s `ddcutil` wait.

### 4.7 Contract shape (Q3)

| Message | Direction | Content |
|---|---|---|
| `describe` | core → tool, request | `{ title, icon, page: "declarative" \| "custom", layout }` |
| `state.get` | core → tool, request | Full state snapshot (used on start and after a crash). |
| `state` | tool → core, notification | `{ changes: [{ path, value }] }`, small deltas only. |
| `action` | core → tool, request | `{ name, args }` → result, or a JSON-RPC error `{ code, message }`. |
| `progress` | tool → core, notification | `{ id, text, fraction? }` for slow actions. |
| `stream.open` / `stream.close` | core → tool, request | Starts or stops a high-rate value, such as the mic meter. |
| `stream` | tool → core, notification | `{ name, value }` up to ~20 Hz, only while open, never cached. |

How the status dot is driven:
- **setting**: the action was sent and has no reply yet.
- **set**: the reply came back OK.
- **failed**: an error came back. The message shows on hover.

A tool can also mark a value `stale`, for example a cached brightness that hasn't been re-read
from the monitor yet.

### 4.8 Discovery (Q4): the simplest option

- Each tool lives in `tools/<name>/` in this repo, with a `manifest.json`:
  `{ id, title, icon, serve: ["node", "serve.ts"], page?: "page.ts" }`.
- At startup the core reads `tools/*/manifest.json`. The set of enabled tools is stored in
  `~/.config/motherapp/config.json`.
- No install-from-URL and no versioning. One repo means one version.

### 4.9 Crash handling (Q6)

- **Crashes show up on the logs page.** The core runs under systemd and forwards each tool's
  stderr to the journal, tagged with the tool id. Since the logs page reads the journal, tool
  errors appear there with no extra work.
- The tool's sidebar entry gets a red dot while the tool is down. Its page keeps showing the
  cached state, marked stale.
- Restart with backoff: 1 s, 2 s, 4 s and so on, capped at 30 s. After 5 crashes within 2 minutes
  the core stops retrying and shows a "restart" button.

### 4.10 Runtime (Q7): Node 24 LTS

| | Node | Bun |
|---|---|---|
| On the machine | 22.23 (supported until 2027-04) | 1.3.14 |
| Maturity | Long-term-support releases, very large user base | Younger, with more edge-case bugs and Node-compatibility gaps |
| Running TS | Runs `.ts` directly (type stripping, no enums) | Runs `.ts` directly |
| WebSocket server | Needs the `ws` package | Built in |
| Speed | Fast enough | Faster startup and higher HTTP throughput |

Bun's speed advantage doesn't show up here. The core and the tools are long-running processes
serving one local user, and the real bottleneck is `ddcutil` at ~0.5 s per call. Safety is
noticeable, so the recommendation is **Node 24 LTS** (supported until 2028-04). It needs to be
installed, because Node 22 runs out in six months. Deno is not installed and is no longer in the
running.

### 4.11 Frontend (Q8): plain TS + Vite

What a framework would give us:
- **Updating list rows in place.** This is exactly what audio-switch got wrong. In plain TS it is
  one keyed-list helper (~100 lines) inside the declarative renderer, written once.
- **Components for custom pages.** Standard web components, built into browsers, cover this.

Nothing else is needed. Vite is only for development and the build; the core serves the output
as static files. If the logs page turns out painful, a small library can be added to that one
page later without changing the shell.

Styling (issue #9, an experiment that may be reverted): Bootstrap 6 alpha's Sass, only the parts
the shell uses, compiled by Vite into one stylesheet (`web/src/styles.scss`); no Bootstrap JS.

### 4.12 Log service (core)

- **One log for the whole app.** The core, and every tool, writes to it.
- **How tools write to it.** A tool sends `log` notifications `{ level, msg, fields? }` over its
  serve channel. Anything a tool prints to stderr is captured as level `error` lines. The core
  adds its own entries for tool start, exit, crash and restart.
- **Where entries go.** Each entry is tagged with the tool id and:
  - is printed as one JSON line on the core's stdout, so journald keeps it under systemd;
  - is appended to `$XDG_STATE_HOME/motherapp/log.jsonl`, which is size-capped and rotated;
  - is kept in an in-memory ring buffer that serves the logs page.
- **The logs page** is the first custom page. It has a live tail, filters by tool and level, and
  text search.
- **Port.** Q10 is still open, so the core listens on `127.0.0.1:7323` by default, changeable in
  the config file.

## 5. Open questions

### Core and contract

1–8. *Answered (§ 3).*

### Stack
9. *Answered (§ 3): the PipeWire CLI route.* The options and findings are kept for context.
   **How the audio tool talks to PipeWire:**
   - CLI tools, driven properly: `pw-dump --monitor` (event-driven JSON; removals arrive as
     objects with `info: null`), `wpctl` (volume, mute, default), `pw-metadata` (per-app routing
     via `target.object`), `pw-play`/`pw-record` (tests). Most predictable; costs parsing and a
     spawn per change.
   - PulseAudio protocol via `pipewire-pulse` with an npm client: event subscription, per-app
     volume and move-stream built in, pure TS. Library maturity unverified.
   - GJS + TypeScript (types via ts-for-gir) using `gi://Wp` (WirePlumber, what `wpctl` is
     built on) and Soup for HTTP/WebSocket. Most native; not Node, npm mostly unusable.
   - Or, since tools are separate processes: write the audio tool in Python with WirePlumber's
     GObject bindings (typelib availability on the target machine unverified).

   Findings (2026-10-19 research, see § 6 for what still needs checking on the machine):
   - The machine is Ubuntu 24.04 with **WirePlumber 0.4.17**, not 0.5 (confirmed, § 6). The
     `gi://Wp` and Python routes would target the **Wp-0.4** API. Its package, `gir1.2-wp-0.4`,
     is in the archive but **not installed**. The 0.5 API is different, so code written now
     would need porting on the next LTS.
   - npm PulseAudio clients are thin: `paclient` (pure JS, 26 stars, 7 commits) covers
     sink-inputs (`getSinkInputs`, `setSinkInputVolumesByIndex`, `setSinkInputMuteByIndex`,
     `moveSinkInput`) and `subscribe`. `@tmigone/pulseaudio` (TS, 18 stars, no releases)
     documents sinks and events only, with no sink-input API shown. `pulseaudio2` binds libpulse
     natively. **No mature, typed option exists**, so a TS audio tool over pulse would mean
     vendoring or forking `paclient`.
   - Fallback for the pulse route: spawn `pactl subscribe` / `pactl -f json list sink-inputs`.
     That has the same parsing-and-spawn cost as the PipeWire CLI route, plus a dependency on
     `pipewire-pulse`. `pipewire-pulse` is running, but `pactl` isn't installed.
   - Net: of the routes that avoid an extra dependency, the **PipeWire CLI route**
     (`pw-dump --monitor` + `wpctl` + `pw-metadata`) is the only one that doesn't depend on a
     thin library or a version-specific GObject API.
10. *Answered (§ 3): served on the web, no tray.*

### Audio

11. *Answered (§ 3): start small.* Bluetooth profiles and mic gain aren't scheduled.
12. *Answered (§ 3): one row per app.*
13. *Answered (§ 3): keep the test tools.* Note: the mic meter must be measured on the backend.
    A browser's `getUserMedia` would hear the viewing device's mic, not the PC's.

### Brightness

14. *Answered (§ 3): both kinds of slider, `libddcutil` kept loaded.* The build-time question
    of how Node calls into `libddcutil` is *answered (§ 3, "Brightness FFI", 2026-10-20): `koffi`*,
    not a C helper. The Ubuntu 24.04 package for the 1.4 library is **`libddcutil4`**
    (1.4.1-1build2, universe; ships `libddcutil.so.4`, the unversioned `libddcutil.so` symlink
    is only in `libddcutil-dev`). Checked against the noble archive on 2026-10-19; `install.sh`
    still picks the name with `apt-cache` at runtime.

    Finding: Ubuntu 24.04 packages **ddcutil 1.4.1**, not 2.x (2.2.x is in 25.04 and later).
    The 2.x line is where upstream reworked sleep timing and the shared library.

    Measured on the machine (see `machine-facts/`): `detect` takes ~1.0 s. A brightness read
    with `--bus N` takes ~0.5 s per monitor. So caching (§ 4.6), debouncing and one call at a
    time per monitor are required, not optional. Buses: DP-1 is `/dev/i2c-1`, DP-2 is
    `/dev/i2c-3`. Both report brightness on a 0–100 scale.

### Network switch

15. *Answered: pairing is nice to have, no auto-off (§ 3).*
16. *Answered: all or none (§ 3).*

### Cockpit-inspired pages

17. *Answered: logs comes first (§ 3).*
18. *Answered: write actions from the start (§ 3).* Risk notes, kept for when we build them:
    - logs: `journalctl -f -o json` is already a structured stream; easy backend, rich UI (custom page).
    - storage: reading via `lsblk --json` / `df` is easy; mount/unmount via udisks2 (polkit
      handles authorization for the session user, no root).
    - networking: NetworkManager via `nmcli`/DBus; reading is easy, writing can cut off the
      very connection you'd use to fix it.

### Housekeeping

19. *Answered: yes, and the user decides when (§ 3).*

## 6. Target machine facts

Captured because a cloud session cannot inspect the machine.

- Ubuntu with **GNOME Shell 46**, extensions: dash-to-panel, per-app-volume, ding,
  tiling-assistant, ubuntu-appindicators.
- **PipeWire + WirePlumber** (`pw-dump`, `wpctl`, `pw-play`, `pw-record` present).
- Desktop, **two external monitors**: DP-2 3440×1440 (primary) and DP-1 2560×1440. No
  backlight device.
- `ddcutil` installed, `/dev/i2c-*` present, user is in the `i2c` group.
- Not installed: `brightnessctl`.

Collected 2026-10-19. Full output is in `machine-facts/`, and `machine-facts/collect.sh` can be
re-run any time.

- **Ubuntu 24.04.5 LTS**, GNOME Shell 46.0, **Wayland** session.
- PipeWire **1.0.5**, WirePlumber **0.4.17**. `pipewire-pulse` is running and its socket is up;
  `pactl` is not installed.
- No WirePlumber typelib (`gir1.2-wp-0.4` is available in apt but not installed), and no `Gvc`.
- ddcutil **1.4.1**; `libddcutil` is not installed. Monitors: DP-1 = MSI G274QPF on
  `/dev/i2c-1`, DP-2 = Acer X34 P on `/dev/i2c-3`.
- Node **22.23.2**, Bun **1.3.14** and GJS 1.80.2 are installed. Deno is not.

## 7. Prior art worth reading

- [pwvucontrol](https://github.com/saivert/pwvucontrol) — Rust + gtk4-rs + libadwaita +
  wireplumber-rs per-app/per-device mixer; good reference for the WirePlumber model.
- [Cockpit](https://cockpit-project.org/) — local web-based system manager with a plugin model
  (manifest + HTML/JS, commands and DBus through a bridge). Source of the logs/storage/networking
  ideas.
- Per App Volume GNOME extension — `Gvc`-based per-app sliders in the panel.
