#!/usr/bin/env python3
"""Build and run the sync_fifo simulation. Exits non-zero if any test fails.

Uses cocotb's Python runner rather than the legacy Makefile include, so the same
entry point works from `make test`, from tools/run_regression.py and from CI
without three different invocations.
"""

import sys
from pathlib import Path

from cocotb_tools.runner import get_runner, get_results

HERE = Path(__file__).resolve().parent
EXERCISE = HERE.parent

WIDTH = 8
DEPTH = 8


def main() -> int:
    runner = get_runner("icarus")

    runner.build(
        sources=[EXERCISE / "rtl" / "sync_fifo.v"],
        hdl_toplevel="sync_fifo",
        parameters={"WIDTH": WIDTH, "DEPTH": DEPTH},
        build_dir=EXERCISE / "sim_build",
        build_args=["-g2012"],
        timescale=("1ns", "1ps"),
        waves=True,
        always=True,
    )

    results_xml = runner.test(
        hdl_toplevel="sync_fifo",
        test_module="test_sync_fifo",
        test_dir=HERE,
        build_dir=EXERCISE / "sim_build",
        timescale=("1ns", "1ps"),
        waves=True,
    )

    # runner.test() does not raise on a failing test, it just writes the result
    # into the XML. Without this check the script would exit 0 on a broken
    # design and CI would report green, which is worse than having no CI.
    total, failed = get_results(results_xml)
    print(f"\n{total - failed}/{total} tests passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
