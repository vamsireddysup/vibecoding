# vibecoding

RTL design and verification practice, done with a model in the loop and with the
checking written down.

The premise is that generating a design is no longer the hard part. Any model
will produce a FIFO in seconds. What it will not do is tell you that the full
flag asserts one slot early, and a green README cannot distinguish an engineer
who found that from one who never looked. So every exercise here ships four
things: a spec written before the code, a design, a testbench that has been
proven capable of failing, and a log with root causes in it.

## Layout

Each exercise under `exercises/` is self-contained. `tools/` holds the Python
that runs and summarises everything. `docs/` holds the method. `.claude/skills/`
holds four skills that enforce the parts most easily skipped.

## Running it

```
make lint      # Verilator -Wall over every exercise
make test      # every cocotb suite, with a summary table
make index     # regenerate logs/INDEX.md from the per-exercise logs
```

Setup is in `docs/setup.md`. Verified with Icarus Verilog 12.0, Verilator 5.020
and cocotb 2.1.0 on Ubuntu 24.04.

## The one thing to do first

Run `make test` and watch it pass. Then break the design on purpose, following
the last section of `docs/setup.md`, and watch it fail. A suite you have never
seen fail is not evidence of anything.

That step is enforced in CI, which deliberately corrupts the FIFO and fails the
build if the tests still pass.

## Exercises

Phase 1, `01-sync-fifo`, is complete. A first-word-fall-through FIFO with seven
tests including a reference model checked every cycle. The bug to hunt is the
depth boundary.

Phases 2 through 4 are planned and not yet built. Phase 2 is an AXI4-Lite slave
with a log parser, where the bug is a handshake deadlock diagnosed from a
waveform. Phase 3 is a round-robin arbiter with constrained-random stimulus and
functional coverage, where the randomiser finds a fairness violation that
directed tests miss. Phase 4 adds SystemVerilog assertions and a formal proof
with SymbiYosys, where formal disproves a property that simulation passed.

Each phase pairs one hardware block with one piece of Python tooling, because
that is the actual shape of a verification job.

## Skills

`/new-exercise` scaffolds a folder and writes the spec, then stops before the
RTL. `/rtl-review` checks Verilog against the defects lint cannot prove.
`/debug-log` walks a bug to a written root cause and refuses a fix without one.
`/ai-delta` records what the model produced and where it was wrong.

## On the AI question

`docs/ai-and-the-engineer.md` sets out a position on which parts of this work
are being automated and which are not, and argues the opposing case as well. It
is a hypothesis with very little evidence behind it so far. The per-exercise
`AI-DELTA.md` files are the evidence, and when they contradict the document, the
document is what changes.
