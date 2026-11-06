# tmux dashboard (2026-11-07, sub-agent: tmux dashboard)

`tools/tmux/` is now a custom page with state, preview, timeline, sub-agent count, Open, Rename and
OS notifications. It replaces the tmuxboard prototype. This overrides two earlier entries:
`2026-10-21-poll-only-when-watched.md` (tmux now polls always, by the user's decision) and the
"one list-sessions" parts of `2026-10-20-tmux-tool.md` (it is `list-panes -a` now). Facts below were
measured on Claude Code 2.1.319 and tmux 3.6a.

## Lessons

- [local] `~/.claude/sessions/<pid>.json` already reports waiting: `status: "waiting"`,
  `waitingFor: "permission prompt"`, seen on a real Claude at a real prompt within a poll. → No hook
  was needed, `~/.claude/settings.json` wasn't touched. The status values are `busy`, `shell`,
  `idle`, `waiting` (the enum is in the binary).
- [local] `busy` covers delegated work: a parent that ended its turn at t=14 stayed `busy` until its
  background sub-agent finished at t=51. `shell` is the turn over with only a background command
  left, and Claude wakes when it ends. → `shell` counts as working, and "finished" waits for
  `idle`. Side effect: a Claude with a long-lived background server stays "working" and doesn't
  announce the end of each turn.
- [local] Counting running sub-agents needs four checks, each measured to be necessary.
  `subagents/agent-<id>.meta.json` gets `finished: true` from 2.1.301 on (127 of 415 real metas
  have none, nearly all from older versions), and SendMessage removes it while it continues the
  agent, so it re-counts by itself. But a `kill -9` leaves it unset (→ ignore metas older than the
  process's `startedAt`), and TaskStop leaves it unset too, with no `stoppedByUser` (→ the agent's
  transcript ends in "[Request interrupted by user"; and `idle`/`shell` mean none at all). Sub-agents
  run inside the process, so child processes show nothing. An older version, an unknown status or
  a broken meta gives "don't know", which shows nothing.
- [local] A real run beats a meta file census: 'bg stopme' looked running for a minute. The agent
  had been stopped, and only the parent's transcript and the agent's last record said so.
- [local] Agents refuse a standalone `sleep N` ("Blocked: standalone sleep"), so a `sleep` probe
  ends in seconds and tells you nothing about a long run. → Use `python3 -c "import time; time.sleep(35)"`.
- [both] `rename-session` expands formats in the new name: `#S` and `#{session_id}` are replaced,
  `##` is a `#`. `#(cmd)` becomes empty and is not run (checked with a marker file). → Double every
  `#`. A leading `-` needs `--`. Same-name rename is exit 0; a clash is
  `duplicate session: <real name>`, already with `_` for `:`/`.`.
- [both] `session_activity` moves on a client's key press and not on output (`send-keys` leaves it
  alone). That is why it "lags" as a state signal, and why it is exactly right for telling typing
  from work: output is counted only after the last key.
- [local] `KillMode=mixed` SIGKILLs everything left in the service's cgroup, and `detached: true`
  doesn't leave the cgroup. Tested with a throwaway unit: a detached `sleep` died at the stop, one
  under `systemd-run --user --scope` lived. → Open wraps the window that way when `INVOCATION_ID`
  says we're in a unit. Without this, every `motherapp install` would close the user's windows.
- [local] To test LAN behaviour for real on one machine: in a temporary config set `lan.enabled` and
  trust the current network (UUID from `nmcli -t connection show --active`, gateway MAC from
  `ip neigh`), then open `http://<LAN IP>:<port>/` in the headless browser. Connecting to your
  own LAN address has that address as the source, so the core treats it as a LAN client.
- [local] A test core sees the real tmux server. → `TMUX_TMPDIR=<short dir>` gives it a private
  one, and everything the tool or a Terminator it opens runs follows; `MOTHERAPP_TMUX_NOTIFY=off`
  or a stand-in `notify-send` first on PATH keeps its alerts off the screen.
- [local] The session scratchpad path is too long for a unix socket: `tmux -S` there fails with
  "File name too long". → Use `-L <name>`, or a short `TMUX_TMPDIR`, and remove the socket.
- [local] `pkill -f <pattern>` matches the shell running it when the pattern is in its own command
  line, so the call dies with exit 144. In zsh, `T="tmux -L x"; $T ...` doesn't word-split.
  `systemd-run --scope` runs the absolute path, so `pgrep -f '^sleep 301$'` misses it.
- [local] `make verify` fails here on `tools/inbox/test/real-tmux.test.ts` (2 tests), on an untouched
  checkout too: they hardcode `service:0.0` and the tests' private tmux server still reads the
  user's `~/.tmux.conf`, which sets `base-index 1`. → Compare against a detached worktree before
  blaming your change; run with an empty `HOME` for a clean result. Not fixed here: out of scope.
- [cloud] `tools/tmux/test/e2e.test.ts` must set `CLAUDE_CONFIG_DIR` and `MOTHERAPP_TMUX_NOTIFY`: the
  tool polls from the start now, and on a real machine it would read the real files.

## Open

- `/clear` while a sub-agent runs wasn't tried: the status file's `sessionId` changes, so the count
  would look in the new session's folder and read 0 until the agent ends.
- All of the Claude reading is an undocumented format. If `finished` were renamed the count would
  run high while a session is busy; nothing here could notice, beyond the version check.
- After `motherapp install` restarts the service, check that a window from Open survives a second
  restart on the real unit (tested on a throwaway unit with the same `KillMode`).
- On first load in the very first browser run the page selected `Vpn` instead of the first row.
  It didn't come back after clearing `localStorage`; only which row starts selected is affected.
