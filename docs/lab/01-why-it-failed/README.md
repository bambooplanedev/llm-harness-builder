**English** · [Українська](README.uk.md)

# Exercise 1: why it failed

No model needed. About 10–20 minutes.

Run `d63e9548` used the `bare` harness and failed. Find why, and what in `tuned-nothink` prevents
it. Run `059867d3` is `tuned-nothink` passing the same task with the same model.

## Ways in

**The UI.** Run `npx llm-harness-builder serve` in an empty folder (see [Setup](../README.md#setup)).
Under **Start here**, open the FAIL `bare` run `d63e9548` and the PASS `tuned-nothink` run
`059867d3` (**Examples** opens the example bench, where both are listed). Optionally, look at the
strip above the turns of `d63e9548`: turn 6 still has a column, an estimate (≈), so you can see what
was sent on the turn that never got a reply. Then open the example bench and press `⇄` to compare a `bare` run
with a `tuned-nothink` one: the knobs that differ are listed first.

**The terminal.** Download the two traces into the current folder (or into `./runs`, so the id alone
works):

    curl -fLO https://raw.githubusercontent.com/bambooplanedev/llm-harness-builder/main/example-runs/d63e9548.jsonl
    curl -fLO https://raw.githubusercontent.com/bambooplanedev/llm-harness-builder/main/example-runs/059867d3.jsonl
    npx llm-harness-builder analyze ./d63e9548.jsonl ./059867d3.jsonl

The two harness files are [`bare.json`](../../../harnesses/bare.json) and
[`tuned-nothink.json`](../../../harnesses/tuned-nothink.json).

## Questions

1. How did `d63e9548` end, and after how long?
2. What was its last turn, and what came back?
3. What happened on the turns before it?
4. Which settings of `tuned-nothink` would have stopped it?

Write your answers down, then compare: [solution](solution.md).
