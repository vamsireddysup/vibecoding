# The loop

The same six steps for every exercise. The order is the point, and the step most
people skip is the fifth.

## 1. Write the spec

Interface, behaviour, reset state, boundaries, what happens when two things land
on the same clock edge, what is out of scope. Where a design choice exists, say
which way you went and why.

Do this before any RTL exists. If the design comes first, the spec ends up
describing whatever the design happens to do, bugs included, and the testbench
then verifies that the design does what the design does.

Invoke `/new-exercise` and it will scaffold the folder and stop here.

## 2. Write the RTL

Now generation is safe, because there is something to check it against. Ask for
the design against the spec, then read what comes back rather than running it
immediately.

## 3. Lint

`make lint`. Verilator with `-Wall`, clean, before anything else. It is under a
second and it catches a category of mistake that costs an hour in simulation.
Then run `/rtl-review` for the defects lint cannot prove, particularly reset
handling, latches and the full and empty boundaries.

## 4. Write the testbench

A reference model plus directed tests at the boundaries. The model is a plain
Python structure that is supposed to behave like the design, compared against it
every cycle, so a failure points at a cycle rather than at a vibe. Directed
tests then pin the boundaries that random traffic reaches only by luck.

Write the reference model from the spec, not from the RTL. A model derived from
the design inherits the design's bugs and will agree with them.

## 5. Break it on purpose

This is the step that separates a test suite from decoration. Introduce a
plausible defect, one you could imagine writing by accident, and confirm the
suite fails and that the message names the real problem. Then restore.

Until you have seen the suite fail, you do not know it is connected. In this
repo the deliberate break found a bug in the test harness rather than in the
design, which is exactly the sort of thing it exists to find.

## 6. Log it

`/debug-log` for every bug worth the name, with a root cause. `/ai-delta` for
what the model produced and where it was wrong. Then `make index`.

The logs are the part that is hard to fake and the part an employer cannot get
from a green README. A repo full of working designs shows you can prompt. A repo
full of working designs plus written root causes shows you can debug.

## When you are stuck

Reproduce it reliably before theorising. An intermittent bug is a different and
harder problem, and treating it as a deterministic one wastes hours.

Narrow it before explaining it. Shrink the failing case until removing anything
makes the failure disappear.

Then look at the waveform. Find the first cycle where the design and your
expectation differ, not the cycle where the test reports a failure. Those are
usually far apart, and the distance between them is where the bug lives.
