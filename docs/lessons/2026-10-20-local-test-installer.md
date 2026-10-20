# First local run: installer and tool commands (2026-10-20, local tester)

Ran Part A and Part D of issue #2 on the machine, build `d9d7235`. Parts B and C aren't done yet,
apart from comparing `audioctl list` with `wpctl status` under C.1. Results are in the comment on #2;
bugs are in #3, #4 and #5.

## Lessons

- [local] The machine had **two** old Nodes: nvm's v22.23.2 (first on PATH) and Ubuntu's apt
  `nodejs` 18.19.1, which `machine-facts` didn't mention. Installing NodeSource `nodejs`
  replaced the distro build and removed 133 packages (`npm`, `eslint`, `webpack`, `node-gyp`,
  `node-*`), and `apt-get install -y` never showed the list (#3). → Before any apt step that
  replaces a package, simulate it (`apt-get -s`) and show the removals in the prompt. nvm was
  already there, so `nvm install 24` would have needed no sudo.
- [local] The NodeSource key URL, the repo line (`node_24.x nodistro main`) and the package
  (`24.22.0-1nodesource1`) all work as `install.sh` writes them. They had been unverified from
  the cloud.
- [local] `i2c-dev` is built into the kernel and there are 9 `/dev/i2c-*` devices, so no boot
  file is needed.
- [local] `~/.local/bin` holds many unrelated binaries (`uv`, `ffmpeg`, `cloudflared`, …).
  Reading them in `$(...)` makes bash warn about null bytes (#4). → Anything that scans
  `~/.local/bin` has to handle binary files.
- [local] On a USB headset with two PCMs, the second sink's `node.nick` is the generic ALSA name
  "USB Audio #1", while `node.description` is "Arctis Pro Wireless Game" (#5). → Don't trust
  `node.nick` alone for titles.
- [local] With `XDG_RUNTIME_DIR` unset, `audioctl` can't reach PipeWire and exits 1. With
  `PATH=/usr/bin:/bin` plus `XDG_RUNTIME_DIR`, the wrapper works, which is what a GNOME shortcut gets.
- [local] `make verify` needs Node 24 first on PATH, but nvm's 22 comes first in the user's
  shell. → `PATH=/usr/bin:$PATH make verify`.

## Open

- Part B, Part C steps C.2–C.15 (including the `machine-facts/pipewire/` captures), and D.3 (a GNOME
  shortcut by name versus by absolute path, before and after a re-login).
