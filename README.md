# llm-harness-builder

See what your agent harness really sends to a local LLM, and why it fails.

A small workbench for the local-model layer of an agent: system prompt, tool description
format, native vs prompted tool calls, schema enforcement, tool-output truncation, context
budget. Every run is a JSONL trace of exactly what went to the model and what came back.

Not a coding agent for daily work. A lab for understanding why your 8B model breaks.

## Quick start

    npx llm-harness-builder demo --model qwen3:8b        # needs Ollama running
    npx llm-harness-builder                              # opens the workbench UI

Against anything that speaks the OpenAI API (llama-server, LM Studio, vLLM):

    npx llm-harness-builder demo \
      --kind openai --base-url http://127.0.0.1:8080/v1 \
      --model unsloth/Qwen3-8B-GGUF:Q4_K_M

`demo` runs the same task twice on the same model with two harnesses, `bare` and `tuned`,
and prints PASS/FAIL from a check script — not from eyeballing the output. Add `--json` to get
the full event stream as JSONL on stdout; the workbench UI keeps every run it starts in
`./runs/*.jsonl`. Diff two traces with any tool.

## Backends

- `kind: "ollama"` talks to Ollama's native `/api/chat` so `num_ctx` is honoured.
  Ollama's OpenAI-compatible `/v1` ignores `num_ctx` and silently truncates the prompt.
- `kind: "openai"` works with llama-server (`--jinja` required for tools), LM Studio, vLLM,
  and anything else serving `/v1/chat/completions`.

## CLI

    llm-harness-builder serve [--port 7331] [--no-open]
    llm-harness-builder run <harness.json> --workdir <dir> "task" [--yes] [--json] [--model m] [--base-url u] [--kind k]
    llm-harness-builder demo [--model m] [--base-url u] [--kind k]

`run` exits 0 only when the model finished with a final answer. `--json` writes the event
stream as JSONL to stdout; human-readable progress goes to stderr.

## Harness file

See `harnesses/tuned.json`. Portable: no paths to your machine; `workdir` and the task are
per-run parameters. The `prompted` mode expects the model to answer with
`{"calls":[{"name":...,"args":{...}}],"final":null|"text"}`; `enforceSchema` passes that shape
as `response_format` / `format`.

## Demo results

Demo verified with: llama.cpp `llama-server` (`--jinja`), model
`unsloth/Qwen3-8B-GGUF:Q4_K_M`, 8192-token context, ~20 tok/s, on 2026-09-12:

    llm-harness-builder demo --kind openai \
      --base-url http://127.0.0.1:8080/v1 --model unsloth/Qwen3-8B-GGUF:Q4_K_M

The task: find a bug report on the single `ERROR` line near the end of a 3002-line
`data/app.log`, fix `src/slugify.js`, and make `node --test` pass. Verdicts come from
`examples/check.sh`, which just runs `node --test`.

| harness | verdict | turns | tool calls | how it ended |
|---|---|---|---|---|
| `bare` — native tool calls, minimal prompt, no truncation | **FAIL** | 5 | 4 | `backend_error`: two invented `edit_file` targets, then a reasoning chain that outlived the HTTP timeout |
| `tuned` — prompted + `enforceSchema`, the `opencode-like` preset plus "run `node --test` before `final`" and `/no_think`, one call per response, 4000-char truncation | **PASS** | 5 | 5 | `final`: fixed `slugify`, ran `node --test`, answered only once it was green |

`bare` found the report on its first turn (`grep -n 'ERROR' data/app.log | tail -1`) and then
twice guessed the line it wanted to replace. First `return str.replace(/\s+/g, '-').toLowerCase();`,
a function that is nowhere in the project; then, after `read_file` had shown it the real body, the
real line plus a semicolon the file does not have. Both edits came back `found 0 occurrences`.
Its fifth request never came back: the model spent over five minutes inside `<think>`, and the
HTTP client gave up. Four responses, 265 s of generation, no test ever run.

`tuned` opened the log the same naive way, with `read_file data/app.log` — and that is where the
truncation knob earned its place: it got the first 4000 chars plus a `[truncated: N more chars]`
marker instead of 250 KB, saw only INFO lines, and switched to `tail -n 20`. From there:
`read_file src/slugify.js`, one `edit_file` copied from what it had just read, `node --test` in
the same turn, and a final answer only after both tests were green. 36 s of generation.

### The third run: `bare` plus one knob

`tuned` differs from `bare` in several knobs at once, so the demo says nothing about which one
carried it. Two runs isolate them:

- **`tuned` minus the `/no_think` line**, everything else identical: **FAIL**, `parse_failed`
  after 5 turns. Two responses in a row spent 4600+ completion tokens inside `<think>`, hit the
  8192-token ceiling and never emitted the JSON object at all. `enforceSchema` was on and did
  nothing — llama.cpp disables the grammar in thinking mode.
- **`bare` plus that one line** and nothing else: **FAIL**, but in a new way. It stopped rambling
  and on turn 3 read the whole log with `read_file`. The next request was 128392 tokens against
  an 8192-token window: `400 exceed_context_size_error`. `bare` has no `maxToolOutputChars`, so
  nothing capped that read.

Read that as: on this model no single knob fixes `bare`. Turning thinking off stops the model
from burning its whole context window before it answers; truncating tool output stops one
`read_file` from doing the same. Only both together leave enough room for the loop to finish.
The knobs that come next in the trace — "run `node --test` before you answer" and one tool call
per response — are what keep the model from declaring victory on a red test suite, which is how
both harnesses failed on the very first run of this demo.

## Honest notes

- Traces are raw. Anything the model reads (including `.env`) ends up in `runs/`.
  Point `workdir` at a scratch copy or a git repo. `bash` asks for approval by default.
- `enforceSchema` is not a guarantee: llama.cpp's grammar can fail open in some cases and is
  disabled in thinking mode. The parser is lenient regardless. In the run above, `enforceSchema`
  did nothing at all until thinking was off — the model kept spending its whole budget inside
  `<think>` and never reached the JSON.
- Token estimates are `chars / 4`; exact counts are shown from the backend's `usage` when present.
- Requests are not streamed, so a single generation that takes longer than 300 s dies with
  `error: fetch failed` — that is Node's HTTP client giving up, not the model. On a ~20 tok/s
  box a runaway reasoning chain reaches it; the trace shows the request that died.
- `/no_think` is a Qwen3 convention. On another model family, drop that line from
  `harnesses/tuned.json` and use whatever switch that model has.
- Abort cannot interrupt a tool that is already running; `bash` returns within its 30 s
  timeout, then the run ends.
- The token estimate counts messages only, not the native-mode `tools[]` payload (roughly
  500-600 tokens for the five tools); rely on the backend's `usage` figure next to it.
- `demo --kind openai` needs `--base-url` (the default URL is Ollama's port).
- The UI has no built-in workdir: run `demo` once and point the UI's workdir at the temp
  directory it prints, or at any scratch project.
