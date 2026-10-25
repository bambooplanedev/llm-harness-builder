**English** · [Українська](README.uk.md)

# Exercise 3: replay a turn

Optional. Needs qwen3:8b on Ollama ([Setup](../README.md#local)). About 10 minutes.

Run `059867d3` (`tuned-nothink`, PASS) recorded every request it sent. `replay` sends one of them
again, exactly as it was sent, several times, and compares the replies. No tool runs, so nothing
the model asks for is executed: a replay needs no container.

## Steps

    curl -fLO https://raw.githubusercontent.com/bambooplanedev/llm-harness-builder/main/example-runs/059867d3.jsonl
    npx llm-harness-builder replay ./059867d3.jsonl --turn 2 --n 5 --kind ollama --base-url http://localhost:11434

The cloud does not fit here: the recorded request names the local model `qwen3:8b` and Ollama's own
fields, and a hosted API gets it as it was recorded.

## What the output says

While it runs, a line `sample i/n: same as recorded` or `differs` per sample goes to stderr. After
them, the first line of the result says how many samples were sent and how many **distinct** replies came back. Then one
line per distinct reply: how many samples gave it, whether it is `same as recorded` (the reply the
run got at that turn) or `differs`, and the start of the reply. Replies are compared by their
content and tool calls, not by thinking text or call ids. Open turn 2 of `059867d3` in the UI to see
what the recorded reply was.

## The question

From what you see: would a second run of `tuned-nothink` take the same path at turn 2? And what
does a replay not tell you about how that second run would end?

Solution: `solution.md` (not written yet: it waits for a measurement).
