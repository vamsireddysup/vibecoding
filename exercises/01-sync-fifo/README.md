# 01: synchronous FIFO

Write the spec before the RTL. Everything below was fixed before a line of
Verilog existed, because a testbench can only check behaviour that somebody
decided on first.

## Interface

| Signal | Direction | Width | Meaning |
| --- | --- | --- | --- |
| `clk` | in | 1 | rising-edge clock, single domain |
| `rst_n` | in | 1 | asynchronous active-low reset |
| `wr_en` | in | 1 | request to write `wr_data` this cycle |
| `wr_data` | in | WIDTH | data to write |
| `rd_en` | in | 1 | request to remove the head this cycle |
| `rd_data` | out | WIDTH | the head of the queue, valid whenever `empty` is low |
| `full` | out | 1 | the FIFO holds DEPTH items |
| `empty` | out | 1 | the FIFO holds nothing |
| `count` | out | ADDR_W+1 | number of items currently stored |

Parameters are `WIDTH` (default 8) and `DEPTH` (default 8, must be a power of
two). `ADDR_W` is derived as `$clog2(DEPTH)` and must not be overridden.

## Behaviour

Reads are first-word-fall-through. When `empty` is low, `rd_data` already shows
the oldest item with no read latency, and asserting `rd_en` for one cycle
removes it. This is a deliberate choice over a registered read: it removes the
one-cycle skid that otherwise has to be reasoned about in every test.

A write takes effect on the rising edge when `wr_en` is high and `full` is low.
A write while `full` is high is dropped with no other effect, and in particular
it must not overwrite the oldest item.

A read takes effect on the rising edge when `rd_en` is high and `empty` is low.
A read while `empty` is high is dropped and must not advance the read pointer.

`full` asserts when exactly DEPTH items are stored, not DEPTH-1. `empty` asserts
when exactly zero are stored. `full` and `empty` are never high at the same time.

## The ordering rule that catches people out

Whether a write or a read takes effect is decided by `full` and `empty` as they
stand before the clock edge, not after. A simultaneous read and write on a full
FIFO therefore drops the write, even though the read frees a slot on that same
edge. Any reference model has to make its decision from the same pre-edge values
or it drifts out of step with the hardware within a few cycles.

## Why the pointers carry an extra bit

Both pointers are ADDR_W+1 bits wide. The low ADDR_W bits index the memory, and
the top bit flips on each wrap. Equal pointers means empty; equal low bits with
differing top bits means full. Without that extra bit, full and empty are
indistinguishable, because both are "the pointers are equal".

The tempting alternative is a separate `count` register compared against DEPTH.
It works, but it adds a third piece of state that has to stay consistent with
two pointers, and that is a second thing to get wrong rather than a
simplification.

## Running it

```
make lint     # Verilator, -Wall, must be clean
make test     # Icarus + cocotb, 7 tests
make waves    # open the FST dump from the last run in GTKWave
```

## The exercise

Once it passes, break it on purpose and confirm the testbench notices. Change
the `full` assignment to `count == DEPTH - 1` and rerun. Four tests should fail,
and the first message should name the depth boundary rather than saying
something vague about a mismatch. If a change like that leaves the suite green,
the suite is decorative and the bug is in your tests, not your design.
