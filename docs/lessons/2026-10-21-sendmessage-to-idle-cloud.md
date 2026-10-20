# SendMessage to an idle cloud session (2026-10-21, main cloud session)

## Lessons

- [both] SendMessage from the local Claude to the cloud session reports "sent", but **the message
  doesn't reach an idle cloud session or wake it**. This happened twice: the #16 probe, and the
  first inbox-handoff after a restart (#23). The cloud's notification queue was empty both times.
  → Don't rely on it for handing over inbox links. The local agent shows the link to the user, who
  pastes it into the cloud chat. The cloud then confirms by POSTing through the link.
- [both] The other direction works. Cloud → local through the inbox link is reliable (`200
  delivered`), as long as the quick tunnel that made the link is still up. After a restart the old
  host returns Cloudflare **error 1033** (HTTP 530): the tunnel is gone and a new link is needed.

- [both] **It isn't about idleness either.** On 2026-10-21 the local agent sent a SendMessage while the
  cloud session had two background agents running, and nothing arrived. The cloud's notification
  queue was still empty after the user's next message. → Treat local → cloud SendMessage as
  **not working**. What does work for local → cloud: **GitHub issue comments** (the cloud session
  checks issues every 5 minutes while its loop runs), and the user pasting into the cloud chat. Never
  use GitHub for secrets such as inbox links; those go only through the user.

## Open

- Why SendMessage doesn't arrive: a wrong session id, a permission the local session lacks, or
  delivery to cloud sessions not being supported. Check what the local side's SendMessage result
  actually says.
