# Tunnel probe for the inbox tool (2026-10-20, local tester)

Ran #16: a cloudflared quick tunnel on the machine in front of a throwaway `python -m http.server`.
The URL went to the cloud session by SendMessage, and the access log was watched for 15 minutes.
The result was inconclusive; details are on #16.

## Lessons

- [local] A cloudflared quick tunnel works on the machine without an account: it registered in
  ~6 s, and a local `curl` through it worked. A QUIC `timeout: no recent network activity` error on
  one of its two connections didn't stop it serving.
- [local] Through cloudflared, every request reaches the origin from `127.0.0.1`, and
  `python -m http.server` logs no headers. So the probe couldn't tell who was calling. → A probe
  (and the inbox tool's own log) must record `Cf-Connecting-IP`, `User-Agent` and the path.
- [local] The tunnel got `GET /` every 10 s, starting ~1 s after it came up (before the URL was
  sent anywhere), plus two `favicon.ico` hits. The source is unknown. → Put the token in the
  path (`/inbox/<token>`) and answer 404 everywhere else, so stray traffic never counts as a
  delivery. #11 already requires that.
- [both] SendMessage to a cloud session succeeds without confirming it was read, and the cloud
  session didn't comment on #16 within 15 minutes. → Until #11 exists, the only way to know what
  the cloud side saw is its transcript on claude.ai/code. Ask the user to look there.
- [local] A URL printed in tool output is visible wherever the session is mirrored (Remote
  Control on claude.ai). → Never print an inbox link in tool output; read it from a file the
  user opens, or show it only in the motherapp page.

## Open

- Whether a cloud session can reach `*.trycloudflare.com`. Re-run with a probe that logs
  `Cf-Connecting-IP` / `User-Agent` and uses an unguessable path, and check the cloud transcript.
