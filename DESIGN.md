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
| Network | Localhost by default; a 'Local network' checkbox in Settings opens it to private-range source addresses on all interfaces, with no login (user's call, 2026-10-21); changeable only from localhost; open only on networks the user marked trusted (NetworkManager connection UUID + gateway MAC). |
| Host names | `localhost`, `*.localhost` (portgate subdomains), loopback IPs; more only via the LAN switch. `*.localhost` has its own Settings toggle, on by default (`localhostSubdomains`). |
| Per-app audio scope | **Playback streams only** (apps playing sound), not recording apps. |
| Cockpit | **Not** used as the host, but borrow ideas: **logs, storage, networking** pages. |
| First features | Audio (device switching + test tools + per-app volume), then monitor brightness. |
| Repo layout | **One repo** for the core and all tools. |
| Next after audio + brightness | **Logs**. Storage and networking come later. |
| Cockpit-style pages | **Write actions from the start**, not read-only first. |
| Network switch scope | **All or none**, with one exception. When it is on, everything is reachable from the LAN, except a tool's **`localActions`** (manifest; user's call 2026-11-07, for the tmux dashboard): the core refuses those for any connection that couldn't change network settings (a loopback source under a localhost name), before the tool hears of them. Used for what must not leave this machine: opening a window on this screen, screen contents and scrollback, and (2026-11-10) typing into a session. |
| Network pairing | QR + one-time-token pairing: **not planned for now** (2026-10-21). **No auto-off**: no timeout, nothing on screen lock. |
| Control feedback | The UI shows the last known value immediately (the brightness tool holds its last set value). Each control has a **small status dot**: setting / set / failed. Set is shown for ~2 s, then fades; failed stays until the next success. |
| Retiring predecessors | Retire audio-switch and the Per App Volume extension once the audio tool ships. **The user decides when.** |
| UI model | **Hybrid** (§ 4.1, § 4.5): declarative pages by default, TS custom pages as the escape hatch. |
| Protocol, contract, discovery, crashes | As written in **§ 4.6–4.9**, accepted 2026-10-19. |
| Runtime | **Node 24 LTS** (§ 4.10). It gets installed on the machine. |
| Frontend | **Plain TS + Vite + Bootstrap 6 (alpha, pinned)**, web components for custom pages (§ 4.11). |
| Launcher | **Served on the web**: open `http://127.0.0.1:7323` in a browser. Since 2026-11-10 there is also a tray icon whose menu opens it (row "Tray icon"). |
| Audio scope, first version | **Master volume and mute** for the default output and the default input (mic), following whichever device is the default (#13). **Per-app volume and mute** for apps that are playing sound. Per-app output routing comes later ([#1](https://github.com/erkantaylan/motherapp/issues/1)). |
| Per-app rows | **One row per app.** All of an app's streams are grouped, e.g. one Firefox row. **App names** (2026-10-30): streams group by `application.process.binary` when there is one (else by name, as before), so all of a process's streams are one row. The row's name is the first `application.name` that isn't a library's generic name (`WEBRTC VoiceEngine`, `ALSA plug-in […]`, `PipeWire ALSA […]`, `Chromium`, `Chromium input`, empty); otherwise the `Name=` of the desktop entry for the binary (file id, `StartupWMClass`, or an `Exec` program only one entry uses, read once from the XDG dirs plus snap's and flatpak's), otherwise the binary capitalised. So Discord's voice stream reads "Discord", not "WEBRTC VoiceEngine" (which GNOME shows). `application.*` props missing on a stream node are taken from its Client (Spotify's node has no binary). Discord's `discord_capture` and `recStream` are capture streams, so not app rows. |
| Outputs and inputs = routes (Q11) | **Decided, built 2026-10-30** (user report: a Bluetooth headset showed one output, GNOME two; then: GNOME shows 8 outputs, motherapp 4). The Outputs and Inputs lists show every **route** (port) of every card whose `available` isn't `"no"`, as GNOME does, not only the nodes that exist. Nodes stay rows as before (titled by `deviceTitles`). A route with no node (its profile isn't active, or it isn't the active route of its `card.profile.device`) is an extra row keyed `route-<card>-<route index>`, titled like GNOME, `"<port> – <card>"` (e.g. "Line Out – Starship/Matisse HD Audio Controller", "Handsfree – JBL Tune Flex 2"). Bluetooth rows (nodes and routes) get the mode as the second line: "A2DP: high fidelity" or "HFP: headset with mic" (families, never a row per codec). **Selecting one:** if the route isn't on the active profile, `wpctl set-profile <card> <index>` with the best profile among the route's `profiles`: first one that keeps the card's other direction (Line Out keeps the analog mic: "Analog Stereo Duplex", not "Analog Stereo Output"), then the highest EnumProfile priority (for the JBL's HFP that is 261, mSBC); then wait (10 s at most) until the card reports a profile in the route's list and a node with that `card.profile.device` exists; if WirePlumber made another route active there, `pw-cli set-param <card> Route '{ index, device, save: true }'` (wpctl 0.4 has no set-route); then `wpctl set-default <node>`. Measured on the JBL: about 50–80 ms in serve mode, 250–300 ms for `audioctl set-default route-148-3` (Node startup and polled `pw-dump`s included), with a short gap in playback while the node is recreated. **The inactive headset mic is listed under Inputs** too (GNOME does; selecting it switches the headset to HFP, so the output changes mode with it). Test L/R and Record on a route row fail with "select it first". `audioctl list` prints route rows after the nodes with "[switches profile]" / "[switches port]"; `set-default` takes their key or title. Not done live on the ALSA cards (the user's audio was on them): only the Bluetooth switch was tried on the machine. Mic gain stays unscheduled. |
| Audio test tools | **Keep audio-switch's**: L/R test, live mic meter, record-and-playback. |
| Device volume | **Master sliders only** (default output + default mic, #13). No volume slider on each device row: tried as a mockup (Option B) and rejected as too crowded. |
| Brightness UI | **Both**: a slider per monitor plus a linked "all monitors" slider. |
| Brightness backend | **`libddcutil` kept loaded** in the brightness tool's serve process. It needs installing on the machine. |
| Brightness FFI | **`koffi`** (npm, prebuilt binaries, so no compiler or dev headers on the machine) loads `libddcutil.so.4` by soname. All libddcutil calls run on one `worker_threads` worker, because they block and the library keeps per-thread state; the serve loop never waits on DDC/CI. Before the library loads, fd 1 is pointed at stderr, because libddcutil 1.4 prints to C stdout from its constructor. If the library can't be loaded, the tool falls back to the `ddcutil` command and shows a warning. Built in `tools/brightness/` (`brightctl`). |
| Shared storage | Each tool keeps its own files in `~/.config/motherapp/` (settings) and `~/.local/state/motherapp/` (state). **SQLite** (`node:sqlite`) is added only where something needs searching, likely log history; when is Claude's call. |
| Install | An **installer** that checks every dependency. It installs the missing ones, asking before anything uses `sudo`/apt, or explains how to install them. Then it builds the app and sets up the systemd user service. Built as `install.sh` (bash, since Node 24 may be missing): `--doctor`, `--yes [--allow-removals]`, `--uninstall [--purge]`. **`--doctor`** (user's call 2026-11-03, replacing `--check`): report, then offer each fix it found, asking before each one (the same NEED_* steps an install offers: apt packages, Node, i2c, the CPU access steps, thermald), without npm ci, the build or rewriting the unit and wrappers. Nothing to fix: it only reports. Closed stdin counts as no, so it degrades to report-only. `--yes` accepts the fixes, with install's guard kept: an apt install that would remove packages still needs `--allow-removals`. Node 24: `nvm`/`fnm install 24` is offered first when one is present (no sudo, removes nothing). Otherwise the NodeSource apt repo is offered, after an `apt-get -s` simulation that lists what the install would remove; `--yes` alone never accepts removals (issue #3). **One-line install** (2026-10-21): `bash -c "$(curl -fsSL https://raw.githubusercontent.com/erkantaylan/motherapp/main/scripts/get.sh)"` (this form keeps stdin a terminal, so the prompts work). `scripts/get.sh` refuses root and needs `git` and `curl`. It clones into `${MOTHERAPP_DIR:-~/.local/share/motherapp}` and runs `./install.sh` with its normal prompts. When that folder is already a motherapp clone, it runs `motherapp install` there instead (`./install.sh` if the clone was never built). Any other contents: it refuses. |
| File search | Not part of motherapp for now. The user uses FSearch standalone (installed by hand from its PPA, 2026-10-21, #24). If it isn't good enough, build a motherapp Files tool: own in-memory index of chosen folders (home by default), instant fuzzy search on a page + `findctl`, open/open-folder/copy-path. |
| Tool CLIs on PATH | The installer writes wrappers in `~/.local/bin` (e.g. `audioctl`) that run the tool with the installer's Node 24; removed by `--uninstall`. |
| Testing on the machine | When a build is ready to try, a **GitHub issue with step-by-step test instructions** is opened for a Claude session on the user's computer to follow. |
| Branching | **Work directly on `main`.** No feature branches. |
| Audio backend (Q9) | **PipeWire CLI route**: `pw-dump --monitor` for events, `wpctl` for default/volume/mute, `pw-play`/`pw-record` for the tests. No `pactl`, no GObject bindings. Built in `tools/audio/` (`audioctl`). |
| Build order | 1. Core infra (manager). 2. A **log service in the core** that every extension uses, plus its logs page (§ 4.12). 3. The **audio tool**: audio-switch parity plus per-app volume and mute. This replaces § 4.4. |
| tmux tool | `tools/tmux/` per issue #6, a **dashboard** since 2026-11-07 (custom page, `wide`; replaces the standalone tmuxboard prototype): session list beside a large live preview, stacked on a phone. Not Claude-only. **Polls all the time**, every 1.5 s, with one `tmux list-panes -a` a tick (the exception in "Polling"). **State:** Claude's own status when its `~/.claude/sessions/<pid>.json` is readable (pane pid, else a descendant of it; `procStart` must match `/proc`), otherwise pane output: `window_activity` (max across windows, never `session_activity`, which moves on key presses) within 3 s = working, else idle at a shell or agent, else quiet. `busy` and `shell` = working, `idle` = idle, `waiting` = waiting on you. An unknown status or a broken file falls back to output. **Waiting on you needs no hook**: measured 2026-11-07, the status file says `status: "waiting"`, `waitingFor: "permission prompt"`. **Details** from `~/.claude/projects/*/<sessionId>.jsonl`, read from the tail, then only what was appended: AI title, last prompt, context tokens, last message. **Sub-agents running** in the row and details when above 0, see the lesson: no `finished`/`stoppedByUser` in the meta file, meta newer than this process, transcript not ending in the stop marker, and none at all while the status is `idle` or `shell`; an old version, an unknown status or a broken file shows nothing. **Timeline:** 60 one-minute buckets per session, in memory, published as a 60-character string. **Actions:** Open, Copy attach command, Rename, Kill with confirm. Open runs `terminator --no-dbus -x tmux -u attach-session -t =<name>`, an argv list, without `TMUX`/`TMUX_PANE`, in a `systemd-run --user --scope` of its own under the service, because `KillMode=mixed` would kill a window left in the service's cgroup on every restart. Rename goes by session id and shows the name tmux really gave (`:` and `.` become `_`; `#` is doubled, since `rename-session` expands formats). `tmuxctl rename` and `tmuxctl open` do the same. **Send text** (user's call 2026-11-10; they know and accept that the tool no longer only reads sessions and tidies them up, it now types into them): a box under the preview (Enter sends, Shift+Enter is a new line, "Press Enter" can be switched off) and `tmuxctl send [--no-enter] <name> <text…>`, both through `src/send.ts`. **Enter is never part of the text**: the text goes first, then after 200 ms (the inbox tool's pause) Enter as its own `tmux send-keys -t %N Enter`. One line is literal keys, `send-keys -t %N -l -- <text>`. Text with a line break or a tab, or over 2000 characters, is a bracketed paste through a buffer of its own (`set-buffer`, then `paste-buffer -p -d`), so the lines stay text and the one Enter submits or runs the whole of it; a program that didn't ask for bracketed paste gets each line break as an Enter. Measured on Claude Code 2.1.322 and tmux 3.6a: a `\n` sent as a key neither submits nor breaks the line (`a\nb` arrives as `ab`), the Enter key submits, a paste keeps its lines. Everything is an argv list, no shell; a trailing `;` is sent as `\;` because tmux would take it as a separator. Line breaks at the end and control characters other than a tab are dropped; empty text is refused, as is more than 32 000 characters. **Target:** the session by id, and in it the active pane of the current window, the one the preview shows, looked up once and then addressed by pane id so text and Enter can't part ways. A pane in copy mode is refused, since the keys would be copy-mode commands. One send at a time. **Notifications** for every session, on working → finished and → waiting, sent through the core (row "Notifications"; since 2026-11-10 the tool no longer runs `notify-send` itself): kinds `finished` and `waiting`, title "<session> finished" / "<session> is waiting on you", no body, so only the session's name and the state ever go in, never pane text. `src/alerts.ts` decides when. Claude: its status transition. Other programs: output for at least 10 s after the last key press, then 5 s of silence. Nothing for what was already so at start. `MOTHERAPP_NOTIFY=off` on the core silences popups and sounds, for a test core. **Privacy:** preview and Claude's text exist only in the result of the `view` action, never in state or a log; the page asks only while visible and only for the selected session. `view`, `open` and `send` are `localActions`, so a LAN client sees the list, states and timeline (and may Rename and Kill, all-or-none) but no screen text, no Open and no Send box. Sent text is treated like the preview: it goes to tmux and nowhere else, never into state or a log, which gets only the session and the length. Colour is `capture-pane -e` through a small SGR parser (`src/ansi.ts`), no dependency. **Needs you** (2026-11-07): sessions waiting on the user as chips beside the summary, in one sticky line of fixed height, so nothing below moves when one appears; a click selects. **Projects:** sessions group by the git top level of where they work: for a Claude the latest `cwd` in its transcript, not the pane's folder (a session can sit in a parent folder that isn't a repo and work in a repo below it); otherwise the folder. The group header shows branch and uncommitted files (untracked included). `src/git.ts`: per folder, 30 s TTL (120 s for a non-repo), one git at a time and never in the poll's path, `--no-optional-locks`, `core.fsmonitor=false`, 5 s timeout; a non-repo, a broken repo or no git just shows no branch. **Sub-agent list** in the details: description, type and time running, from the same four checks as the count; the time is the meta file's mtime, which marks the start of this run. In `view` only, so local only; the count stays in state. **Stale:** a session at rest with no output for 3 days or more (longer than a weekend) gets an "N d idle" flag and a muted name, and nothing else happens. **Scrollback:** "Scroll back", or the wheel at the top of the preview, calls the local-only `history`: a frozen snapshot of up to 3000 lines of tmux scrollback plus the screen, at most 2 MiB, newest kept. A Claude on the alternate screen has no scrollback tmux can reach (all the real ones), so it gets the end of its conversation from the transcript instead: prompts, replies and tool names, at most 1 MiB, and the page says so. A live refresh touches the preview only at its bottom: scrolled up or in history it stays put until "Back to live". |
| Shortcuts tool | `tools/shortcuts/` per issue #7: owns only `motherapp-*` custom keybindings; key capture via a custom page. Groups (#19) are derived, never stored: a `"Group: "` name prefix, else (motherapp's own) the tool whose wrapper the command calls, else the same program; at least 2 per group, 3+ start collapsed. **A name prefix spans both cards** (#27, option (a), 2026-10-21): a prefix used by motherapp's own and others' shortcuts makes one group in a "Shared groups" card above the others, with Edit/Remove only on the owned rows; the tool and program rules stay per card. The Group field suggests only prefixes in use. |
| Inbox tool | `tools/inbox/` per #11: own 127.0.0.1 listener exposed only via a cloudflared **quick tunnel** (never named tunnels: user's call, 2026-10-20; a cloud session can reach it, #16); hashed tokens, delivery without reading the screen by default (`checkScreen: false`, #22); with `checkScreen: true`, idle-only delivery plus a confirmed "Deliver now" override on the page, peer-message rule in CLAUDE.md. A link has just a **label and an expiry** in hours (default 24); no per-link message count or length. Fixed guards stay: 32 KiB body cap, text cleaning, 6 messages/min per link, 10 queued per link. A narrow exception to the all-or-none network switch. |
| CPU tool | `tools/cpu/` (`cpuctl`), first step toward a Linux replacement for ClockTuner for Ryzen (2026-10-22). **Read-only on AMD**: never writes to hardware or sysfs there; on Intel it applies clock caps, turbo, EPP and PL1/PL2 (see "CPU limits (Intel)"). **Custom page** (`page.ts`, user's call 2026-10-23) combining two mockup directions: the **Die map** (a drawn package, two CCD chiplets over the I/O die, each CCX core \| L3 \| core, cores as a live clock/heat map, hover or tap a core/CCX/I/O die for a details panel, a bottom sheet on a phone; each CCX's disabled 4th slot is drawn neutrally as "3 of 4 active", since which slot is fused off isn't known yet) and the **Tuning console** (per-CCX target \| actual (fastest core, a core = its busier thread) \| Δ \| die temperature; the two profiles side by side with differences highlighted; a 3-minute clock + temperature timeline built in the browser while the page is open; an event log of real events only: tool started, cpu.json created/changed, boost/governor/EPP changed, kept by the service as a capped `events` list of 50). On top a **three-way selector Stock \| Underclock \| Overclock**, Stock = `active: null` (user's call, 2026-10-23); it only shows the active profile and is disabled ("Switching profiles comes in a later step"), no write action exists. **Order by Layout \| Rank** (preferred-core rank `amd_pstate_prefcore_ranking`, highest first, ties in cpu order): the core list reorders, the die map keeps positions and shows #1–#n badges. Board sensors (asusec) and details (driver, governor, EPP, ranks; Vcore, PPT and SMU OC mode as "—, needs the SMU") are collapsed sections. The drawing is used only for 2 CCD × 2 CCX with ≤ 4 slots per CCX; any other shape (a 1-CCD Ryzen, Zen 3, Intel) gets a plain core grid. **Vendor** (user's call, 2026-10-23): the sidebar title comes from `describe` (the core now prefers it over the manifest's neutral "CPU"): "CPU - AMD" / "CPU - Intel" / "CPU" from `vendor_id`. Profiles, the per-CCX table, the selector and the SMU placeholders are AMD family 0x17 only; elsewhere the page shows the grid (Intel hybrid P-/E-cores from `/sys/devices/cpu_core` and `cpu_atom`), cores, timeline, sensors and log plus "Profiles and per-CCX tuning are for AMD Ryzen (Zen 2) only.", and, on other vendors, **cpu.json is neither read nor created** (`cpuctl profiles` says so); Intel gets the Limits card and its own cpu.json profiles instead (row below). Intel: temperatures from hwmon `coretemp` (Package id N, Core N matched by `core_id`), boost from `intel_pstate/no_turbo` when there is no cpufreq `boost`. Data: CCX = CPUs sharing an L3 (`cache/index3/shared_cpu_list`), CCD = 2 CCX on family 0x17, 1 from 0x19; CCX slots from the `topology/core_id` stride; heat scale from `amd_pstate_lowest_nonlinear_freq` (else `cpuinfo_min_freq`) to the max boost; k10temp (Tccd1 = CCD0, Tccd2 = CCD1) + asusec (found by hwmon `name`, a -40 °C T_Sensor is hidden). Reads sysfs and cpu.json every 1 s only while watched. `cpuctl status [--json]` and `profiles [--json]` read fresh. **Profiles** (user's call, 2026-10-22): exactly two, `underclock` and `overclock`, in `~/.config/motherapp/cpu.json` (created with defaults if missing, never overwritten when broken): `{ version: 1, active: "underclock" \| "overclock" \| null, applyOnStart: true, profiles: { underclock: { name, ccx: null, vcore: null }, overclock: { name, ccx: [4250, 4250, 4125, 4100], vcore: 1.25, cinebenchR20: 6916, powerW: 137 } } }`. `active: null` = stock, untouched; `null` values = not set yet (the underclock values aren't known, none are made up). The active profile will be **re-applied automatically when the tool starts** (the service starts tools at login) when `applyOnStart` is true. Nothing applies anything yet. |
| CPU limits (Intel) | **Clock caps, turbo, governor/EPP and PL1/PL2 only** (user's call 2026-10-23, "do those safe ones"); no voltages, no MSRs. Why XTU on Windows refused with virtualization on doesn't apply: under Hyper-V/VBS Windows is a guest whose MSR writes are filtered, KVM leaves the Linux host on bare metal. **Access**: `motherapp-cpu-access.service`, a system oneshot (`packaging/`, offered by `install.sh` with sudo after asking, removed by `--uninstall`) runs `/usr/local/lib/motherapp/cpu-access <primary group>` at boot and after each resume: `chgrp` + `g+w` on `cpufreq/policy*/{scaling_max_freq,scaling_governor,energy_performance_preference}`, `intel_pstate/no_turbo`, `cpufreq/boost`, and the `long_term`/`short_term` `power_limit_uw` of package RAPL zones (`intel-rapl:N`, `intel-rapl-mmio:N`, never subzones). The kernel validates every value. Chosen over a sudoers helper or pkexec: no password at login, so apply-at-login works, and nothing root-side parses input. **Profiles** in the same `cpu.json` (Intel shape, `src/intel.ts`): `underclock` defaults to Intel's 13900K Baseline power profile, PL1 125 W / PL2 188 W; `overclock` starts empty. Fields `maxMHz` (all cores, P-cores on a hybrid), `eMaxMHz`, `turbo`, `governor`, `epp`, `pl1W`, `pl2W`; absent = stock. Applying = stock merged with the profile, so switching never leaves the previous profile's values behind. **Stock** = the values right before motherapp's first write of a boot, in `$XDG_STATE_HOME/motherapp/cpu-stock.json` keyed by `boot_id`. The selector applies at once (`useProfile`), the Limits card edits profiles in place (`saveProfile`, re-applies when active), `reapply` after something else changed a value (shown as drift), `setApplyOnStart`; the active profile is applied when the tool starts. CLI: `cpuctl limits`, `cpuctl use <stock\|underclock\|overclock>`. AMD stays read-only (SMU step). **Live column** (user's ask 2026-10-23, 1920×1080 screen): the manifest's new `wide: true` lets the page grow to 1600 px; at ≥ 1240 px of page width the Timeline card becomes a sticky right column, "Live": package power / package temp / fastest core tiles with the 3-minute peak, and power, temperature and clock charts (PL1/PL2 as a band on the power chart). Narrower, it sits where the timeline was. Package power = Δ`energy_uj` of the package RAPL zone per poll (`src/power.ts`, `cpu.powerW`); `energy_uj` is root-only (CVE-2020-8694, a power side channel), so the access unit also gives the group **read** on the package zones' `energy_uj`. Accepted for a single-user desktop. On AMD the same read access comes from a udev rule instead (row "Package power on AMD"). |
| Package power on AMD | **A udev rule, separate from the Intel unit** (user's call 2026-11-03). The CPU page's package power reads the package RAPL zone's `energy_uj`, which is root-only (0400). The Ryzen 9 3900X (Zen 2) has `intel-rapl:0` (`package-0`) and the subzone `intel-rapl:0:0` (`core`), both with `energy_uj`, and no `constraint_*` files. `motherapp-cpu-access.service` stays Intel-only and unchanged: it also grants write on cpufreq files that exist under amd_pstate too, which would break "AMD stays read-only". On AMD (AuthenticAMD with a package zone that has `energy_uj`) `install.sh` and `motherapp doctor` offer, with sudo after asking, `/etc/udev/rules.d/70-motherapp-energy.rules` (`ACTION=="add", SUBSYSTEM=="powercap", KERNEL=="intel-rapl:[0-9]*\|intel-rapl-mmio:[0-9]*", RUN+="/usr/local/lib/motherapp/energy-access <group> %k"`) and the root-owned helper `/usr/local/lib/motherapp/energy-access` (`packaging/motherapp-energy-access.sh`, copied like cpu-access). The helper checks the group and the zone name (`intel-rapl:N` / `intel-rapl-mmio:N` whose `name` starts with `package`; the glob also matches subzones, which it refuses) and does `chgrp` + `g+r` on that `energy_uj` only: nothing becomes writable. It is a RUN+= helper because udev's `GROUP=`/`MODE=` apply to device nodes, not to sysfs attributes. Installing runs `udevadm control --reload` and `udevadm trigger --settle --subsystem-match=powercap --action=add`, so no reboot is needed; udev replays every "add" at boot. Suspend/resume: the zone stays (the RAPL driver's PM notifier only saves and restores power limits; a package is removed only when its last CPU goes offline, and CPU 0 stays online through suspend), so the permission holds, and a zone that is ever re-added gets the rule again. Up to date = the installed helper equals `packaging/` and the rule equals what would be rendered now. `doctor` warns when `energy_uj` isn't readable or the rule/helper is missing or out of date; `--uninstall` offers to remove both (the file stays readable until the next reboot). |
| thermald vs PL1 | **thermald is turned off** (user's call 2026-10-23). Measured on the 13900K: with `thermald --adaptive` running, a PL1 of 125 W went to 99.5 W and back to 253 W within 25 s, every 15-20 s after; PL2 was never touched. The CPU page and `cpuctl limits` say so while thermald runs (`thermaldText`, found by `/proc/*/comm`), and `install.sh` offers `sudo systemctl disable --now thermald` in the CPU limits section (asks first; undo: `enable --now`). |
| Overclock = undervolt first | **Decided, built 2026-10-24** (user's call 2026-10-23: "Undervolt" over power unlock and ratio OC). A negative core + cache voltage offset through the OC mailbox (MSR 0x150, planes 0 and 2; on Raptor Lake they take the same offset), in an `undervoltMV` profile field, 0 to −150 mV in 5 mV steps, never positive; stock is 0 (offsets reset at every reboot). Root side: `packaging/motherapp-cpu-voltage.sh`, installed root-owned as `/usr/local/lib/motherapp/cpu-voltage read\|set <mV>` (checks the range itself, needs msr-tools), and `/etc/sudoers.d/motherapp-cpu-voltage` (NOPASSWD for that one path, checked with `visudo -c` before it is moved in), both from the installer's "CPU undervolt" step. The tool runs it with `sudo -n` and never gets `/dev/cpu/*/msr` (root-equivalent). Each call is a sudo run (a journal line), so the offset is read once and again only when set, never polled. Crash guard (`~/.local/state/motherapp/cpu-undervolt.json`): a new negative offset starts a 10-minute **trial** (offset, boot id, time), written before the offset is set; a trial that runs its course on the same boot is cleared; a tool start that finds a trial from another boot (a crash, or a restart within 10 minutes) turns it into **blocked**: the profile is applied without the undervolt until the user applies it again ("Retry undervolt" on the page). The probe passed 2026-10-24 after Undervolt Protection was turned off; the installed helper read `core 0` / `cache 0` on the 13900K the same day. **The Overclock profile is undervolt-based** (user's call 2026-10-24, over ratio overclocking, which needs more voltage and is what Raptor Lake degrades from): defaults PL1 = PL2 = 253 W (Intel's unlimited "Extreme" figure) plus −25 mV, a safe start to lower in 5–10 mV steps. Ratio overclocking (MSR 0x1AD / mailbox) is not planned. |
| Inbox screen check | **Off by default, accepted** (user, 2026-10-21): messages are typed and submitted without reading the screen, so an Enter can answer a permission prompt that happens to be open. Accepted because links are the user's own, short-lived and revocable. `checkScreen: true` in `inbox.json` turns the check back on. |
| Version scheme | **`v<N>-<hash>[-dirty]`** (#17): `<N>` is a hand-bumped number in `VERSION` (starts at `1`; the npm `0.1.0` fields are never shown), `<hash>` the short git hash, `-dirty` when `git status --porcelain` isn't empty at build time. `scripts/build-info.sh` computes it; `npm run build` and `install.sh` write the gitignored `build-info.json` (`version`, `hash`, `dirty`, `builtAt`), which the core reads at start (missing → `v?-unknown`). Shown in the sidebar footer, Settings, the "motherapp core starting" log entry, `motherapp --version` and `install.sh` (`OK version …`). The core caches the checkout's HEAD (`git rev-parse`, at most once a minute, "Check again" refreshes) and reports "running v1-abc1234, checkout is at v1-def5678, run `motherapp install`" via `version.get` and `/api/status`. |
| `motherapp` command | `~/.local/bin/motherapp` (#17), written by `install.sh` like the tool wrappers; runs `scripts/motherapp.sh` (bash; Node only reads the core's status JSON). `install`/`update`: `git fetch` + `git pull --ff-only` on `main`, refusing on local changes, another branch or diverged history (never stashes, resets or merges), then `./install.sh --yes`: unattended, but it **never removes apt packages** (user's call, 2026-10-20: an update has no reason to remove anything; if one ever would, the installer stops and says so; sudo itself may still ask for a password), then old → new version, the new commits and the HTTP check; "already up to date" re-installs only when the build is missing or stale. Also `status`, `version`/`--version`, `doctor [--yes]`, `logs`, `open`, `uninstall`, `help`. **`check` is renamed `doctor`, with no alias** (user's call 2026-11-03): `motherapp doctor` runs `./install.sh --doctor` (only `--yes`/`-y` and `--allow-removals` are passed on), and `make check` is now `make doctor`. Page and CLI hints that need a sudo step point at `motherapp doctor`, because `motherapp install` does nothing when the checkout is already up to date. |
| Releases | (2026-10-21) The `VERSION` number is the release number. A release is an **annotated tag `v<N>` on `main`** plus a GitHub Release, which `.github/workflows/release.yml` creates on the tag push (body `docs/releases/v<N>.md`, else generated notes; parked at `docs/releases/release.yml` until it can be pushed with `workflow` scope). v2 is the first. **Update check:** the core asks `api.github.com/repos/erkantaylan/motherapp/releases/latest`, unauthenticated (the repo is public), at start, every 6 h and from Settings → "Check for updates". It caches the answer and its ETag in `~/.local/state/motherapp/release-check.json` (`If-None-Match`; a 304 is free), times out after 10 s, and waits out a rate limit until its reset. It never blocks or crashes: errors show as "couldn't check: <reason>" and the last good answer stays. It compares `tag_name` with the running build's number. `version.get` and `/api/status` carry `release: { latest, latestUrl, newer, checkedAt, error? }`, a finished check is pushed to open pages, the sidebar footer shows "· v3 available", and `"updateCheck": false` in config.json turns the check off. **Update from the browser:** Settings → "Update now" (after a confirm) runs `systemd-run --user --unit=motherapp-update --collect` with `~/.local/bin/motherapp install` (else the repo's `scripts/motherapp.sh` with the core's Node), outside the service, so it survives the restart. It refuses while that unit is active. Output goes to `~/.local/state/motherapp/update.log`, ending with a "finished … exit N" line, and the core reads that back for the page: running/done/failed, the tail, old → new, and the refusal reason. The page reconnects on its own. `MOTHERAPP_UNATTENDED=1` makes `install.sh` use `sudo -n`, so a step that needs a password fails at once with "run `motherapp install` in a terminal". **The update pulls `main`, not the release tag:** tags are on `main`, so `main` is at or past the latest release. |
| Tool order | user-set in Settings (drag the handle, or arrow keys on it), saved as `order` in config.json; new tools are appended |
| Notifications | **The core owns delivery; every tool goes through it** (user's call 2026-11-10; before, the tmux tool ran `notify-send` itself). **One path:** a tool sends the `notify` notification `{ kind, title, body? }` (SDK: `tool.notify(...)`), and the core adds the tool's id, name and icon itself, so a tool can't pose as another. Never a secret in it, as for state and logs. **Kinds:** a tool declares them in its manifest, `"notifications": [{ "id", "label", "sound"? }]` (the manifest, not `describe`, so Settings can list them while the tool is stopped or disabled); tmux has `finished` and `waiting`. An undeclared kind is still delivered, without a sound and without a Settings row, with one warning in the log. **Popup:** application "motherapp" with the motherapp icon and the hint `desktop-entry=motherapp`, so GNOME files it under motherapp and lists motherapp in Settings → Notifications (checked on GNOME Shell 46: `application-children` gained `motherapp`). Title = the tool's title, the event itself ("Nebula finished"); below it the tool's name ("tmux"), then the tool's body if any. `notify-send`, else `gdbus`; the body is escaped as markup. No actions: a click does nothing. **Desktop entry:** `install.sh` writes `~/.local/share/applications/motherapp.desktop` from `packaging/motherapp.desktop` (Name, `X-GNOME-UsesNotifications=true`, `Exec=xdg-open http://127.0.0.1:<port>/`, the port resolved as for the unit) and copies `web/public/icon.png` to `~/.local/share/icons/hicolor/512x512/apps/motherapp.png`, which `Icon=` names by absolute path (no icon cache to refresh); `motherapp doctor` reports both (a warning, not a failure), `--uninstall` removes them, a file it didn't write is left alone. **History:** the last 200 in memory, not persisted: seq, time, tool id, tool name, tool icon, kind, title, body. **Settings**, core-owned, in config.json `notifications` (only what the user changed): mute all; per tool on/off; per kind on/off and a sound. The tool never learns any of it. A tool or kind that is **off is dropped entirely** (no history); with **mute all** it is **recorded** (`muted: true`) and reaches open pages, with no popup and no sound. **Sounds:** `pw-play` on a stock sound from `/usr/share/sounds/freedesktop/stereo/*.oga`, listed at runtime, or "none"; defaults tmux `finished` → `bell`, `waiting` → `window-attention`; only a listed name is ever accepted, never a path; a missing directory or `pw-play` is one warning. Settings can preview a sound (it plays on this computer). **Rate limit:** 10 per tool in any 10 s, the rest dropped with one warning; titles are cut at 200 characters, bodies at 1000. **Silence:** `MOTHERAPP_NOTIFY=off` turns popups and sounds off for a whole core (history and settings still work), and a core started under `node --test` is off unless it says `on`; this replaces `MOTHERAPP_TMUX_NOTIFY`. **Browser protocol** (`packages/protocol/src/ui.ts`): `notifications.subscribe` (backlog + live `notification` pushes), `notifications.settings.get`, `setMuted`, `setTool`, `setKind`, `previewSound`, and a `notifications.settings` push on every change. **LAN:** a LAN client may read the history (user's call) and, like enabling a tool or re-ordering, change these settings (all-or-none). **In the web page** (built 2026-11-10): the history panel on the tool strip and the Settings UI, row "Tool strip and notification panel". The tray icon is built: row "Tray icon". Code: `core/src/notifications.ts`, `core/src/notifyDelivery.ts`. |
| Tool strip and notification panel | **A thin strip on the right edge of every page, like an IDE's tool window bar** (user's call 2026-11-10; built). One button for now, a bell; `ToolStrip.add()` takes more (`web/src/toolStrip.ts`). **Docking:** a click shows the button's panel beside the page, which narrows (not an overlay); a second click or the panel's ✕ hides it. It docks from a 1480 px window up: then a page is still at least as wide as it is in an 1100 px window without the panel, so docking never drops a page into its narrow layout (the tmux page's wide layout starts at 1100 px). Below that the 340 px panel lies over the page's right side, beside the strip; at 720 px and below the bell sits in the top bar and the panel covers the page until closed. Escape closes a panel that lies over the page. The strip is 32 px wide, no wider: the tmux page needs 820 px of its own in an 1100 px window. **Remembered per browser** (localStorage): which panel is open, restored on load only where it docks. **Bell badge:** how many notifications are newer than the newest one the panel has shown, by time (seq starts over with the core), so it survives a reload; opening the panel clears it. **Panel:** newest on top; tool icon, title, time (`14:32`, with the day for another day), body below; one that arrived under mute all is dimmed and tagged "muted"; a "Mute all" switch in the header; an empty state; a link to Settings. **One subscription for the app**, renewed on every (re)connect: the backlog replaces the page's list and pushes that arrive before it are held and merged by seq, so nothing shows twice and a restarted core's empty history is taken over (`web/src/notifications.ts`, `web/src/notifyPanel.ts`). **Settings → Notifications:** Mute all; per tool on/off; per kind on/off, sound (the core's list plus "No sound") and a play button; one grid with subgrid rows, as the tool list. The rows follow the `notifications.settings` push and are updated in place. The play button plays on the computer motherapp runs on, so it is shown only on a page opened at a localhost address, and is disabled for "No sound" and on a core that plays no sounds; such a core (`delivery` false) says so in a banner. **Settings → Desktop:** "Show tray icon" (`tray.get`, `tray.setEnabled`, the `tray` push), with the state or the failure under it, and a note on a core that never shows one. |
| Tray icon | **An icon in the notification area that says motherapp runs and is healthy** (user's call 2026-11-10; revisits "Launcher"). **Icon:** the motherapp icon; a variant with an amber "!" badge (`core/tray/warning.png`, composed from the icon with PIL) while an enabled tool is `down` or `failed`, and until it runs again, so it doesn't blink while the core retries. **Menu** (on Ubuntu's indicator a click always opens a menu): "Open motherapp" (`xdg-open http://127.0.0.1:<port>/`, the address the desktop entry opens; under the unit in a `systemd-run --user --scope` of its own, as tmux's Open); a "Mute notifications" tick bound to the notification service's mute all, both ways; one disabled status line: "6 tools running", "tmux has crashed", "tmux keeps crashing" (`failed`), "2 tools have crashed". No waiting-session count, nothing else. **How:** Node has no D-Bus here and the core's only dependency stays `ws`, so the icon is a Python helper, `core/tray/motherapp-tray.py` (GTK 3 + `AyatanaAppIndicator3` through `python3-gi`; shown on GNOME by the `ubuntu-appindicators` extension), run from the checkout with `/usr/bin/python3`, started and supervised by `core/src/tray.ts`. **Protocol:** JSON lines over the helper's stdio. Core → helper, always the whole view: `{"icon":"ok"\|"warn","status":"…","muted":bool}`. Helper → core: `ready`, `host {connected}`, `open`, `mute {muted}`, `unavailable {reason, retry}`. **Lifetime:** a plain child of the core, so it is in the service's cgroup (`KillMode=mixed`), and it exits when its stdin closes: it can't outlive the core, in or out of systemd. **The icon vanishing when the service dies is accepted.** **Environment:** the unit can lack the display (measured: the running service had only `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS`), so a core without `WAYLAND_DISPLAY`/`DISPLAY` takes them and a few more from `systemctl --user show-environment` for the helper and for `xdg-open`. **Never in the way:** no Python, `gi` or typelib is one warning and no retry; a crashing helper is retried after 1, 2, 4, 8, 16, 30, 30 s, then one warning and no more until the setting is turned off and on or the core restarts; no tray host is one warning while the helper waits for one. **Off switch:** config.json `tray` (default true), a "Show tray icon" setting over `tray.get` / `tray.setEnabled { enabled }` → `TrayInfo { enabled, available, state: off\|starting\|running\|failed, message? }`, pushed as `tray` (a LAN client may change it, all-or-none); `MOTHERAPP_TRAY=off` for a whole core, and off under `node --test` unless `on`; `npm run dev` sets it off. **A private core started by hand needs `MOTHERAPP_TRAY=off`**, as it needs `MOTHERAPP_NOTIFY=off`. `motherapp doctor` has a `tray-icon` row (a warning naming the missing apt packages; nothing is installed for it). **Not built:** the "Show tray icon" row in the web Settings page. |
| Polling | tools poll only while a visible page watches them (core sends `watch` edges); actions and CLIs always read fresh; event-driven sources (pw-dump) stay on. **Exception: the tmux tool polls always** (user's call 2026-11-07), because notifications and the timeline have to work with no page open; its preview still follows the page. |

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

- The `127.0.0.1` listener always stays. While the switch is on and the network is trusted,
  the core also listens on each non-loopback interface address (a `0.0.0.0` bind on the same
  port fails with EADDRINUSE next to `127.0.0.1`); `core/src/lan.ts`. The switch itself is only
  operable from localhost (a remote client must not be able to keep it on).
- Pairing (desktop shows a QR code with a one-time token, phone scans it): **not planned for
  now** (2026-10-21).
- A per-action `remote: false` flag was dropped when § 3 decided all-or-none. Its narrow form came
  back with the tmux dashboard: a tool's `localActions` (§ 3 "Network switch scope").

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
| `notify` | tool → core, notification | `{ kind, title, body? }`: ask the core to notify the user (§ 3 "Notifications"). |
| `watch` | core → tool, notification | `{ watching }`: a visible tab shows the tool's page. Sent on edges only: 0→1 viewers at once, 1→0 after 5 s. Tools poll only while watched (§ 3 "Polling"). |

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
10. *Answered (§ 3): served on the web; a tray icon was added 2026-11-10 (§ 3 "Tray icon").*

### Audio

11. *Answered (§ 3): start small.* Bluetooth profiles: **decided and built**, see "Outputs and
    inputs = routes" in § 3. Mic gain isn't scheduled.
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

### CPU

20. *Answered (§ 3, "CPU limits (Intel)"): the safe tiers, clock caps / turbo / governor / EPP and PL1/PL2, through a boot-time access unit.* Undervolting (MSR 0x150) was built next (§ 3, "Overclock = undervolt first"); ratio overclocking stays open; the Hyper-V vs KVM finding is in `docs/lessons/2026-10-23-intel-tuning-research.md`.

### Housekeeping

19. *Answered: yes, and the user decides when (§ 3).*

## 6. Target machine facts

Captured because a cloud session cannot inspect the machine.

- Ubuntu with **GNOME Shell 46**, extensions: dash-to-panel, per-app-volume, ding,
  tiling-assistant, ubuntu-appindicators.
- **PipeWire + WirePlumber** (`pw-dump`, `wpctl`, `pw-play`, `pw-record`, `pw-cli` present). No `pactl`.
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

Checked 2026-10-23 on the machine this checkout runs on: **Intel Core i9-13900K** (microcode
0x133), kernel 7.0.0-38, bare metal (`systemd-detect-virt` = none), `kvm_intel` and `msr`
loaded, Secure Boot disabled, lockdown `none`, `intel_pstate` active (no_turbo 0, max 5.5 GHz,
EPP performance), RAPL PL1 = PL2 = 253 W, boot flags `intel_idle.max_cstate=1
processor.max_cstate=1`. The earlier CPU lessons were written on a Ryzen 9 3900X. Board **ASUS PRIME Z690-A**, BIOS 4505 (2025-11-29). Undervolt probe 2026-10-23: a −5 mV core/cache offset through MSR 0x150 reads back 0 mV (offsets ignored), OC lock bit (MSR 0x194 bit 20) is 0: the BIOS's Undervolt Protection is on. After turning off Undervolt Protection (and IA CEP) in the BIOS, 2026-10-24: −5 mV reads back −4.9 mV on both planes: offsets work.

## 7. Prior art worth reading

- [pwvucontrol](https://github.com/saivert/pwvucontrol) — Rust + gtk4-rs + libadwaita +
  wireplumber-rs per-app/per-device mixer; good reference for the WirePlumber model.
- [Cockpit](https://cockpit-project.org/) — local web-based system manager with a plugin model
  (manifest + HTML/JS, commands and DBus through a bridge). Source of the logs/storage/networking
  ideas.
- Per App Volume GNOME extension — `Gvc`-based per-app sliders in the panel.
