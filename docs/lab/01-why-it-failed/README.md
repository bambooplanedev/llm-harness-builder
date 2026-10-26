**English** · [Українська](README.uk.md)

# Exercise 1: why it failed

No model needed. About 10–20 minutes.

Run `d63e9548` used the `bare` harness and failed. Find why, and what in `tuned-nothink` prevents
it. Run `059867d3` is `tuned-nothink` passing the same task with the same model.

## Ways in

**The UI.** Run `npx llm-harness-builder serve` in an empty folder (see [Setup](../README.md#setup)).
Under **Start here**, open the FAIL `bare` run `d63e9548` and the PASS `tuned-nothink` run
`059867d3` (the **Examples** link next to the **Runs** heading opens the example bench, where
both are listed). Optionally, look at the
strip above the turns of `d63e9548`: turn 6 still has a column, an estimate (≈), so you can see what
was sent on the turn that never got a reply. Then open the example bench and press `⇄` to compare a `bare` run
with a `tuned-nothink` one: the knobs that differ are listed first.

**The terminal.** This path needs no browser, so it also works inside the container from
[Safety](../README.md#safety-before-any-exercise-with-a-model). The package ships both traces, so copy
them into `./runs` (create the folder first; then the id alone works):

    mkdir -p runs && cp node_modules/llm-harness-builder/example-runs/*.jsonl runs/
    npx llm-harness-builder analyze d63e9548 059867d3

`node_modules/llm-harness-builder/` is where `npm i` put the package; run `npx` from the folder that
holds `node_modules`. Without the package installed, `curl -fLO` fetches the same files, for example
`curl -fLO https://raw.githubusercontent.com/bambooplanedev/llm-harness-builder/main/example-runs/d63e9548.jsonl`
(the `node:22.12-slim` image has no `curl`), and `analyze ./d63e9548.jsonl ./059867d3.jsonl` takes the paths.

`analyze` prints one row per run: how it ended, the turns, the last wait. It shows neither the
total time nor what each turn did, so for questions 1–3 open the traces in the UI, or read the
`.jsonl` itself: one JSON event per line, each with a `ts` (the first line is `meta`, with the start
time). This prints one line per event (turn, type, seconds since the start, tool name or end reason):

    node -e 'let t0;for(const l of require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n")){const e=JSON.parse(l);if(e.meta)t0=e.meta.started;else if(e.type!="context_stats")console.log(e.turn,e.type,((e.ts-t0)/1e3).toFixed(1)+"s",e.name||e.reason||"")}' runs/d63e9548.jsonl

The total run time is the `done` event's `ts` minus `meta.started`. A turn with an `llm_request` but
no `llm_response` is the one that never got a reply.

The two harness files are [`bare.json`](../../../harnesses/bare.json) and
[`tuned-nothink.json`](../../../harnesses/tuned-nothink.json). With the package from npm, the same
files are in `node_modules/llm-harness-builder/harnesses/`, and in `./harnesses` once `serve` has run
in the folder.

## Questions

1. How did `d63e9548` end, and after how long?
2. What was its last turn, and what came back?
3. What happened on the turns before it?
4. Which settings of `tuned-nothink` would have stopped it?

Write your answers down, then compare: [solution](solution.md).
