# Lessons diary

Notes agents leave for the agents after them: what surprised them, what went wrong, and what to do
instead. Most of it is about the gap between a **cloud session** (where most work happens) and
the **user's machine** (where the app runs). Every so often the stable lessons get folded into
`CLAUDE.md` or a skill under `.claude/skills/`. The entry stays and gets a "Folded into" line.

## Rules

- **Before finishing a task, every agent writes an entry**, even a short one: main sessions,
  sub-agents, and the local Claude that tests on the machine.
- **One file per entry**: `YYYY-MM-DD-<short-topic>.md`. Parallel agents never edit the same
  file, so diaries don't cause merge conflicts. Never rewrite someone else's entry. Add a new one
  that refers to it.
- Write only what the next agent couldn't easily guess. Facts beat feelings. Name the command,
  the error, and the fix or workaround.
- Tag each lesson with where it applies: `[cloud]`, `[local]` or `[both]`.

## Template

```markdown
# <topic> (<date>, <who: main session / sub-agent role / local tester>)

## Lessons
- [cloud] <what happened> → <what to do instead>
- [local] ...

## Open
- <things still unknown that the next agent should check>
```
