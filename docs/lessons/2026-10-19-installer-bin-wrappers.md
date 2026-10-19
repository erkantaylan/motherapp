# Installer: tool commands in ~/.local/bin (2026-10-19, sub-agent: installer follow-up)

Added the manifest `bin` field and `install.sh` wrappers (`~/.local/bin/audioctl`).

## Lessons

- [cloud] The installer now runs the chosen Node (`node -e`) to read manifests, but the fake
  `node` binaries in `scripts/test-install.sh` only answered `--version`. → The fakes now hand
  `-e` to the real Node running the tests (`REAL_NODE`) and echo their arguments when started the
  way a wrapper starts them, so tests can run a wrapper under `env -i` and check what it execs.
- [both] A symlink into `~/.local/bin` (the workaround the audio-tool entry suggested) runs
  `audioctl.ts` through its `env node` shebang, so it picks up whatever `node` is first on PATH
  (Node 22 on the machine). → Use the installer's wrapper. The installer treats a symlink or any
  file without the marker on line 2 as the user's own file and leaves it alone with a WARN.

## Open

- Whether `~/.local/bin` is on PATH in the GNOME session right after the first install
  (Ubuntu's `~/.profile` only adds it if it existed at login), and whether a GNOME keyboard
  shortcut finds `audioctl` by name after a re-login.
