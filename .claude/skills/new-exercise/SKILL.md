---
name: new-exercise
description: Scaffold a new numbered exercise folder from templates/exercise and write its specification. Use when the user wants to start a new design, add an exercise, or begin the next phase of the curriculum. Stops after the spec so the design is not written before the requirements exist.
---

# new-exercise

## Procedure

Pick the next number by looking at what is already in `exercises/`. Use a short
hyphenated name, so `03-round-robin-arbiter` rather than `03-arbiter-v2-final`.

Copy `templates/exercise/` to `exercises/NN-name/`. That gives the folder
structure, a spec skeleton, a Makefile, and empty logs.

Fill in the spec in `exercises/NN-name/README.md` by asking the user what the
block does. Cover the interface signal by signal with widths and directions, the
behaviour including reset state, what happens at the boundaries, what happens
when two things occur on the same clock edge, and what is explicitly out of
scope. Where a choice exists, such as registered versus first-word-fall-through
reads, state which was chosen and why, since that reasoning is what makes the
spec reviewable.

Then stop. Do not write the RTL and do not write the testbench.

## Why it stops there

The spec is the only thing that makes the design checkable. If the RTL is
written first, the spec gets written to match whatever the RTL does, including
its bugs, and the testbench then confirms that the design does what the design
does. Writing the spec first is also the part that a model cannot do for the
user, because it is where the requirements actually get decided.

Hand the spec back for review, and start on RTL only once the user has read it.
