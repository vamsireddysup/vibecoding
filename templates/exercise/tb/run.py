#!/usr/bin/env python3
"""Build and run this exercise's simulation. Exits non-zero if any test fails."""

import sys
from pathlib import Path

from cocotb_tools.runner import get_runner, get_results

HERE = Path(__file__).resolve().parent
EXERCISE = HERE.parent

TOPLEVEL = "TOPLEVEL"
TEST_MODULE = "test_TOPLEVEL"


def main() -> int:
    runner = get_runner("icarus")

    runner.build(
        sources=[EXERCISE / "rtl" / f"{TOPLEVEL}.v"],
        hdl_toplevel=TOPLEVEL,
        build_dir=EXERCISE / "sim_build",
        build_args=["-g2012"],
        timescale=("1ns", "1ps"),
        waves=True,
        always=True,
    )

    results_xml = runner.test(
        hdl_toplevel=TOPLEVEL,
        test_module=TEST_MODULE,
        test_dir=HERE,
        build_dir=EXERCISE / "sim_build",
        timescale=("1ns", "1ps"),
        waves=True,
    )

    # runner.test() does not raise on failure, it only writes the XML. Without
    # this check the script exits 0 on a broken design and CI reports green.
    total, failed = get_results(results_xml)
    print(f"\n{total - failed}/{total} tests passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
