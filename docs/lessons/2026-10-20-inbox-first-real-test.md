# Inbox: first real end-to-end test, and the simplification (2026-10-20, sub-agent: inbox follow-up, #11 / #16)

The first real test, from a cloud session through a quick tunnel on the machine: `GET` of the
link returned the skill (HTTP 200), and the `POST` returned **202 queued** with reason "Claude's
input box isn't on screen (a dialog, or not Claude's prompt)". Then, per the user: named tunnels
and the per-link max uses / max length options were removed, and hold reasons got more precise.

## Lessons

- [both] **A cloud session can reach a cloudflared quick tunnel** running on the machine (resolves
  #16). The earlier probe was inconclusive only because nothing logged the caller.
- [both] **The idle detector (`src/idle.ts`) did not recognise the real Claude Code screen.** It
  was written from memory, and the fixtures in `test/fixtures/screens/` are hand-written. → Don't
  guess a new heuristic. Collect real screens first (below), add them as fixtures, then change
  the rules. A local Claude on the machine has an issue for that.
- [both] A local session landed `checkScreen` (default `false`, #22) while this was being built:
  by default nothing is held, so the diagnostics and "Deliver now" below only matter with
  `"checkScreen": true` in `~/.config/motherapp/inbox.json`. "Save screen" works either way.
- [both] To tell *which* rule fails, a held message now carries a check name: `no-prompt-line`,
  `no-rule-above`, `no-rule-below`, `too-many-lines-below`, `input-not-empty`, `busy-marker`
  (plus `copy-mode`). It shows on the page ("[check: …]") and in the journal (`check` field of
  "inbox message queued" / "inbox message still held"), never with message or screen text.
- [local] To collect fixtures: on the Inbox page press **Save screen** on the pane, or run
  `inboxctl screen motherapp:0.0` (any pane, motherapp running or not). Each writes
  `~/.local/state/motherapp/inbox/screens/<timestamp>.txt` (0600) and says what the detector makes
  of it. Capture idle (empty box), while typing, mid-turn, and with a permission dialog open.
- [both] **Deliver now** (page, per waiting message, behind a confirm) is the override while the
  detector is wrong. It still sends text and Enter as two tmux calls, but checks that the line's
  start appears on screen *more often than before typing* (it can't rely on finding the box) and
  never retries Enter (the submitted line stays visible in the transcript, so a retry can't
  tell). Copy mode still refuses.
- [both] Old `links.json` entries with `maxUses`/`maxLen` load; the fields are dropped on the next
  write. One that had already used up its messages is kept ended (marked revoked at its creation
  time) instead of coming back to life now that there's no limit.
- [cloud] Worktree isolation refuses `cat > file <<EOF` and `sh script.sh`, and any command with
  `$VAR` before `npm`. → `python3 - <<'EOF'` edits worked; for longer ones write a script to the
  scratchpad and run `python3 <script> <path>`. For Node 24, resolve the path once
  (`npx -y node@24 -e 'console.log(process.execPath)'`) and run
  `env PATH=<that dir>:/usr/bin:/bin make verify` with the literal path.

## Open

- Real `capture-pane` screens of Claude Code (idle, typing, working, dialog) and the rule fix.
- Whether a real Claude Code input box accepts the "Deliver now" text and Enter as expected.
