# CLAUDE.md

House rules for this repository. The point of the repo is that its owner learns
to design and debug hardware while working with a model, so rules that make my
output easier to check beat rules that make it faster to produce.

## What this repo is

A practice repo for RTL design and verification, with a Python tooling track
beside it. Each exercise under `exercises/` is self-contained and ships four
things: a spec, a design, a testbench that can prove the design wrong, and a
written debug log.

## Working rules

Write the spec before the RTL. If `exercises/NN-name/README.md` does not yet
describe the interface and the behaviour, write that and stop for review. A
design produced without a spec cannot be verified, only observed.

Never present a testbench as working until it has failed against a broken
version of the design. Introduce a plausible defect, confirm at least one test
fails and that the message names the actual problem, then restore. A suite that
stays green when the design is broken is worse than no suite.

Run `make lint` before claiming a design is done. Verilator with `-Wall` must be
clean. Do not silence a warning with a waiver until the warning has been
understood and the reason is written down.

Check library APIs against what is installed rather than writing from memory.
`inspect.signature` costs one command. cocotb 2.x in particular renamed `units`
to `unit` and moved `cocotb.runner` to `cocotb_tools.runner`, so 1.x examples
from training data do not run.

Record nontrivial generation in the exercise's `AI-DELTA.md`, including the
cases where the output was correct. A log of only the failures overstates how
bad the tooling is, and a log of only the successes overstates how good it is.

When a bug is found, write the `DEBUG-LOG.md` entry before fixing it, or at
least before moving on. The entry needs a root cause. If the root cause is not
known yet, say so in the entry rather than writing a plausible guess as though
it were established.

## Style for generated RTL

Verilog-2001 with `` `default_nettype none `` at the top of every module and
`` `default_nettype wire `` at the bottom, so a typo in a signal name is an
error instead of a silent one-bit wire.

Nonblocking assignment in sequential blocks, blocking in combinational ones.
Resets are asynchronous and active low unless an exercise says otherwise. One
module per file, with the filename matching the module name.

Comment the reasoning, not the syntax. A comment explaining why the pointers
carry an extra bit earns its place; a comment saying "increment the pointer" on
a line that increments the pointer does not.

## Writing style for documentation

No em dashes. No emoji. Sentence case in headings, so only the first word is
capitalised. Keep lists short and prefer prose where prose reads better. State
uncertainty as uncertainty rather than dressing a guess as a finding.

## Testing commands

```
make lint       # Verilator -Wall across every exercise
make test       # every exercise's cocotb suite
make regress    # same, with a pass/fail summary table
```

Per exercise, `cd exercises/NN-name && make test`.
