---
name: x-commands
description: Interpret and follow the closed `x:` command vocabulary — x:frame, x:plan, x:execute, x:discuss, x:sling, x:shutdown, x:afk — that a user or parent-agent uses to set intent and flow explicitly instead of leaving it to be guessed. Invoke whenever a message contains any `x:` token, and stay active for the rest of the conversation. Look tokens up here; do not interpret them.
---

# `x:` commands

A tiny **closed** set of commands the user (or a parent agent) drops into a message to set intent and flow *explicitly*, so it is never guessed. **Look tokens up in the table below — do not interpret them.** A token beginning `x:` that is not in the table is unknown → ask what it means; do not act on it.

## The commands

| Command | Means | What you (the agent) do |
|---|---|---|
| `x:frame` | Read back before acting | Output three parts — **Given** (the facts you have), **Asked** (the goal as you understand it), **Assumptions** (anything you are inferring that was not stated). Write every under-specified decision as an **open question**, not a settled choice. Then **stop** — do not solve. |
| `x:plan` | Engage the gate (sticky) | You may read, investigate, answer, and propose — but make **no code change, file change, or other state change until `x:execute`**. Stays in effect until the user changes mode. |
| `x:execute` | Release | Carry out the proposal currently on the table, now. Then fall back to the previous mode (the gate re-engages — one `x:execute` does not disable it). |
| `x:discuss` | Talk only, in the loop (sticky) | Reason and weigh options *with* the user; ask them questions. Do **not** converge on a single plan and do not act. This is for thinking together, not producing. |
| `x:sling` | Delegate | Do not solve it yourself. Orchestrate: dispatch the work to sub-agents and keep your own context clean; return the conclusion, not the raw work. |
| `x:shutdown` | Power the machine off when the current jobs finish | **High-consequence.** Only when explicitly given. Confirm first, unless it was pre-authorized in the same message (e.g. stacked with `x:afk`). Never self-initiate it. It is a *trailing* action — it fires only after the current work is done and verified. |
| `x:afk` | The user is away from keyboard (sticky until they return) | Keep making **safe, authorized** progress — do not stall on trivial confirmations. **Never cross an irreversible / destructive / external-send line without prior explicit OK** (stop at that boundary and wait). On genuine ambiguity, take the obvious **reversible** default if there is one, otherwise **queue** the question and move on — do not block, do not guess. Keep a log and hand the user a digest on return: *done / assumed / blocked-on-you*. |

## Stacking

Commands compose into one run-spec, applied together:

- `x:plan x:sling` — plan it out, then hand the implementation to sub-agents.
- `x:afk x:shutdown` — run while I'm gone, power the machine off when the jobs are done.

If a stack is **contradictory** or does not make sense, do not guess — ask (or, while `x:afk`, queue the question).

## Two rules that always apply

1. **Doubt-and-loop.** When a command, a stack, or the situation is ambiguous or unexpected, do not guess — ask. (Exception while `x:afk`: queue the question instead of blocking; still never cross the irreversible line.)
2. **Flag unknowns as unknowns.** Whenever you state assumptions — above all in `x:frame` — write under-specified decisions as open questions, never launder them into settled choices. A frame that looks thorough while silently deciding for the user is worse than none.

## When no command is present

Read the message normally: an imperative acts, a question is answered. The gate is not on unless `x:plan` (or `x:discuss`) has been set.
