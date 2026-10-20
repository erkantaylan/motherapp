# Versioning and `motherapp install` (2026-10-20, sub-agent: issue #17)

Added `VERSION` + `scripts/build-info.sh` (v<N>-<hash>[-dirty], `build-info.json`), the core's
`version.get` / `/api/status`, the sidebar footer and Settings "Version" section, and
`scripts/motherapp.sh` behind `~/.local/bin/motherapp`. Dropped `doctor`.

## Lessons

- [both] `motherapp install` runs `git pull`, which rewrites `scripts/motherapp.sh` while bash
  is still reading it. → The whole script runs from `main`, and the last line is
  `main "$@"; exit $?`, so bash has parsed everything before the pull happens. Keep it that way
  in any script that updates its own checkout.
- [both] `build-info.json`, `node_modules/` and `web/dist/` must be gitignored, or every build
  marks the next build `-dirty`. `scripts/test-install.sh` copies the real `.gitignore` into
  its fake repos for that reason and checks the tree is clean after an install.
- [both] Under `env -i` (how the tests start a wrapper; GNOME shortcuts get more than that)
  `HOME` is unset and `set -u` stops a script at its first `$HOME`. → `motherapp.sh` sets HOME
  from `~` (the passwd entry) when it's empty.
- [cloud] `scripts/test-install.sh` now uses real `git` (added to its `sysbin`) for a bare
  "origin", a "seed" clone to push from, and the checkout, with `GIT_CONFIG_GLOBAL=/dev/null`
  and a fixed identity. The checkout's `install.sh` is a stub that writes `build-info.json`
  through the real `build-info.sh`. Copy `upd_case` for more update scenarios.
- [cloud] The core compares the running build's short hash as a **prefix** of the checkout's
  full HEAD: git may abbreviate with more than 7 characters, so comparing short with short can
  report "behind" for the same commit.
- [cloud] The worktree guard refused `D=$(dirname $(npx -y node@24 -e '…'))` inline and even
  `sh script.sh > log; grep …` in one call. → One plain `sh <scratchpad>/v17-verify.sh` per
  call, with the logging inside the script.

## Open

- On the machine: that `motherapp install` from a GNOME shortcut (no terminal) behaves, and
  whether `sudo` prompts from `./install.sh --yes` (only when something is missing) are a
  problem there. `--yes` still accepts sudo steps; only removals stop it.
- No Update button on Settings yet (it would need `systemd-run --user` so it survives the
  restart, plus a way to show the result after the page reconnects).
