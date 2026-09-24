# Setup

Linux, or WSL2 on Windows. The versions below are the ones this repo was
verified against, not minimums.

## Toolchain

```
sudo apt-get update
sudo apt-get install -y iverilog verilator gtkwave make python3 python3-pip
```

Verified with Icarus Verilog 12.0, Verilator 5.020 and cocotb 2.1.0 on Ubuntu
24.04 with Python 3.11.

## Python

A virtual environment is the right habit, though the repo works without one.

```
python3 -m venv .venv
source .venv/bin/activate
pip install cocotb
```

If you skip the venv on a Debian or Ubuntu system, pip will refuse to install
into the system Python and suggest `--break-system-packages`. That flag works
and is what CI uses, but on your own machine the venv is better.

## Check it works

```
make lint
make test
```

Expect Verilator to report nothing and the suite to finish with `7/7 tests
passed` and `1/1 exercises passed`.

## Confirm the tests can actually fail

This matters more than the previous step. A suite that passes tells you nothing
until you have seen it fail.

In `exercises/01-sync-fifo/rtl/sync_fifo.v`, replace the two-line `full`
assignment with `assign full = (count == DEPTH - 1);` and run `make test` again.
Four tests must fail, and the first message should name the depth boundary. Then
restore the file with `git checkout exercises/01-sync-fifo/rtl/sync_fifo.v`.

## Waveforms

Each run writes `exercises/NN-name/sim_build/*.fst`. Open the most recent one
with `make waves` from inside the exercise directory, or point GTKWave at the
file directly. Learning to read these is the whole of phase 2, so it is worth
opening one now even when nothing is wrong, to see what correct looks like.

## Windows without WSL

The open-source RTL toolchain is painful natively on Windows. Install WSL2 with
`wsl --install` from an administrator PowerShell, pick Ubuntu, then follow the
Linux instructions inside it. Keep the repository on the Linux filesystem under
`~/`, not under `/mnt/c/`, because simulation across the mount boundary is slow
enough to be annoying.
