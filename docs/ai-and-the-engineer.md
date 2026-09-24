# What the engineer does and what the AI does

This is a hypothesis, not a conclusion. It is written down so that the evidence
you accumulate in the per-exercise `AI-DELTA.md` files can contradict it. When
it does, this document changes.

It carries no citations because it is not a literature review. It is a starting
position based on how the tooling behaves in this repo, and it is worth exactly
as much as the evidence behind it, which right now is three entries.

## The short version

Models are good at producing code and bad at knowing whether the code is right.
Almost everything that follows is a restatement of that.

## Where the model is strong

Boilerplate and structure. Module skeletons, testbench scaffolding, argument
parsing, build files. Work where the shape is conventional and the cost of a
mistake is that it fails immediately and loudly.

Unfamiliar syntax and unfamiliar codebases. Explaining what a block of
SystemVerilog does, or what a compiler error means, is genuinely fast and
usually correct. This is the use that saves the most hours and gets discussed
the least.

First drafts against a clear specification. In this repo, the FIFO was correct
on the first attempt because the spec fixed the full condition and the
simultaneous-access rule before any code existed. Without that spec, the model
picks a convention and you have no basis for calling it wrong.

## Where the model is weak

Knowing what the design is supposed to do. The model will produce a FIFO. It
will not tell you that your system needs backpressure two cycles earlier than
you specified, because it does not know your system. Specification is not a task
that has been automated.

Silent wrongness. The expensive failure is not code that crashes, it is code
that runs and quietly does the wrong thing. In this repo the harness reported
success on a design with four failing tests, and nothing about the code looked
unusual. Reading it would probably not have caught it. A test designed to fail
did.

Knowing that it is wrong. A model will state a confident and false claim about
behaviour in the same tone as a correct one. There is no reliable internal
signal you can read off the output, which is why external checks matter more
than careful prompting.

Version drift. Training data lags releases. cocotb 2.x renamed an argument and
moved a module, and code written from memory of 1.x fails on both. This gets
worse as a library moves faster.

## What that leaves for the engineer

Deciding what to build, which is the spec. Deciding what to test, which is the
part nobody can check for you, because a test suite that misses a case looks
exactly like one that covers it. Reading waveforms and deciding what the
evidence means. And judging whether a fix addresses a cause or hides a symptom,
which requires holding a model of the system that the tool does not have.

The pattern across all four is the same. The work that remains is the work where
being wrong is not immediately visible.

## The opposing view, stated properly

There is a serious argument that this framing is already dated, and it deserves
more than a dismissal.

On that view, the weaknesses listed above are artefacts of how the tools are
used rather than properties of the tools. Silent wrongness is caught by agents
that run the tests themselves and iterate until green, which is what happened in
this repo. Version drift is solved by giving the model access to the installed
library instead of relying on memory, which is also what happened here. Both
defences were available and both worked, which argues the limits are moving
quickly and that any list of them has a short shelf life.

The stronger form of the argument is that specification is not as protected as
engineers would like to believe. A model given the surrounding system context
can often propose a reasonable spec, and "you have to know what you want" has
been the last refuge of every profession facing automation. It has not held
anywhere else.

The honest position is that the counter-argument is partly right, and that the
distinction that survives is narrower than "humans specify, machines implement".
What survives is accountability. Someone has to be answerable for whether the
thing works, and that person needs to have checked. This repo is an argument
that the checking is the skill, whoever writes the code.

## How to use this document

Do not cite it. It is a hypothesis with three data points behind it. After
several exercises, read your own `AI-DELTA.md` entries and count the categories.
If most of your corrections were syntax and API drift, the model is a fast typist
and this document overstates the risk. If most were silent wrongness and missing
edge cases, the framing holds, and you will be able to say so with your own
numbers, which is a far better thing to bring to an interview than an opinion.
