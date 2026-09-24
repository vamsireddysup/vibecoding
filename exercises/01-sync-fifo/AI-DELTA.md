# AI delta: 01-sync-fifo

What the model produced, what was wrong with it, and what the correction cost.
This exists so that claims about AI-assisted engineering in
`docs/ai-and-the-engineer.md` can be checked against something rather than
asserted.

Seeded by Claude during repo setup, so the first entries describe Claude's own
output. Entries you write yourself carry more weight; add them as you go.

---

## Entry 1: the FIFO RTL

**Asked for.** A synchronous first-word-fall-through FIFO matching the spec in
this folder's README.

**Came back.** Structurally correct on the first attempt. The extra-bit pointer
scheme for distinguishing full from empty was right, the write-enable and
read-enable gating was right, and it linted clean under `verilator -Wall` once
it elaborated.

**Wrong with it.** One elaboration error: `ADDR_W` used in a port declaration
while declared as a localparam in the body. A Verilog ordering rule, not a logic
error.

**Correction cost.** Under a minute, caught by the first lint run.

**Reading.** The interesting part is that the design was correct because the
spec was written first and specified the ordering rule and the full condition
explicitly. The failure mode to watch for is asking for "a FIFO" with no spec,
where the model picks a full condition and you have no basis to say it is wrong.

---

## Entry 2: the test harness

**Asked for.** A runner script so `make test` and CI share one entry point.

**Came back.** A script that built the design, ran the tests, and returned 0.

**Wrong with it.** It returned 0 unconditionally. `runner.test()` does not raise
on failure, so the script reported success against a design with four failing
tests. See the debug log entry for the full trace.

**Correction cost.** Around ten minutes, and it was only found because the plan
demanded a deliberate-break check.

**Reading.** This is the pattern worth generalising. The model wrote plausible
code that ran without error and did the wrong thing quietly. No syntax error, no
exception, no warning. What caught it was a human-designed check that asked
whether the tool reports failure when failure exists. Reviewing the code by
reading it would probably not have caught it, because `return 0` at the end of a
function that completed successfully looks entirely normal.

---

## Entry 3: the cocotb API

**Asked for.** A cocotb testbench.

**Came back.** N/A. Claude checked the installed API before writing rather than
writing from memory.

**Reading.** cocotb 2.x renamed the `units` argument to `unit` and moved
`cocotb.runner` to `cocotb_tools.runner`. A testbench written from memory of
cocotb 1.x examples would have failed on both, and the error messages point at
the symptom rather than at "your model's training data predates this release".
Version drift in libraries is a standing weakness, and the cheap defence is
`inspect.signature` against what is actually installed.
