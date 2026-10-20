# FSearch removed from the installer (2026-10-21, sub-agent)

- [cloud] In a fresh agent worktree `make verify` failed only at `web/test/settings-layout.test.ts` ("1 !== 0"): `node_modules/vite` was missing, not a code bug. → Run `npm ci` in the worktree first.
- [both] The FSearch removal kept the generic `simulate_install PKG` helper (Node uses it via `simulate_nodejs`); dropping the 5 FSearch cases leaves 342 installer checks.
