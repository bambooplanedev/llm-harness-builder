**English** · [Українська](README.uk.md)

# Lab kit

Three short exercises on one small task, `slug`: fix a one-line bug in `src/slugify.js` and make
`node --test` pass. Each takes 10 to 40 minutes.

| exercise | what you do | what it needs |
|---|---|---|
| [1. Why it failed](01-why-it-failed/README.md) | read a recorded failed run and find what the passing harness does differently | Node only, no model |
| [2. Make bare pass](02-make-bare-pass/README.md) | change one harness file until `bench` passes with it | a model, local or cloud |
| [3. Replay a turn](03-replay-a-turn/README.md) | send one recorded turn again and see if the model takes the same path | a local model; optional |

## Setup

### Local

1. Node 22.12 or newer.
2. Ollama from its [download page](https://ollama.com/download), started, then:

       ollama pull qwen3:8b

3. In an **empty folder** (`serve` copies the shipped `harnesses/` into the folder it runs in):

       mkdir lab && cd lab
       npx llm-harness-builder serve

Exercise 1 needs only step 1 and step 3.

### Cloud

No GPU: the same commands run on a hosted API, as in the README's
[Cloud](https://github.com/bambooplanedev/llm-harness-builder#cloud) section. Add these four flags to
`bench`:

    --kind openai --base-url https://openrouter.ai/api/v1 \
      --api-key-env OPENROUTER_API_KEY --model nvidia/nemotron-3-super-120b-a12b:free

A free OpenRouter account is enough: models whose id ends in `:free` cost nothing, but OpenRouter
allows them 20 requests a minute and 50 a day. A hosted API refuses `backend.think`. Every number
in this kit is from qwen3:8b on Ollama: your numbers on the cloud will differ.

### Safety, before any exercise with a model

`bench` approves every command the model sends and runs it as you, with your files and your
environment. So:

- Run it in a container. From the lab folder:

      docker run --rm -it -v "$PWD":/work -w /work node:22.12-slim bash

  An Ollama on the host is then `--base-url http://host.docker.internal:11434` (on Linux add
  `--add-host=host.docker.internal:host-gateway` to `docker run`). The UI is not reachable from a
  container, so open traces with `serve` on the host: that needs no model.
- Use a key with a spend limit, made for this.
- Keep no other secrets in that environment.
- Never put a key in `tools.bashEnv`: that hands it to every command the model runs.
- Free providers may log your requests. Send nothing you would not publish.

## How to read a trace

**In the UI.** On a first open, with no runs yet, **Start here** in the Runs list opens a recorded
PASS run and a FAIL one; **Examples** opens the same runs at any time, no model needed. A run shows
its turns: what was sent, what came back, each tool call and its result. **Start here** also opens
the example bench: press `⇄` on one of its runs to compare it with the open one — which config knobs
differ, and the path of both turn by turn with the first divergence marked.

**In the terminal.** `npx llm-harness-builder analyze <trace.jsonl | run-id | bench.json> ...` prints
one row per run. A run id is looked up in `./runs`. The columns:

- `harness`, `run`: the harness name and the run id.
- `verdict`: how the run ended — `final` (the model answered), `aborted` (stopped from outside, for
  example by `bench`'s timeout), `max_turns`, `parse_failed` and the like.
- `turns`: requests sent to the model.
- `stub@`: the turn the context budget first replaced old tool results with a stub.
- `ate`: which tool results that stub removed.
- `edit@`: the turn of the first edit that applied.
- `loop on`: the file with the most failed edits, how many edits and writes it got (`×4`), and the
  failures by kind (`zero 2`: two edits whose `old` text occurred nowhere).
- `reread`: the first time the model read a file again after its earlier read was stubbed.
- `unanswered`: how long the last request of the run waited with no reply.

`—` means there was nothing to show.

## How to check yourself

- Exercise 1: compare your answers with its [solution](01-why-it-failed/solution.md).
- Exercise 2: run the `bench` command the exercise gives. It counts as passed at 2 or more PASS out
  of 3. Three runs are noisy: 2 of 3 has a 95% Wilson interval of 0.21–0.94, so a pass says the
  file can work, not how often.
- Exercise 3: compare with its solution.

## Scope

The numbers in this kit come from qwen3:8b on Ollama (RTX 4070 laptop), on the `slug` task, a few
runs each: they say what this model did on this task, not what a knob does in general. See
[How to read the results](https://github.com/bambooplanedev/llm-harness-builder#how-to-read-the-results).
