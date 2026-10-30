# Service dead after reboot: apt autoremove took nodejs (2026-10-28, main session, local)

`motherapp.service` looped on `status=203/EXEC` (8000+ restarts since boot): `/usr/bin/node` was
gone. `apt autoremove` on 2026-10-27 02:08 (run while installing Heroic) removed
`nodejs 24.22.0-1nodesource1`, so it had been marked auto-installed. The already-running
service kept going until the next reboot, which hid the cause for a day and a half.

## Lessons
- [local] `203/EXEC` in `systemctl --user status motherapp` means the ExecStart binary is missing,
  not an app crash; the journal has no app output. Check `ls -la /usr/bin/node` first, then
  `grep nodejs /var/log/dpkg.log`.
- [local] The nvm node on the user's PATH (v22) is not what the service runs; the unit hardcodes
  `/usr/bin/node`, so `node -v` in a shell says nothing about the service.
- [local] Fix: `sudo apt install nodejs && sudo apt-mark manual nodejs` (NodeSource repo is still
  configured), then `make restart`.

## Open
- `install.sh` could `apt-mark manual nodejs` when it installs/checks Node, and `--check` could
  flag nodejs as auto-installed.
- The unit restarts every ~2 s forever; a `StartLimitBurst` would stop the log flood.
