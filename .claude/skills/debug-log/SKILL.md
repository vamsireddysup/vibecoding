---
name: debug-log
description: Walk a bug through to a written root cause and add an entry to the exercise's DEBUG-LOG.md. Use when a test fails, a simulation hangs, a waveform looks wrong, or the user says something is broken, misbehaving, or that they fixed something. Refuses to record a fix without a root cause.
---

# debug-log

The purpose is not documentation. It is to stop the most common failure in
debugging, which is changing something, seeing the symptom disappear, and
believing the problem is understood.

## Procedure

Work through these in order. Do not skip ahead to the fix even when it seems
obvious, because the cases where it seems obvious and is wrong are exactly the
expensive ones.

**Symptom.** State what was observed, quoting the actual error text or the
actual signal values. "The FIFO is broken" is not a symptom. "`count` reads 7
after 8 writes" is.

**Reproduction.** The exact command and conditions. If it is intermittent, say
so and record the seed. An intermittent bug that is not reproducible on demand
is a different and harder problem, and pretending otherwise wastes time.

**Hypothesis.** What you think is happening, stated so that it could be wrong.
"Something is off with the pointers" cannot be tested. "The full condition
asserts one write early, so the eighth write is dropped" can be.

**Experiment.** What you did to test the hypothesis, and what it showed. If it
disproved the hypothesis, keep that in the log. A discarded hypothesis tells the
next reader which paths are dead ends.

**Root cause.** The specific line or design decision, and why it produces the
symptom. If you do not know yet, write "not yet established" rather than a
plausible-sounding guess. An incorrect root cause in the log is worse than an
empty field, because it stops the next person looking.

**Fix.** What changed and why that addresses the cause rather than masking the
symptom. If it does mask the symptom and that is a deliberate temporary
decision, say so explicitly.

**What would have caught this earlier.** A check, an assertion, a lint rule, a
test. This is the field that turns a log into a method, because it is the one
that changes what you do next time.

## Rules

If the user says a bug is fixed but cannot state the root cause, ask what
changed and why that change affects the symptom. If the answer is "not sure, it
just works now", record it as unresolved with the symptom suppressed. That is an
honest state and a common one, and it will matter when the symptom returns.

Never invent a root cause to fill the field. Never fabricate a debugging session
that did not happen.

Prepend new entries to `exercises/NN-name/DEBUG-LOG.md` so the newest is first.
Date them. Afterwards, run `make index` to refresh `logs/INDEX.md`.
