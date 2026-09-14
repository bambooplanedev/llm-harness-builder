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

`demo` runs the same task three times on the same model with three harnesses, `bare`, `tuned`
and `tuned-hermes`, and prints PASS/FAIL from a check script — not from eyeballing the output.
Add `--json` to get the full event stream as JSONL on stdout; the workbench UI keeps every run it
starts in `./runs/*.jsonl`. Diff two traces with any tool.

## Backends

- `kind: "ollama"` talks to Ollama's native `/api/chat` so `num_ctx` is honoured.
  Ollama's OpenAI-compatible `/v1` ignores `num_ctx` and silently truncates the prompt.
- `kind: "openai"` works with llama-server (`--jinja` required for native tool calls), LM Studio, vLLM,
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

`toolCalls.format` picks how a `prompted` run talks: `json` (the shape above) or `hermes`
(`<tool_call>{"name":…,"arguments":…}</tool_call>` blocks, results in `<tool_response>`, and a
plain-text reply means "done"). `enforceSchema` only applies to `json`.

## Model families

A family button in the UI (`applyFamily` in `src/core/prompts.ts`) fills the tool-call mode,
format, prompted template and parse-error hint, and swaps the trailing family line of the system
prompt. It never touches backend, tools, context or loop settings, and nothing about the family is
stored in the harness file — only the resulting plain fields.

| family | mode / format | prompt line | why |
|---|---|---|---|
| `qwen3` | prompted / hermes | `/no_think` | trained on `<tool_call>` XML; `/no_think` keeps an 8B from burning the window in `<think>` |
| `gemma` | prompted / json | — | no native tool calling in the chat template (Ollama rejects `tools[]`); no thinking switch |
| `llama3` | native / json | — | native tool calls work through the chat template; nothing to add |

Why a prompted hermes format when llama-server (`--jinja`) and Ollama already parse Qwen's
`<tool_call>` natively: it works without `--jinja` and on any `/v1`; a malformed block becomes a
visible `parse_error` with a hint and a retry instead of an empty `content`; and the trace shows the
exact text the model wrote. If the server does lift the blocks into `tool_calls` anyway, the run
uses them and the raw response in the trace shows that it happened.

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
| v1 run · `bare` — native tool calls, minimal prompt, no truncation | **FAIL** | 5 | 4 | `backend_error`: two invented `edit_file` targets, then a reasoning chain that outlived the HTTP timeout |
| v1 run · `tuned` — prompted + `enforceSchema`, the `opencode-like` preset plus "run `node --test` before `final`" and `/no_think`, one call per response, 4000-char truncation | **PASS** | 5 | 5 | `final`: fixed `slugify`, ran `node --test`, answered only once it was green |
| v2.0.1 run · `tuned-hermes` — `tuned` with the `qwen3` family applied: same prompt, `/no_think`, one call per response, 4000-char truncation, but `<tool_call>` blocks instead of the JSON object and no `enforceSchema` | **PASS** | 6 | 5 | `final`: a plain-text summary, sent only after `node --test` came back green |

The `bare` and `tuned` rows are from the v1 run; the `tuned-hermes` row is from a v2.0.1 re-run of
all three. On the re-run for v2.0.1, `bare` ended `final` instead of `backend_error` — the 300 s
transport limit is gone, so its two runaway turns (398 s and 371 s) now come back as
`finish_reason: length` parse errors, and it still ended FAIL, answering with the JSON object it
was supposed to send as tool calls while `node --test` was still red.

On the v1 run, `bare` found the report on its first turn (`grep -n 'ERROR' data/app.log | tail -1`) and then
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

`tuned-hermes` walked the same path in `<tool_call>` blocks: `read_file data/app.log` (truncated at
4000 chars, INFO lines only), `bash tail -n 20 data/app.log` for the ERROR line, `read_file
src/slugify.js`, one `edit_file` copied from what it had just read, `bash node --test` — two tests
green — and then turn 6 was plain prose with no block at all, which in `hermes` format *is* the
final answer. Six turns, five calls, one block per response, not one malformed block and not one
parse error. 34 s of generation, against the 35 s `tuned` took in that same re-run: on this model
the XML shape costs nothing and buys the trace. And the server did not do the parsing — prompted
mode sends no `tools[]`, so llama-server left the blocks in `message.content` (visible in the raw
response in the trace) and `parseHermes` read them. One run each; PASS rates over repeated runs are
the next iteration's job.

### Isolating the knobs: two more runs

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
- `/no_think` is a Qwen3 convention. Applying another family removes it; on a model this tool has
  no family for, delete the line by hand.
- In `hermes` format a reply with no `<tool_call>` block is the final answer — that is how these
  models were trained. A polite "let me read the file first" with no call therefore ends the run
  with `final` and exit code 0. The trace and the CLI mark it as `final after 0 tool calls`; that
  is the model quitting, not the parser.
- `enforceSchema` is ignored for `hermes` (a JSON schema cannot describe the XML wrapper).
- A literal `</tool_call>` inside a JSON string argument (say, `write_file` of a file that contains
  that text) cuts the block short → `parse_error` → hint → retry.
- A response cut off at max tokens (`finish_reason: length`) is treated as a parse error in every
  format, so a model that spent its whole window inside `<think>` gets the hint and a retry rather
  than having its thoughts accepted as the answer.
- Abort cannot interrupt a tool that is already running; `bash` returns within its 30 s
  timeout, then the run ends.
- The token estimate counts messages only, not the native-mode `tools[]` payload (roughly
  500-600 tokens for the five tools); rely on the backend's `usage` figure next to it.
- `demo --kind openai` needs `--base-url` (the default URL is Ollama's port).
- The UI has no built-in workdir: run `demo` once and point the UI's workdir at the temp
  directory it prints, or at any scratch project.
