"""cocotb tests for sync_fifo.

The checking strategy is a reference model: a Python deque that is supposed to
behave exactly like the FIFO. Every read compares the DUT's output against the
model's, so a bug shows up as a mismatch at a specific cycle rather than as a
vague "it hung". Directed tests pin down the boundaries the model alone would
only reach by luck.

Timing convention used everywhere in this file: stimulus is driven one
nanosecond after a rising edge, so it is stable well before the edge that
samples it. Every helper leaves the simulation one nanosecond past an edge, so
helpers can be called back to back without racing the clock.
"""

import random
from collections import deque

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge, Timer

WIDTH = 8
DEPTH = 8

CLK_PERIOD_NS = 10
SETTLE_NS = 1


async def _edge(dut):
    """Advance past the next rising edge and let outputs settle."""
    await RisingEdge(dut.clk)
    await Timer(SETTLE_NS, unit="ns")


async def setup(dut):
    """Start the clock, apply reset, leave the DUT idle and empty."""
    cocotb.start_soon(Clock(dut.clk, CLK_PERIOD_NS, unit="ns").start())

    dut.rst_n.value = 0
    dut.wr_en.value = 0
    dut.rd_en.value = 0
    dut.wr_data.value = 0

    for _ in range(3):
        await _edge(dut)

    dut.rst_n.value = 1
    await _edge(dut)


async def push(dut, value):
    """Present a write for one cycle. Ignored by the DUT if it is full."""
    dut.wr_en.value = 1
    dut.wr_data.value = value
    await _edge(dut)
    dut.wr_en.value = 0


async def pop(dut):
    """Sample the head, then pop it. Only valid when the FIFO is not empty."""
    assert not dut.empty.value, "pop() called on an empty FIFO"
    value = int(dut.rd_data.value)
    dut.rd_en.value = 1
    await _edge(dut)
    dut.rd_en.value = 0
    return value


@cocotb.test()
async def test_reset_state(dut):
    """After reset the FIFO reports empty, not full, and holds nothing."""
    await setup(dut)

    assert dut.empty.value == 1, "FIFO should be empty out of reset"
    assert dut.full.value == 0, "FIFO should not be full out of reset"
    assert int(dut.count.value) == 0, "count should be 0 out of reset"


@cocotb.test()
async def test_single_write_then_read(dut):
    """One item in, the same item out, and the flags move with it."""
    await setup(dut)

    await push(dut, 0xA5)

    assert dut.empty.value == 0, "FIFO should not be empty after one write"
    assert int(dut.count.value) == 1, f"count should be 1, got {int(dut.count.value)}"

    got = await pop(dut)
    assert got == 0xA5, f"read back {got:#04x}, expected 0xa5"
    assert dut.empty.value == 1, "FIFO should be empty again after the read"


@cocotb.test()
async def test_fill_exactly_to_full(dut):
    """full must assert on the DEPTH-th write, and not one write earlier.

    This is the test that catches an off-by-one in the full condition, which is
    the single most common bug in a hand-written or generated FIFO. Asserting
    full at DEPTH-1 silently wastes a slot; asserting at DEPTH+1 corrupts data.
    """
    await setup(dut)

    for i in range(DEPTH):
        assert dut.full.value == 0, (
            f"full asserted early: it went high with only {i} items stored, "
            f"but the FIFO holds {DEPTH}"
        )
        await push(dut, i)
        assert int(dut.count.value) == i + 1, (
            f"after {i + 1} writes count reads {int(dut.count.value)}"
        )

    assert dut.full.value == 1, (
        f"full did not assert after {DEPTH} writes; the FIFO thinks it can "
        f"hold more than its depth"
    )
    assert dut.empty.value == 0, "a full FIFO cannot also be empty"


@cocotb.test()
async def test_write_when_full_is_ignored(dut):
    """A write to a full FIFO must be dropped, not wrap over the oldest item."""
    await setup(dut)

    for i in range(DEPTH):
        await push(dut, i)
    assert dut.full.value == 1

    await push(dut, 0xFF)

    assert int(dut.count.value) == DEPTH, (
        f"count grew past DEPTH to {int(dut.count.value)} after writing while full"
    )

    for i in range(DEPTH):
        got = await pop(dut)
        assert got == i, (
            f"item {i} came back as {got}; the overflowing write corrupted the queue"
        )


@cocotb.test()
async def test_drain_exactly_to_empty(dut):
    """empty must assert on the DEPTH-th read, and not one read earlier."""
    await setup(dut)

    for i in range(DEPTH):
        await push(dut, i)

    for i in range(DEPTH):
        assert dut.empty.value == 0, (
            f"empty asserted early: it went high with {DEPTH - i} items still stored"
        )
        got = await pop(dut)
        assert got == i, f"expected {i}, got {got}"

    assert dut.empty.value == 1, f"empty did not assert after {DEPTH} reads"
    assert dut.full.value == 0, "an empty FIFO cannot also be full"


@cocotb.test()
async def test_read_when_empty_is_ignored(dut):
    """A read from an empty FIFO must not move the pointer."""
    await setup(dut)

    dut.rd_en.value = 1
    await _edge(dut)
    await _edge(dut)
    dut.rd_en.value = 0
    await _edge(dut)

    assert dut.empty.value == 1, "FIFO stopped reporting empty after a read while empty"
    assert int(dut.count.value) == 0, (
        f"count is {int(dut.count.value)} after reading an empty FIFO; the read "
        f"pointer moved when it should have been held"
    )

    await push(dut, 0x3C)
    got = await pop(dut)
    assert got == 0x3C, (
        f"read back {got:#04x} instead of 0x3c; the underflowing read desynchronised "
        f"the pointers"
    )


@cocotb.test()
async def test_random_against_model(dut):
    """Random traffic checked cycle by cycle against a deque.

    Note the ordering rule this encodes: whether a write or read takes effect is
    decided by the full and empty flags as they stand *before* the clock edge.
    So a simultaneous read and write on a full FIFO drops the write, even though
    the read frees a slot on that same edge. The model has to make the same
    decision from the same pre-edge values or it will drift out of step.
    """
    await setup(dut)

    random.seed(1234)
    model = deque()

    for cycle in range(2000):
        wr_en = random.random() < 0.5
        rd_en = random.random() < 0.5
        value = random.randrange(0, 1 << WIDTH)

        pre_full = bool(dut.full.value)
        pre_empty = bool(dut.empty.value)
        head = None if pre_empty else int(dut.rd_data.value)

        assert pre_full == (len(model) == DEPTH), (
            f"cycle {cycle}: DUT full={pre_full} but model holds {len(model)} items"
        )
        assert pre_empty == (len(model) == 0), (
            f"cycle {cycle}: DUT empty={pre_empty} but model holds {len(model)} items"
        )

        dut.wr_en.value = int(wr_en)
        dut.wr_data.value = value
        dut.rd_en.value = int(rd_en)
        await _edge(dut)
        dut.wr_en.value = 0
        dut.rd_en.value = 0

        if rd_en and not pre_empty:
            expected = model.popleft()
            assert head == expected, (
                f"cycle {cycle}: read {head}, model expected {expected}"
            )
        if wr_en and not pre_full:
            model.append(value)

        assert int(dut.count.value) == len(model), (
            f"cycle {cycle}: count reads {int(dut.count.value)}, model holds "
            f"{len(model)}"
        )

    dut._log.info(f"random test finished with {len(model)} items left in the FIFO")
