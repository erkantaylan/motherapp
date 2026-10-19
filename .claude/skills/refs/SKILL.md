---
name: refs
description: Tag each paragraph with a per-message reference number (2.1, 2.2, 3.1) and each question with a conversation-wide ?N number (?1, ?2), so the user can point at a specific point instead of quoting it back. Invoke when the user asks for reference tags, paragraph numbering, or says "refs on" / "number your paragraphs". Once invoked, stay active for the rest of the conversation.
---

# Refs

Make your output addressable. The user should be able to say "3.2 is wrong" or
"expand 2.5" rather than copying text back at you.

## Tag format

Prefix each substantive paragraph with a bold tag, no brackets:

```
**3.1** The parser reads the whole file into memory first, which is fine for
configs but will not hold for the log ingest path.

**3.2** Two ways out: stream it, or cap the size and fail loudly. Streaming is
more work, but the log files are already at 400MB.

**?7** Do you want the streaming version, or the size cap as a stopgap?
```

## Numbering

- **Paragraphs: `M.N`.** `M` is one higher than the highest `M` you have already
  used in this conversation; untagged replies do not consume a number. `N`
  restarts at 1 in every message, so a message's tags are always
  `M.1, M.2, M.3...`.
- **Questions: `?1, ?2, ...`** on a single counter that runs across the whole
  conversation and never resets. Questions get asked in one message and
  answered five messages later, so a global counter keeps them findable.
  Questions do not consume a paragraph number. A question asked through a tool
  rather than in prose still gets one — it is still something to point back at.
  The prefix is `?`, not a letter, because letter-number IDs belong to other
  tools (mikado's `Q142` quests, `J7` journeys). In a regex, escape it:
  `\?[0-9]+`.
- **Never renumber.** Once emitted, a tag permanently means that text. If you
  revise a point, give it a new tag and name the old one: `**4.2** revising
  3.1: ...`.

This survives compaction and resumed sessions on its own — the highest tag still
visible in context is all you need. Skipping a number is harmless; reusing one is
not.

## What does NOT get a tag

Tags are for prose the user might want to argue with. Skip:

- Code blocks, file paths, command output, tables, diagrams
- Bullet and list items — tag the paragraph that introduces the list instead
- Headings
- One-line acknowledgements: "Done.", "Fixed — tests pass."
- Narration of what you're about to do with a tool

Aim for roughly one idea per tag — a few sentences. If a whole reply is short
or purely mechanical, emit no tags at all rather than tagging a throwaway line.
Questions still get their `?` number even in an otherwise untagged reply.

## Referring back

When the user writes "3.2 is wrong" or "more on 2.5", resolve the tag from your
earlier messages and answer that specific point — don't restate the whole
topic. If the tag isn't in context or is ambiguous, ask which one they mean
rather than guessing.

## Listing what is open

If the user asks what is still open, list every `?N` you have emitted that they
have not answered — oldest first, with the question text. A question counts as
answered when the user addresses it, not when you move on from it. This is the
main thing the global `?` counter is for: in a long session, questions asked in
passing get lost, and the counter is what makes them recoverable.

## Tags stay in the conversation

Tags are addressing for a live discussion, nothing more. Never write them into
anything durable — files, commits, PR descriptions, issues, documentation,
artifacts, code comments. If you are drafting text that will be read outside
this conversation, it gets no tags even while the skill is active.

## Turning it off

If the user says "refs off" or "stop numbering", drop the tags immediately and
don't resume unless asked again.
