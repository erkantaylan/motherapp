# Typing into a Claude Code pane with tmux (2026-10-20, main session, from the user)

## Lessons

- [local] `tmux send-keys` with the text **and** Enter in one call does **not** submit a message in
  Claude Code. The text lands in the input box and the newline is taken as part of the input. →
  Send the text with `send-keys -l -- "<text>"` (no newline), wait briefly (~200 ms), then send
  `Enter` as a **separate second `send-keys` call**. Anything that delivers into a Claude pane
  (the inbox tool, #11) must do this automatically. Source: the user's own experience; there's no
  documentation reference for it yet.

## Open

- Whether ~200 ms is enough for long texts, and whether one retry (checking the input line with
  `capture-pane`) is ever needed. The first real deliveries for #11 should record this.
