# NN: name

Write this before any RTL exists. See docs/workflow.md for why.

## Interface

| Signal | Direction | Width | Meaning |
| --- | --- | --- | --- |
| `clk` | in | 1 | rising-edge clock |
| `rst_n` | in | 1 | asynchronous active-low reset |

## Behaviour

What the block does. Reset state. What is guaranteed and what is not.

## Boundaries

What happens at zero, at maximum, at wrap. These are where the bugs are.

## Same-edge behaviour

When two operations land on the same clock edge, which wins, and are the
deciding flags sampled before or after the edge? The reference model has to make
the same choice or it drifts out of step.

## Out of scope

What this deliberately does not handle, so a reviewer does not report it missing.

## Design choices

Where an alternative existed, which way it went and why.

## Running it

```
make lint
make test
make waves
```
