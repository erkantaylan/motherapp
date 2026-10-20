# Inbox: deliver without reading the screen (2026-10-20, local session)

The first real test of the inbox (#11) reached the machine through the quick tunnel, but nothing
was typed: `idle.ts` never recognised the real Claude Code screen, so every message stayed
queued with "Claude's input box isn't on screen" (#22).

## Lessons

- [local] A cloud session **can** reach a cloudflared quick tunnel on the machine: the inbox log
  shows its `POST` from `160.79.106.141` (`curl/8.5.0`) answered 202. That settles #16.
- [local] Screen-reading rules written from memory of Claude Code's UI didn't match the real
  screen at all. → The user's call: don't check the screen; type and press Enter. The
  `checkScreen` setting in `~/.config/motherapp/inbox.json` (default `false`) skips `idle.ts`
  and the "is our text in the box" checks. The old path stays behind `checkScreen: true`, and
  the tests still cover it.
- [local] Self-test that works: make a link for your own pane with
  `inboxctl new … --print > <file in the scratchpad>` (never print it to tool output), then
  `curl -X POST` through the tunnel URL. The message arrives in the same session as a new user
  turn while the session is busy. Claude Code queues it, so typing mid-turn is fine. Revoke the
  link afterwards.
- [local] The installer marks a build from uncommitted changes `v1-<hash>-dirty`, as #17 intended.

## Open

- Edge cases the screen check was meant to handle: the user typing in the pane when a message
  arrives (the text gets mixed in), and an open permission dialog (Enter could confirm it). The
  user said to deal with these later, if they actually bite.
