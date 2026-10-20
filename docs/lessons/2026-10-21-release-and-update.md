# One-line install, release check, Update now, release v2 (2026-10-21, sub-agent)

Added `scripts/get.sh` (+ `scripts/test-get.sh`), the core's GitHub release check
(`core/src/releases.ts`), Settings → Update now (`core/src/updater.ts`, a `motherapp-update`
transient unit), `MOTHERAPP_UNATTENDED` sudo handling in `install.sh`, the release workflow and
`docs/releases/v2.md`. `VERSION` is 2.

## Lessons

- [cloud] Bumping `VERSION` broke ~20 checks in `scripts/test-install.sh`: they hard-coded
  `v1-$H`, and the fake repos copy the real `VERSION`. → They now use `$V` (read from
  `VERSION`). The "number comes from VERSION" check writes 7, not 2, because writing the
  current number leaves the tree clean. Next bump: nothing to change there.
- [both] `install.sh` now defines a `sudo()` function (unattended: `sudo -n` or fail with
  "run `motherapp install` in a terminal"). `command -v sudo` finds functions, so `have` uses
  `type -P` now. Keep `have` binaries-only if you add more wrapper functions.
- [cloud] Every test that spawns the real core (`core/test/e2e`, the tools' e2e tests,
  settings-layout) would now ask GitHub. → `main.ts` turns the check off when
  `NODE_TEST_CONTEXT` is set (node --test sets it, and children inherit it), unless
  `MOTHERAPP_RELEASE_URL` is given (`off` also turns it off).
- [cloud] Node's `fetch` refuses "bad ports" (1, 6000, …) before connecting ("bad port"), so a
  "connection refused" test needs a port that was free a moment ago: listen on 0, close, then use it.
- [cloud] The update runner tests use a fake `systemd-run`. It parses `--setenv=`, runs the
  command in the background, and holds an "active" file that the fake `systemctl is-active`
  reports. The real bash wrapper and `update.log` parsing are exercised that way. Redirect the
  background job's stdio (`</dev/null >/dev/null 2>&1 &`), or `execFile` waits for it.
- [cloud] The worktree guard refused a `python3` heredoc that edited a file containing "git",
  and `sed -n "$(grep …)p"`. → Use Edit, or sed with literal line numbers.

## Open

- On the machine: the real `systemd-run --user --unit=motherapp-update --collect` from the
  core's service environment (PATH, whether `/bin/bash` and `~/.local/bin/motherapp` resolve),
  and that the unit really survives `systemctl --user restart motherapp`.
- Whether `sudo -n true` behaves as expected there (no cached credentials → fails at once), so
  an update that needs apt fails with the terminal hint instead of hanging.
- Node's `fetch` on the machine reaching api.github.com (no proxy there), and the 304 on the
  second start (check `release-check.json` keeps the ETag).
- After Update now, the open page still runs the old bundle until it is reloaded. The Settings
  line says "reload the page for the new UI" when the running version changed.
