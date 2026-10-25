**English** · [Українська](solution.uk.md)

# Exercise 2: solution

The file: [`solution.json`](solution.json) is `start.json` plus one key, `"think": false` in `backend`.

## What changed and why

`backend.think: false`. Exercise 1 showed `bare` ending in `aborted` with a last request that never got a
reply: with thinking on, qwen3:8b likely
spends a whole turn thinking (inferred from the trace, not measured). Switching it off makes a turn
short.

## What was measured

Local: qwen3:8b on Ollama, an RTX 4070 laptop GPU, task `slug`, timeout 600 s.

| harness | PASS | 95% interval | reasons | median turns | median time |
|---|---|---|---|---|---|
| `start.json` | 2 of 4 | 0.15–0.85 | two `final`, two `aborted` at 1800 s | — | — |
| `start.json` + `backend.think: false` | 8 of 10 | 0.49–0.94 | `final` ×10 | 10 | 12 s |

The `start.json` interval is Wilson 95% for 2 of 4. The row is from earlier recordings of `bare` (n = 4, two of them aborted at the old
1800 s timeout), not a fresh n = 10 run. The second row is a fresh bench, n = 10.

Two more arms were planned, `context.maxToolOutputChars: 4000` and `tools.explainEditMiss: true`.
They were not measured: the first arm already passed the bar of 8 of 10, so the file stops there.

## On the cloud

[`solution-cloud.json`](solution-cloud.json) is the solution without `backend.think`, because a hosted
API refuses that key. It is then the same as the starter apart from its name. On the hosted model the
starter itself passed, so this solution changes nothing there; the file is here to copy.

Measured with `start.json` on OpenRouter, the free model `nvidia/nemotron-3.5-lightning:free`, n = 3,
timeout 600 s, on 2026-10-26:

| harness | PASS | 95% interval | reasons | median turns | median time |
|---|---|---|---|---|---|
| `start.json` | 3 of 3 | 0.44–1.00 | `final` ×2, `max_turns` ×1 | 5 | 17 s |

One of the three PASS runs ended on `max_turns`: the check passed (the tests were green) even though the
model never said it was done.

## Scope

Each row is that model, that stand, that task, those few runs. Your model may need a different set
of keys: the check is the bench, not this page.
