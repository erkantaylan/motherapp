# First build session (2026-10-19, main session coordinating sub-agents)

Covers the design rounds plus the core, installer and audio agents.

## Lessons

- [cloud] The container has **Node 22**, but the project needs Node 24. → Run
  `D=$(dirname $(npx -y node@24 -e 'console.log(process.execPath)'))` and put `$D` first on PATH
  (`PATH=$D:$PATH make verify`). The npm registry is reachable, so this works.
- [cloud] The container **runs as root**. `install.sh` refuses root (exit 2), so it can't be
  smoke-run here as-is. → Use `scripts/test-install.sh`, which runs the installer against
  stubbed commands and a fake `$HOME`/root.
- [cloud] The container is also **Ubuntu 24.04** with apt lists available. That makes it good
  for checking package names and `.deb` contents (`apt-cache`, `apt-get download`). It is not
  the machine itself, though: no PipeWire, no monitors, no `/dev/i2c-*`, no systemd user
  session. → Test audio and brightness logic against fixtures and fake commands on PATH, and
  leave real-device checks to the local tester.
- [cloud] Some outbound hosts aren't reachable, e.g. NodeSource and the fnm install URLs. → Mark
  anything derived from their docs as "unverified" and let the local run confirm it.
- [cloud] The target machine can't be inspected from here. → Ask the user to run a read-only
  script and commit its output (`machine-facts/collect.sh`). That beat guessing: it overturned
  "Ubuntu version unknown" and showed that `pactl` and the Wp typelib were missing.
- [cloud] Agents started with worktree isolation live in `.claude/worktrees/`, which showed up
  as untracked. → It's in `.gitignore` now. Don't commit it.
- [cloud] The stop hook complains about untracked files while a background agent is mid-build.
  → Don't commit another agent's in-progress files. Each agent commits once its own checks
  pass.
- [both] Several agents push to `main` in parallel. → Each one runs `git fetch origin main &&
  git merge origin/main`, re-runs `make verify`, then `git push origin HEAD:main`, and repeats if
  the push is rejected.
- [cloud] The GitHub MCP tools can disconnect and reconnect mid-session. → Reload them with
  ToolSearch when they come back. Don't conclude access is gone.
- [local] `wpctl` has **no `--version`** flag. → Get versions from
  `dpkg-query -W wireplumber`.
- [local] `pactl` isn't installed even though `pipewire-pulse` runs. → Don't depend on `pactl`;
  the audio tool uses `pw-dump`/`wpctl`/`pw-play`/`pw-record`.
- [local] `ddcutil` 1.4.1: `detect` takes ~1.0 s and one `getvcp` with `--bus` takes ~0.5 s. →
  Cache everything; never put ddcutil on the page-load path.

## Open

- Nothing has run on the real machine yet: the installer, the core and the audio tool. The first
  local test should add an entry with whatever broke.
- Whether `i2c-dev` loads at boot on the machine is unknown.
