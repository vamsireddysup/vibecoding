# Debug log: 01-sync-fifo

Newest entry first. Every entry needs a root cause. "Changed it and it worked"
is not a root cause, it is a coincidence you have not investigated yet.

---

## 2026-09-24: CI would have passed a broken design

**Symptom.** The suite correctly reported `TESTS=7 PASS=3 FAIL=4` against a
deliberately broken FIFO, and `tb/run.py` exited 0 anyway.

**Why it mattered more than the FIFO bug.** Nothing in the design was wrong
here. The reporting was wrong. Had this reached CI, every future push would have
shown green regardless of whether the hardware worked, and the whole suite would
have become decoration. A broken test harness is worse than no test harness,
because it manufactures confidence.

**Reproduction.** Replace the `full` assignment with `count == DEPTH - 1`, run
`python3 tb/run.py`, then `echo $?`. Observed 0, expected non-zero.

**Hypothesis.** I assumed `runner.test()` raises or exits non-zero when a test
fails, by analogy with pytest. First check was whether the failure was even
being recorded, since a harness that loses the result and a harness that
mis-reports it need different fixes.

**Experiment.** Read the return type: `runner.test()` is annotated `-> Path`. It
returns the path to the results XML and nothing else. So the result was recorded
correctly and only the exit status was wrong, which pointed at the script rather
than at cocotb.

**Root cause.** `cocotb_tools.runner.Runner.test()` reports results by writing
`results.xml`. It does not raise on failure and does not set an exit status. My
`run.py` called it for its side effects and then unconditionally `return 0`.

**Fix.** Capture the returned path, pass it to `cocotb_tools.runner.get_results()`,
which gives back `(total, failed)`, and return 1 when `failed` is non-zero.

**What would have caught this earlier.** Testing the harness against a known-bad
design before trusting it against an unknown one. I only found it because the
plan required a deliberate-break step. Without that step the bug ships silently.
The general rule: after writing any checker, feed it something that must fail and
confirm it says so.

---

## 2026-09-24: module would not elaborate

**Symptom.** `sync_fifo.v` failed to elaborate. The `count` port is declared as
`[ADDR_W:0]`, and `ADDR_W` was a `localparam` in the module body.

**Root cause.** Ports are elaborated before the module body, so a localparam
declared in the body does not exist yet when the port list is read. Ordering,
not arithmetic.

**Fix.** Moved `ADDR_W` into the parameter list as `parameter integer ADDR_W =
$clog2(DEPTH)`, with a comment that it is derived and must not be overridden at
instantiation. The alternative, writing `[$clog2(DEPTH):0]` directly in the port,
also works but repeats the expression.

**What would have caught this earlier.** Linting after writing the port list
rather than after writing the whole module. The turnaround on `verilator
--lint-only` is under a second, so there is no reason to batch up a whole file
before checking it.

---

## Planted bug, for practice

Not a real defect, kept here as the exercise. Change the `full` assignment to
`count == DEPTH - 1` and rerun. Expect `test_fill_exactly_to_full` to fail first
with a message naming the depth boundary, followed by three others. The point is
to read the failure and reason from it to the line, rather than reverting and
moving on.
