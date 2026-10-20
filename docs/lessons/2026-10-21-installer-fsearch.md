# Installer: optional FSearch from its PPA (2026-10-21, local session)

Added FSearch (#24) to `install.sh` as an optional dependency, and a Dependencies table to the README.

## Lessons

- [both] `scripts/test-install.sh` hangs when its stdin is an open pipe that never closes, as in
  a backgrounded agent shell: `--uninstall` and other prompts wait on `read`. → Run it as
  `bash scripts/test-install.sh </dev/null`.
- [both] A new optional check changes every test case's fake machine. → Make the default fake
  machine *have* the dependency (stub + dpkg entry) and remove it only in the new cases, so
  existing `calls_lacks 'apt-get'` assertions keep holding.
- [both] `--check` on a fresh fake machine fails for unrelated reasons (no unit, no wrappers). To
  test that an optional item doesn't fail the check, install first (`--yes`), then remove the
  item and run `--check`.
- [local] FSearch isn't in Ubuntu 24.04's archive. The installer adds the PPA, simulates
  `apt-get -s install fsearch`, and refuses outright if apt would remove anything.

## Open

- The FSearch trial itself (#24): index times, file count, database size, RAM, the user's verdict.
