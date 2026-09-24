# From symptom to root cause

A method, not a checklist. It applies to RTL and to the Python around it.

## Reproduce before you theorise

A bug you cannot trigger on demand cannot be confirmed fixed. If it is random,
find and record the seed, then make it deterministic before going further.

The temptation is to start reading code as soon as you see the failure, because
reading feels like progress. It is faster to spend two minutes getting a
reliable reproduction and then read with a specific question in mind.

## Narrow before you explain

Shrink the failing case until removing anything makes the failure go away. Fewer
transactions, smaller depth, one test instead of seven. A two-cycle reproduction
can be understood completely; a two-thousand-cycle one cannot.

In simulation the equivalent of a bisect is the parameter sweep. If it fails at
DEPTH=8 but not DEPTH=4, that is a strong signal before you have read a line.

## Find the first divergence, not the reported failure

The cycle where the test reports a failure is downstream of the cycle where the
design first did something unexpected. Those are usually far apart. Open the
waveform, find the earliest point where a signal is not what the spec says it
should be, and work from there.

This is the single highest-value habit in hardware debugging, and it is the one
that does not transfer from software, where the stack trace usually points near
the cause.

## State a falsifiable hypothesis

Write down what you think is happening in a form that could be shown wrong.
"Something is off with the pointers" cannot be tested and will keep you busy for
an afternoon. "The full flag asserts one write early, so the eighth write is
dropped" can be checked in one run.

Then design the cheapest experiment that distinguishes it from the alternatives.

## Distinguish cause from symptom

When a change makes the symptom disappear, ask why that change affects that
symptom. If there is no explanation, the symptom is suppressed rather than the
bug fixed, and it will come back later in a context where it costs more.

The specific thing to be suspicious of is a fix that involves adding a delay,
widening a signal, or relaxing a check. Sometimes those are correct. Often they
move the problem out of view.

## When you are stuck

Explain the problem out loud, to a person or to a model, in full. The value is
in being forced to state your assumptions explicitly, and most stuck debugging
sessions end at the moment somebody says an assumption aloud and hears that it
is wrong.

Check your assumptions about the tools, not just the design. In this repo one
bug was that the runner reported success on failing tests. Everything about the
design was fine. If the evidence makes no sense, verify that the thing producing
the evidence works.

## Write it down before moving on

The entry costs five minutes while it is fresh and is nearly impossible to
reconstruct a week later. Use `/debug-log`. The field that matters most is the
last one, what would have caught this earlier, because that is the one that
changes the next exercise.
