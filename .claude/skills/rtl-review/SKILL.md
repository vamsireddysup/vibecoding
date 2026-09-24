---
name: rtl-review
description: Review Verilog or SystemVerilog against the defects that actually cause silicon bugs, including reset handling, blocking assignments in sequential logic, inferred latches, clock domain crossings, and full/empty off-by-ones. Use before committing RTL, when reviewing generated RTL, or when the user asks whether a design looks correct.
---

# rtl-review

Lint catches what a tool can prove. This catches what it cannot. Run
`verilator --lint-only -Wall` first and fix whatever it reports, because there
is no point reviewing by hand what a tool would have told you in a second.

## Checklist

Go through every item and report on each one, including the ones that pass. A
review that lists only problems leaves the reader unable to tell what was
examined and what was skipped.

**Reset.** Does every piece of state that needs a known value out of reset get
one? Is the polarity consistent with the rest of the design? Is the reset
asynchronous or synchronous, and is that the same everywhere? State that is
deliberately not reset is a legitimate choice for large memories and should be
commented as deliberate, so the next reader does not "fix" it.

**Assignment discipline.** Nonblocking in sequential blocks, blocking in
combinational ones. Mixing them in one block is a race that may simulate
correctly today and differently after a tool upgrade.

**Inferred latches.** In a combinational block, does every branch assign every
output? A missing else or a missing default in a case statement infers a latch,
which usually is not what was meant and often still passes a simple test.

**Sensitivity lists.** Prefer `always @(*)`. An explicit list that omits a
signal creates a simulation and synthesis mismatch, where the simulation is the
one that is wrong.

**Width mismatches.** Verilog truncates and extends silently. Check that
comparisons and assignments have matching widths, especially around `$clog2`
results and around counters that can wrap.

**Full and empty.** For anything queue-shaped, check the boundary condition
explicitly. Asserting full at DEPTH-1 wastes a slot and often goes unnoticed for
years. Asserting at DEPTH+1 corrupts data. Confirm that full and empty cannot be
high simultaneously.

**Simultaneous access.** When a read and a write can land on the same edge,
which flags decide the outcome, the pre-edge or post-edge values? Whatever the
answer, it must match what the testbench's reference model assumes.

**Clock domain crossings.** Any signal crossing domains needs a synchroniser,
and a multi-bit signal needs more than two flip-flops, it needs a gray-coded
pointer or a handshake. A two-flop synchroniser on a multi-bit bus is a bug that
simulates fine and fails in hardware.

**Unreachable and dead logic.** Case items that cannot occur, conditions that
are always true. Usually a sign that the design drifted from the spec.

## Output

For each finding, give the file and line, what is wrong, what it would cause in
hardware, and the change. Separate the findings that are definitely wrong from
the ones that are stylistic. Do not pad the list; three real findings beat
twelve observations about naming.

If the design is clean, say so plainly rather than inventing a finding to look
thorough.
