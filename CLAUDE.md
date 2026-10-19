# motherapp

- The project is in the design phase. `DESIGN.md` is the source of truth: read it before
  answering design questions, and when a question in it gets answered, move it from "Open
  questions" into "Decided" (or "Proposed") rather than leaving the answer only in chat.
- The target machine cannot be inspected from a cloud session; its relevant facts are in
  `DESIGN.md` § "Target machine facts". Don't assume anything beyond them — ask.
- `reference/audio-switch/` is the predecessor, kept for reference only. Don't build on or modify it.
- **Lessons diary:** read `docs/lessons/` before starting work. Before finishing any task, add an
  entry following `docs/lessons/README.md`, one new file per entry. This applies to main
  sessions, sub-agents and the local tester alike. When briefing a sub-agent, tell it to do
  the same.
- Work directly on `main`. Before pushing: `git fetch origin main && git merge origin/main`,
  `make verify` on Node 24, then `git push origin HEAD:main`.
- The `refs` and `x-commands` skills in `.claude/skills/` are how the user steers discussions
  (`x:discuss`, `x:plan`, …, and `3.2` / `?4` style references). Use them when invoked.
