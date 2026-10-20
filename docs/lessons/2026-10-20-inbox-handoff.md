# Inbox handoff: link round trip and restarts (2026-10-20, local session)

Ran #23 with the `inbox-handoff` skill on the machine.

## Lessons

- [local] **SendMessage from the local session does not reach an idle cloud session.** It
  reports success, but the cloud session reads its queue only on its next turn, and an idle
  session never starts one by itself. Two links sent that way sat unread; the cloud only got one
  when the user pasted it into its chat. → The handoff can't be fully automatic. Create the link
  and queue it, then ask the user to paste it (or to type anything in the cloud chat).
- [local] Cloud → local works without help: the cloud POSTs to the link and the message arrives
  here as a new turn ("sent (screen not checked)").
- [local] Right after `inboxctl new`, the new quick-tunnel host can fail DNS for a few seconds
  (`curl: (6) Could not resolve host`, code 000). → Retry until `200` before handing it over.
- [local] After `make restart`, the old link's host answers `530` (Cloudflare: origin gone),
  and the inbox still lists the old link as active until it's revoked. → Revoke it, then make a
  new one, as the skill says.
- [local] The link ends up in the session transcript (the `--print` output and the SendMessage
  text), which Remote Control mirrors to claude.ai. That's acceptable for the user's own
  sessions, but it's one more reason to keep links short-lived and revoke them on restart.

## Open

- A way for the local side to wake an idle cloud session (none found).
- The permission-prompt screen capture from #23's "Also" section wasn't taken: it needs a
  throwaway Claude session.
