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

## 4. Proposed, awaiting confirmation

### 4.1 Hybrid UI model (declarative by default, custom pages as escape hatch)

Two tiers:

- **Declarative (default).** A tool describes its UI as data and its state separately, e.g.
  `audioctl describe --json` (layout) and `audioctl watch --json` (state stream). Controls bind to
  a state path and name an action. Layout/state split means a volume change is a tiny state
  delta, not a re-render. Pros: any language, consistent look, phone-friendly for free, zero
  frontend code per tool. Cons: we own a widget vocabulary, every new widget type is core work.
  Starting vocabulary: list, radio, slider, toggle, meter, button, text.
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
- Pairing: desktop shows a QR code with a one-time token, phone scans it, that device is
  trusted. Unpaired clients get nothing.
- Per-action `remote: false` flag in a tool's description for things that must stay local even
  with the network on (mic recording, anything that changes the system).

### 4.4 Build order

Build audio and brightness first with a clean seam to the core, then extract the extension
contract from what the two actually share. Freezing a contract from a single example is
designing in a vacuum.

## 5. Open questions

### Core and contract

1. **Hybrid UI (4.1)** — accept it? Is "custom pages are TS only" acceptable?
2. **Manager ↔ tool protocol.** Spawn the CLI per call, or a long-running `tool serve` mode over
   stdio (LSP-style)? Plain JSON lines vs JSON-RPC vs MCP?
3. **Contract shape.** What exactly is in `describe` / `watch` / action calls? How are errors,
   progress and streaming values (mic meter at ~20 Hz) represented?
4. **Discovery.** Folder the core scans (e.g. `~/.config/motherapp/extensions/`)? Manifest format?
   Is install-from-URL / versioning ever needed, or is enable/disable enough?
5. **Repo layout.** Core and tools in this one repo (monorepo), or each tool in its own repo so
   it is truly independent?
6. **Crash handling.** Core restarts a crashed tool process — with backoff? Surfaced in the UI?

### Stack

7. **Runtime for the core:** Bun (built-in TS, HTTP + WebSocket, single-binary compile), Node 24
   (native type stripping, safest ecosystem, needs a ws package), or Deno (permission flags —
   `--allow-run=wpctl,...`, `--allow-net=127.0.0.1` — fit the network-switch security story)?
8. **Frontend framework:** React, Svelte, Solid, or plain TS + Vite? Mostly taste; the sidebar
   must collapse on small screens.
9. **How the audio tool talks to PipeWire:**
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
10. **Launcher.** App-mode browser window (`chromium --app=http://localhost:…`) from a `.desktop`
    entry? Tray icon? Port number?

### Audio

11. **"Generalize" scope beyond per-app volume:** device volume/mute, per-app output routing
    (send one app to headphones while the rest stays on speakers), Bluetooth card profiles
    (A2DP vs HFP), mic gain?
12. **Per-stream or per-app rows?** Firefox can have several streams at once — one slider each,
    or grouped by `application.name`?
13. Keep audio-switch's test tools as-is (L/R test, live meter, record-and-playback)? Note: the
    mic meter must be measured on the backend — a browser's `getUserMedia` would hear the
    viewing device's mic, not the PC's.

### Brightness

14. Target hardware is DDC/CI over external monitors (no `/sys/class/backlight`). `ddcutil` is
    slow (detect: seconds; each set: tens–hundreds of ms), so: debounce sliders, serialize per
    monitor, cache bus numbers from one detect. CLI `ddcutil` vs `libddcutil` for a persistent
    process? Per-monitor sliders, a linked "all monitors" slider, or both?

### Network switch

15. QR + token pairing (4.3) okay? Should the switch auto-off (after a timeout, or when the
    screen locks)?
16. Which actions are local-only by default?

### Cockpit-inspired pages

17. Which comes first after audio and brightness — logs, storage, or networking?
18. Read-only first, or with write actions? Risk notes:
    - logs: `journalctl -f -o json` is already a structured stream; easy backend, rich UI (custom page).
    - storage: reading via `lsblk --json` / `df` is easy; mount/unmount via udisks2 (polkit
      handles authorization for the session user, no root).
    - networking: NetworkManager via `nmcli`/DBus; reading is easy, writing can cut off the
      very connection you'd use to fix it.

### Housekeeping

19. Once motherapp's audio tool ships: retire audio-switch and the Per App Volume extension?

## 6. Target machine facts

Captured because a cloud session cannot inspect the machine.

- Ubuntu with **GNOME Shell 46**, extensions: dash-to-panel, per-app-volume, ding,
  tiling-assistant, ubuntu-appindicators.
- **PipeWire + WirePlumber** (`pw-dump`, `wpctl`, `pw-play`, `pw-record` present).
- Desktop, **two external monitors**: DP-2 3440×1440 (primary) and DP-1 2560×1440. No
  backlight device.
- `ddcutil` installed, `/dev/i2c-*` present, user is in the `i2c` group.
- Not installed: `brightnessctl`.

## 7. Prior art worth reading

- [pwvucontrol](https://github.com/saivert/pwvucontrol) — Rust + gtk4-rs + libadwaita +
  wireplumber-rs per-app/per-device mixer; good reference for the WirePlumber model.
- [Cockpit](https://cockpit-project.org/) — local web-based system manager with a plugin model
  (manifest + HTML/JS, commands and DBus through a bridge). Source of the logs/storage/networking
  ideas.
- Per App Volume GNOME extension — `Gvc`-based per-app sliders in the panel.
