---
name: ai-delta
description: Record what a model produced, what was wrong with it, and what the correction cost, into the exercise's AI-DELTA.md. Use after finishing a task that involved generated code, or when the user wants to capture how the AI performed on a piece of work.
---

# ai-delta

This builds the evidence base that `docs/ai-and-the-engineer.md` is supposed to
rest on. Without it that document is just opinion, and the user has no grounds
to say anything specific about working with models in their own field.

## Fields

**Asked for.** The actual request, not a tidied version of it. Whether the
prompt included a spec matters enormously to the result, so record it honestly.

**Came back.** What was produced, and whether it ran at all on the first
attempt.

**Wrong with it.** Be specific about the category, because the categories are
what eventually add up to a finding. A syntax error, a wrong API for the
installed version, correct code solving the wrong problem, code that runs and
silently does the wrong thing, a missing edge case, a confident and false claim
about behaviour. The last two are the ones worth counting.

**Correction cost.** Rough wall-clock time, and who found it. Whether it was
caught by a tool, by a test, or by reading matters more than the minutes.

**Reading.** What this one case suggests, held loosely. One data point is an
anecdote. The value is in the pattern across a dozen entries.

## Rules

Record the successes too. A log containing only failures is as misleading as a
log containing only successes, and the user will eventually want to say
something defensible about the balance.

Do not soften entries about the model's own output. An entry saying the model
was confidently wrong is the most useful kind in the file.

Do not invent entries. If a task involved no generated code, there is nothing to
record, and saying so is the correct outcome.

Append to `exercises/NN-name/AI-DELTA.md`, numbering entries in order. Then run
`make index`. Once there are entries across several exercises, re-read
`docs/ai-and-the-engineer.md` and check whether the evidence still supports it.
If it does not, the document is what changes.
