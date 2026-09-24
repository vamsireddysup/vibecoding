#!/usr/bin/env python3
"""Run every exercise's test suite and print a summary table.

An exercise is anything under exercises/ that contains tb/run.py. Exit status is
non-zero if any exercise fails, so this works as the single CI gate.
"""

import argparse
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
EXERCISES = REPO / "exercises"


def discover():
    if not EXERCISES.is_dir():
        return []
    return sorted(p for p in EXERCISES.iterdir() if (p / "tb" / "run.py").is_file())


def run_one(exercise: Path, verbose: bool):
    started = time.time()
    proc = subprocess.run(
        [sys.executable, "tb/run.py"],
        cwd=exercise,
        capture_output=not verbose,
        text=True,
    )
    elapsed = time.time() - started
    output = "" if verbose else (proc.stdout or "") + (proc.stderr or "")
    return proc.returncode, elapsed, output


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "-v", "--verbose", action="store_true",
        help="stream simulator output instead of capturing it",
    )
    args = parser.parse_args()

    exercises = discover()
    if not exercises:
        print("No exercises found. Nothing to run.")
        return 0

    results = []
    for exercise in exercises:
        print(f"running {exercise.name} ...", flush=True)
        code, elapsed, output = run_one(exercise, args.verbose)
        results.append((exercise.name, code, elapsed))
        if code != 0 and not args.verbose:
            # Only the tail, because a failing cocotb run prints a great deal
            # and the useful part is at the end.
            print("".join(output.splitlines(keepends=True)[-30:]))

    width = max(len(name) for name, _, _ in results)
    print()
    print(f"{'exercise':<{width}}  status  time")
    print("-" * (width + 16))
    for name, code, elapsed in results:
        print(f"{name:<{width}}  {'PASS' if code == 0 else 'FAIL':<6}  {elapsed:5.1f}s")

    failed = sum(1 for _, code, _ in results if code != 0)
    print()
    print(f"{len(results) - failed}/{len(results)} exercises passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
