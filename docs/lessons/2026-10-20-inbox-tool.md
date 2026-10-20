# Inbox tool (2026-10-20, sub-agent: inbox tool builder, issue #11)

Built `tools/inbox/` (`inboxctl`, custom page): links that let a peer agent type one line into a
Claude Code pane in tmux, through a cloudflared tunnel to the inbox's own 127.0.0.1 listener.
Tested against a fake `tmux`/`cloudflared`, real tmux 3.4 on a private socket with a fake Claude
TUI (`test/fake-claude.ts`), and the real core end to end. Never against the real Claude Code
TUI, a real tunnel, or a real cloud agent.

## Lessons

- [both] **tmux reads an argv argument ending in `;` as a command separator** (checked on 3.4):
  `send-keys -l -- 'hello;'` types `hello`, and a trailing `\;` becomes `;`. So text typed with
  `send-keys -l` must have a trailing `;` sent as `\;` (`tmuxLiteralArg` in `src/clean.ts`). A
  `;` anywhere else is fine. Any tool that passes user text to tmux as an argument needs this.
- [both] `tmux display-message -p -t %99 …` on a **missing pane exits 0 with empty output**, so it
  can't check that a pane exists; `send-keys -t %99` does fail ("can't find pane"). The inbox
  checks with `list-panes -a` and targets panes only by id (`%3`), never `session:w.p` (tmux
  would prefix-match the session name).
- [both] `#{pane_current_command}` is the basename of argv[0] of the pane's foreground process. A
  `#!/bin/sh` script named `claude` shows as `sh`; a symlink to a binary, or a Node program that
  sets `process.title = "claude"` (what Claude Code does), shows as `claude`. The fake Claude for
  real-tmux tests sets `process.title`.
- [both] The Claude-pane rule: `claude`, a bare version number (`2.0.31`, the native installer's
  `versions/<v>` binary run by full path), or a name in `inbox.json`'s `paneCommands`. **`node`
  is never matched** (any Node program would be); if the machine shows `node`, add the real name
  to `paneCommands` rather than `node`.
- [cloud] The Write tool turned `\u00A0`, `\u2028`, `\u202E` etc. **inside my source text into the
  literal characters**. A literal U+2028 in a regex literal is a line terminator, so the file
  didn't even parse; NBSPs elsewhere were invisible. `\x1b`-style escapes survived. → After
  writing code with `\u` escapes of invisible characters, grep for them
  (`grep -nP '\xe2\x80[\xa8\xa9]'`) or rewrite them with a small script (I used one that maps
  `\p{Cf}\p{Co}\p{Zl}\p{Zp}` and odd spaces back to `\uXXXX`).
- [both] Cleaning text isn't idempotent unless you normalize (NFC) **after** removing characters:
  dropping a format character between a letter and a combining mark makes a new composable pair.
  A property test over random nasty strings found it.
- [both] The core never logs or caches an action's result and returns it only to the caller,
  so `create` returning the link is the "show once" channel; state and `log` notifications are
  not (documented in `docs/extension-contract.md` § 2).

## Decisions (see the report on #11)

- Idle heuristic (`src/idle.ts`): not in copy mode; Claude's input box near the bottom (a `>`
  prompt line with a `───` rule directly above and below, ≤ 4 non-empty lines under it); input
  empty or only the `Try "…"` placeholder; no `esc to interrupt` / `ctrl+c to interrupt` in the 6
  lines above the box or the footer. Anything else is busy and the message waits.
- Delivery: text (`-l --`), wait, **check the text is in the input box before pressing Enter**
  (else no Enter: a dialog that opened in between could take it), Enter, wait, check, at most one
  more Enter.

## Not verified without the real machine

- **The real Claude Code TUI.** The screen fixtures (`test/fixtures/screens/`) are hand-written
  from memory of Claude Code 2.x: the `>` prompt (vs `❯`), the rules, the spinner's "esc to
  interrupt", the `Try "…"` placeholder, how dialogs look. If idle detection is wrong, messages
  wait forever (the page shows the reason). Capture real screens
  (`tmux capture-pane -p -t motherapp:0.0`) idle, while typing, mid-turn and with a permission
  dialog, add them as fixtures and fix the rules.
- Whether 200 ms between text and Enter is enough, and how often the retry fires; the delivery log
  records `submitted: retried`. Whether Claude Code turns `@`-mentions or long text into a
  suggestion menu or `[Pasted text]` that swallows the Enter.
- **The tunnel.** cloudflared 2026.7.2's real output (the fixture is from memory), and whether a
  cloud agent can reach a quick tunnel at all (issue #16). Named mode (`cloudflared tunnel run`
  with our generated config, credentials found under `~/.cloudflared`) is untested.
- **SendMessage** replies and how a real cloud agent follows the GET skill.
- That the systemd service sees the user's tmux server (same as the tmux tool's open point).

## Open

- `install.sh --check` doesn't report cloudflared (it's optional, only the inbox needs it).
- GET on a live link isn't rate-limited (only POSTs are, 6 per minute per link).
