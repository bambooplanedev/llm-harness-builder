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
Add `--json` to get the full event stream as JSONL on stdout. Every run, from the UI or the CLI,
is kept in `./runs/*.jsonl`; start `serve` from the same directory to browse them (reload the list
after a CLI run). Diff two traces with any tool — or, for two runs of one `bench`, press `⇄` on a
run row in the **Bench** tab: it compares that run with the open one, showing which config knobs
differ, the per-turn path of both with the first divergence marked, and the time and tokens each
turn cost. The UI has two tabs: **Workbench** runs one harness and shows its trace, **Bench**
watches a `bench` run happening in another terminal — its table, and the live trace of the run in
flight.

The current turn streams live in the UI and in `run`/`demo` on a terminal: `<think>` and the answer
appear as they are generated; the UI adds a rough `~N tok` counter. The trace keeps one
`llm_response` per turn; the live text is not saved.

`demo` is one run per harness. `bench` repeats it and reports PASS rates:

    npx llm-harness-builder bench --n 5 \
      --kind openai --base-url http://127.0.0.1:8080/v1 \
      --model unsloth/Qwen3-8B-GGUF:Q4_K_M

Run `demo` first: it takes a few minutes and shows you the trace and that the backend is alive.
`bench --n 5` on the setup of [Bench results](docs/findings.md#bench-results) took 96 minutes, most
of it `bare`.

## How to read the results

Every number in this README and in [the findings](docs/findings.md), and every "did not help", comes
from one model — Qwen3-8B Q4_K_M on llama-server — and three small tasks, two of which are the same
ten units in another order; five runs or fewer per arm, often near-clones at temperature 0.2. The
one exception is its own section, [A second model](docs/findings.md#a-second-model-2026-10-09),
three runs per arm of one other model on two of those tasks. A result here says what that model did
on that task with that harness. It does not say what a knob does: a knob that moved nothing here may
move another model, or this one on another task, and a knob that helped here may not help yours.
That is what `bench` and the traces are for. The knobs that showed no effect are still in the tool,
off by default, for that reason; the one change that was dropped (the labelled stub) was dropped for
what it cost, and its paragraph says on what evidence. At five runs an interval is wide: `bench`
prints the 95% one next to every PASS count now, and the tables in the findings, printed before it
did, carry none.

## Backends

- `kind: "ollama"` talks to Ollama's native `/api/chat` so `num_ctx` is honoured.
  Ollama's OpenAI-compatible `/v1` ignores `num_ctx` and silently truncates the prompt.
- `kind: "openai"` works with llama-server (`--jinja` required for native tool calls), LM Studio, vLLM,
  and anything else serving `/v1/chat/completions`.

## CLI

    llm-harness-builder serve [--port 7331] [--no-open]
    llm-harness-builder run <harness.json> --workdir <dir> "task" [--yes] [--json] [--answer-schema file.json] [--model m] [--base-url u] [--kind k]
    llm-harness-builder demo [--model m] [--base-url u] [--kind k]
    llm-harness-builder bench [harness.json ...] [--n 3] [--timeout 1800] [--out runs/bench-<ts>.json] [--task slug|pool|pool2|sift|triage|judge] [--size N] [--max-turns N] [--model m] [--base-url u] [--kind k]
    llm-harness-builder replay <run-id | trace.jsonl> --turn N --base-url u --kind k [--n 5] [--temperature t] [--max-tokens m] [--json]
    llm-harness-builder analyze <bench.json | run-id | trace.jsonl> ... [--json]
    llm-harness-builder proxy [--upstream http://127.0.0.1:8080] [--port 8090] [--name label]

`run` exits 0 only when the model finished with a final answer. `--json` writes the event
stream as JSONL to stdout; human-readable progress goes to stderr.

`bench` runs a task (`slug`, the demo's, by default) `--n` times per harness, round-robin, with a
per-run `--timeout` (seconds). With no files it takes `bare`, `tuned` and `tuned-hermes` from
`./harnesses` (the copies `serve` made, i.e. what you edited in the UI) or from the package. It
prints a PASS-rate table and writes a JSON to `runs/` after every run, so Ctrl-C keeps what
finished. Next to each PASS count the table prints its 95% Wilson interval: 1/3 is 0.06–0.79 and 3/3
is 0.44–1.00, so at `--n 3` even 3/3 against 1/3 does not tell two harnesses apart. The JSON carries
each harness's full config and each run's `reason`, `parseErrors`, `toolErrors`, `lastError`, temp
`workdir` and `trace` (the run's `runs/<id>.jsonl`), so two files are comparable by config, not by
name. Exit code is 0 whatever the verdicts.

Before the first run `bench` asks each server what it can without generating. A server that does not
answer, or lacks the model, stops the bench with exit code 2 and no JSON. The model name is checked
only where the server serves by it: Ollama (`qwen3` means `qwen3:latest`) and a llama-server router.
A one-model llama-server answers to any name. On llama-server the window and build come from
`/props`; a router reports them per model at `/props?model=`, which loads that model if it is not
loaded yet. On Ollama the window is the harness's `numCtx`. Both go into the JSON as each harness's
`server`, and a `budgetTokens` that with `maxTokens` on top is over the window gets a warning — the
budget cannot keep such a run inside it. LM Studio and vLLM have no `/props`: window unknown, no
warning.

`--task` picks another task, and every task but `slug` needs a `--size`. `pool` and `pool2` are
described with their measurements in [The pool task](docs/findings.md#the-pool-task). `sift`,
`triage` and `judge` (sizes up to 12) are steps of a news curator on synthetic fixtures
(`examples-sift`, `examples-triage`): `sift` splits a screener's verdicts into two files and is
checked character by character; `triage` has the model write KEEP or DROP for each new post into a
file, and the fixture carries its key; `judge` is the same judgement as one request, with the posts
in the task text and the verdicts as the final answer.

`replay` takes the request a recorded run sent at turn N (`runs/<id>.jsonl` keeps every one) and
sends it again, as it was sent, `--n` times; `--temperature` and `--max-tokens` are the only things
it can change. It prints how many distinct replies came back and which of them is the recorded one.
Replies are compared by content and native tool calls, not by thinking text or call ids. No tool
runs, so a replay says where the next call goes on that turn and nothing about how a run would end.
The trace does not record where the run was sent, hence `--base-url` and `--kind`; the server has
to have the window the run had, and one that is too small refuses the request. Of the checks this
README calls replays, the command repeats the ones that sent a recorded request unchanged: the
`pool2` loop turn and the harmless turn under `repeatTemperature` (`replay 153d3718 --turn 8
--temperature 1 --n 10`, and `411812a4 --turn 6` likewise). It does not repeat the ones that edited
the recorded history first (the stub text, the notes of a counter the run did not have), and the
"replayed against 5120" passages are arithmetic over traces, with no model in them. The traces
named here are not in the repository; the command is for yours.

`analyze` reads traces and prints, per run, what the model never saw again: the turn the budget
first stubbed and which tool results that stub removed, the turn of the first successful edit, the
file with the most failed edits (with the errors by kind), and the first time the model read a file
again after its earlier read was stubbed. A trace records each request as sent, not what a stub
removed, so the stubs are rebuilt by comparing consecutive requests; a stub that cannot be tied to
results is printed as `unmatched`, never guessed. It takes bench JSONs, run ids and trace paths,
`.jsonl.part` included; `--json` prints the whole analysis. The Bench tab shows the same cells under
each run, and a trace shows them above its first turn, with `[stubbed at tN]` on each removed
result.

## Recording another agent

`proxy` sits between an agent you did not write and llama-server. It forwards every request as it
came and writes each conversation it sees to `runs/<id>.jsonl`, the file `run` writes. The Runs page
then shows that agent's requests and replies, and `replay` takes any of its turns.

    llm-harness-builder proxy --upstream http://127.0.0.1:8080 --port 8090 --name opencode

Start it in the directory `serve` runs in (both use `./runs`) and give the agent
`http://127.0.0.1:8090/v1` as its OpenAI base URL. `--upstream` is the server root, not its `/v1`.
Every path goes through; only `POST …/chat/completions` is recorded. Ctrl-C (or `kill`) ends every
open run with `done: aborted`, which here means "the recording stopped", not that the agent failed.

What the file holds is a transcription, never a guess:
- `llm_request` is the agent's body; `llm_response` is the server's reply, streamed or not. `usage`
  is there when the server sent it: llama-server sends it when the agent asks, and some builds
  always do.
- `tool_call` is an entry of the reply's `tool_calls`, kept even on a reply cut at max tokens (a run
  of ours drops those). Calls an agent makes through text, in a prompted format, show only inside
  `llm_response`.
- `tool_result` is the tool message the agent sent back on its next request, matched to its call
  through the ids the agent echoed. It has no error or truncation flag: the proxy cannot know them.
  It is written when that next request arrives, so the file reads `call, call, result, result`; the
  page groups by turn and shows it the same.
- Never written: `context_stats`, `parse_error`, `final_check`, `approval_required`, `done: final`.
  The meta line's `proxy` field marks such a file.

Where a run starts. The proxy keys a conversation by its first system message and its first user
message, and a request with the same pair and no fewer messages than the last one continues it.
That fits agents whose first user message is the task and whose history only grows; it does not fit
aider, whose first user message is its edit examples. So:
- a new round of the same task, and a history the agent compacts, start new runs; a retry stays;
- a side request with its own system prompt is its own short run: each of opencode's history
  compactions is one. Its session title is not: that request never grows past three messages and
  does not depend on the task, so every session's title request over the proxy's whole lifetime
  joins the one run opened by the first; that run's Runs row shows the title instruction, not the
  task;
- our own harness through the proxy splits where it changes those messages: a
  `loop.repeatThinkTokens` turn is a one-turn run, and `loop.freshContext` starts a new one;
- two identical sessions at the same time interleave in one run, and two sessions of the same task
  one after the other share the run of their identical one-message side requests.

The Runs page follows a running session. While the proxy that writes it is alive (its pid is in the
meta line) `serve` does not mark the run aborted, and the page picks up new events every few
seconds. If the proxy was killed and the system has given its pid to another process, the run shows
as running until that process ends.

Like every trace, a recorded one holds everything the agent read and its system prompt, local paths
included. Request headers, an API key among them, are never written.

Checked with opencode 1.18.32 (`npx opencode-ai run --pure "calc.py has a bug in add; fix it"`) on
`unsloth/Qwen3-8B-GGUF:Q4_K_M`, llama-server b11046 with `--jinja --parallel 1`, and this in the
project's `opencode.json`:

    {
      "provider": {
        "lab": {
          "npm": "@ai-sdk/openai-compatible",
          "options": { "baseURL": "http://127.0.0.1:8090/v1" },
          "models": { "unsloth/Qwen3-8B-GGUF:Q4_K_M": { "name": "qwen3-8b" } }
        }
      },
      "model": "lab/unsloth/Qwen3-8B-GGUF:Q4_K_M",
      "permission": { "edit": "allow", "bash": "deny", "webfetch": "deny" }
    }

What the proxy saw. Every request was streamed and asked for `usage`, which came on every reply.
The main session's first request is two messages and eight tools, about 8,900 tokens, so opencode
does not fit the 4096 window the other checks here use. At `-c 4096` the server refused it; opencode
took the refusal for oversized attachments and compacted its history again and again, nine runs in
five minutes before it was stopped. At `-c 16384` it fixed the bug in three turns (a `read`, an
`edit`, then nothing), recorded as the main run plus a one-turn title run. The third turn is worth
opening: the model wrote its next `read` call inside its thinking, the server found no tool call in
the reply, and opencode took that as the end. `replay` of the `edit` turn gave the recorded call 2
times out of 2. That is one model on one task: it says the proxy records what opencode sends, not
how opencode does on local models.

Whether that third turn was worth a knob — taking a call out of the thinking — was checked by
`replay`, each turn of that session sent ten times as recorded. The first two turns gave a real
call ten times out of ten: the `read`, then the `edit`. The third, after the fix, gave a final
text seven times and the `read` inside the thinking three times. None of the 197 earlier traces in
`runs/` has a reply that ended with a call in its thinking. So on this model and task the call
went into the thinking only on the turn that checks finished work, never on a working turn (0 of
20), and no knob was built for it. That says nothing about other models.

## Harness file

See `harnesses/tuned.json`. Portable: no paths to your machine; `workdir` and the task are
per-run parameters. The `prompted` mode expects the model to answer with
`{"calls":[{"name":...,"args":{...}}],"final":null|"text"}`; `enforceSchema` passes that shape
as `response_format` / `format`.

A key the harness file format does not have is an error that names it, at the top level, in every
section and in each `mcpServers` entry: every optional knob is off when absent, so a misspelt
one would otherwise be silently off.

`backend.maxTokens` caps the tokens of one response, thinking included; without it a generation
runs until the window is full. `numCtx` is sent to Ollama only.

`backend.think` sets the chat template's thinking switch: `chat_template_kwargs.enable_thinking` on
an OpenAI-compatible server (llama-server reads it), `think` on Ollama. Absent, nothing is sent and
the model's own default holds, so a harness without the key sends the request it always sent. It is
for a model that thinks unless told otherwise through the template; the `/no_think` line of the
shipped harnesses is a Qwen3 convention and another family does not read it. With
`loop.repeatThinkTokens` the thinking turn goes out with the switch on, whatever `think` says.

`toolCalls.format` picks how a `prompted` run talks: `json` (the shape above) or `hermes`
(`<tool_call>{"name":…,"arguments":…}</tool_call>` blocks, results in `<tool_response>`, and a
plain-text reply means "done"). `enforceSchema` only applies to `json`.

In `native` mode `enforceSchema` does one other thing, and only in a harness with no tools at all
(`tools.enabled` empty, no `mcpServers`): when the task has a schema for its final answer (the
`judge` task of `bench` does), the request carries it, and the server holds the reply to it. Such a
run is one request. With any tool enabled the schema is not sent: it is the form of the final
answer, not of the turns before it.

`run --answer-schema <file.json>` gives such a schema to a task of your own. With a harness that
would not send it, `run` stops before any request and says why; a schema quietly dropped would be
a run like any other whose answer nothing had held to a form. The server does the enforcing, and
a server may ignore the field, so with the flag `run` exits 0 only when the final answer parses
as JSON. Whether that JSON fits the schema is left to the caller. The answer is the `text` of the
`done` event in `--json`.

## Model families

A family button in the UI (`applyFamily` in `src/core/prompts.ts`) fills the tool-call mode,
format, prompted template and parse-error hint, and swaps the trailing family line of the system
prompt. It never touches backend, tools, context or loop settings, and nothing about the family is
stored in the harness file — only the resulting plain fields.

| family | mode / format | prompt line | why |
|---|---|---|---|
| `qwen3` | prompted / hermes | `/no_think` | trained on `<tool_call>` XML; `/no_think` kept Qwen3-8B from burning the window in `<think>` (one run: [Isolating the knobs](docs/findings.md#isolating-the-knobs-two-more-runs)) |
| `gemma` | prompted / json | — | no native tool calling in the chat template (Ollama rejects `tools[]`); no line to add for thinking — a Gemma that thinks by default is switched by `backend.think` (Gemma 12B on llama-server: reasoning on 0 of 36 turns of `sift` with `think: false`) |
| `llama3` | native / json | — | native tool calls work through the chat template; nothing to add |

Why a prompted hermes format when llama-server (`--jinja`) and Ollama already parse Qwen's
`<tool_call>` natively: it works without `--jinja` and on any `/v1`; a malformed block becomes a
visible `parse_error` with a hint and a retry instead of an empty `content`; and the trace shows the
exact text the model wrote. If the server does lift the blocks into `tool_calls` anyway, the run
uses them and the raw response in the trace shows that it happened.

## MCP

A harness can take its tools from MCP servers over stdio instead of, or beside, the built-in five:

    "tools": { "enabled": ["bash"], "approveBash": true },
    "mcpServers": {
      "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] }
    }

Each server starts with `cwd` set to the run's `workdir` — the same relative-path behaviour `bash`
already has — and every start asks for approval unless `--yes`. Tool names stay flat, with no server
prefix; a name that collides with a built-in one ends the run before the first request to the model.
A server's `tools: [...]` is an allow-list; absent or empty means everything the server offers.

Worth measuring, because the tool text is the first thing to eat the context window. Against
`@modelcontextprotocol/server-filesystem@2026.8.31`:

| | tools | description + schema | ≈ tokens | of an 8192 `numCtx` |
|---|---|---|---|---|
| built-ins (all five) | 5 | 1193 chars | ~298 | 3.6% |
| the MCP server as it comes | 14 | 7167 chars | ~1792 | **22%** |
| the same server, allow-list of 4 | 4 | 1914 chars | ~479 | 5.8% |

Six times the tool text and a fifth of the window gone before the model has seen the task — and
that is the default, because nobody configures the allow-list. The structure is worse than the
size: the server offers four ways to read a file (`read_file`, marked DEPRECATED in favour of
`read_text_file`, plus `read_media_file` and `read_multiple_files`) and three ways to list a
directory. That did not confuse Qwen3-8B in a probe run — `list_allowed_directories`,
`list_directory`, `read_text_file`, three calls, no repeats, and it obeyed the DEPRECATED note the
first time it read it. So the claim here is that an unconfigured MCP server costs a fifth of the
window, not that it confuses the model; the trace shows which tool yours picked.

`harnesses/mcp-off.json` and `harnesses/mcp-on.json` are the two arms: one tool-agnostic prompt,
the same backend and loop settings, file tools from the built-ins in one and from the server in the
other. `bash` is in both, because the demo task runs `node --test` and a filesystem server has no
shell. They are not in the default bench set — that set should not need the network for `npx` — so
run them by name:

    llm-harness-builder bench harnesses/mcp-off.json harnesses/mcp-on.json --n 5

The table then grows two columns: `toolChars`, what the servers put in front of the model, and
`med errs`, tool results that came back as errors. Unlike the PASS rate, neither depends on the
sample size.

Five runs per arm, on the same setup as [Bench results](docs/findings.md#bench-results), on
2026-09-13:

| harness | PASS | how the runs ended | median turns | median s | `toolChars` | `med errs` |
|---|---|---|---|---|---|---|
| `mcp-off` — file tools from the built-ins | **5/5** | `final×5` | 5 | 31 | — | 0 |
| `mcp-on` — the same tools from the server | **3/5** | `backend_error×2 final×3` | 5 | 45 | 6439 | 0 |

Fisher's exact test puts 5-against-3 at p = 0.44, so read that PASS column as an illustration and
nothing more. The traces are worth more than the count, because both failures are identical to the
token.

Every `mcp-off` run opened with 605 tokens of context and every `mcp-on` run with 1742. The prompt
is fixed, so that 1137-token gap is the tool text, the same in all ten runs. In the two failing
runs turn 4 ran away to 5062 completion tokens and came back `finish_reason=length` — a
`parse_error`, which normally costs one retry and nothing else. The retry request carried 8229
tokens against a `numCtx` of 8192, and llama-server answered 400.

**Correction, 2026-09-19.** This paragraph used to conclude that the window cost surfaces one step
late: that `mcp-off` absorbs the same runaway with room to spare while `mcp-on` has no room left to
retry, so "a recoverable parse error becomes an unrecoverable 400". Both halves were wrong, and the
traces that were already on disk say so. No `mcp-off` run ran away — its largest completion in five
runs is 110 tokens — so there was nothing it absorbed. And the 1137-token gap plays no part in the
400. No output cap is sent, so a response that comes back `finish_reason=length` has filled the
window exactly (3130 + 5062 = 8192), and the retry — that history, that response and the hint — is
8192 + 37 tokens in any arm, however small its tool text. With the runaway in `content`, the retry
this harness offered could never fit on llama-server. (A runaway inside `<think>` comes back as
`reasoning`, which is never sent again, and there the retry works: that is `bare`, below.)

What ran away was one string. The request carried the `enforceSchema` grammar; both failing runs
wrote the replacement as `\"\"`, lost the escaping around character 396 and closed their JSON while
the grammar still held them inside an open string, where the output is not allowed to end. They
produced `` `** `` for 295 s, until the window was full. The three passing runs wrote `''` from the
same prefix and were done in about 160 tokens. Code inside a nested JSON string — MCP's
`edits[].newText` — is a likelier trigger than the size of the descriptions; that is the first
caveat below, and it is still not shown. What stays measured: 22% of the window, 1742 against 605
tokens, and `med errs` 0 on both sides — the model handled either set of tools without a single
tool error.

Since that date a cut-off response no longer goes back whole. The history gets
`[response cut off at the token limit: kept 0 of 7765 chars]`; the trace keeps the full text and says
how much was left out. Checked by replaying the recorded turn-5 request of one failing run against
the same server with that one message replaced (`max_tokens: 400` in the replay script only): 3192
tokens instead of 8229, and the reply parses, five times of five — five clones at this temperature,
so read it as one sample. Keeping the first 396 or 500 characters parsed five of five as well, but
the model then wrote `\"\"` again; given the marker alone it wrote `''`. This is an existence check
on one recorded history, not a PASS rate. No run was repeated and the table above stands as
measured; its `backend_error×2` would not happen the same way today.

The other half is the 295 s. `mcp-on`, like every shipped harness but `bare`, now sends
`"maxTokens": 1024`. The recorded turn-4 request that ran away, sent again with that cap — six times
through the shipped adapter, three as plain non-streaming requests: nine tries, eight of them the healthy 162-token answer, and one ran away again —
the same `` `** `` — and was cut at 1024 tokens after 55 s. With the cap the retry fits even
without the marker (3130 + 1024 + 37), for as long as the prompt leaves that much room. One in
nine here against two in five in the table is not a rate either; it says the runaway is sampling,
not something in those two prompts.

Two caveats, both honest. **The arms differ in more than the size of the descriptions**: tool names
and argument shapes differ too, and MCP's `read_file` takes `head`/`tail`, which the built-in one
does not — in places MCP is the stronger arm. The pair therefore measures "MCP as a whole way of
handing tools to a model", not "the cost of tool descriptions". And **an MCP server runs outside
the `workdir` sandbox**: the built-in file tools are locked in by `resolveInside`, while a server
merely receives the directory as `cwd` and respects it out of goodwill.

## Findings

What was measured with this tool, each section with its setup and its traces, in
[docs/findings.md](docs/findings.md). Read "How to read the results" above first.

- [Read before edit](docs/findings.md#read-before-edit) — `requireReadBeforeEdit` against the
  sentence in the prompt that asks for the same.
- [Bench results](docs/findings.md#bench-results) — `bare`, `tuned` and `tuned-hermes` on the old
  task, one run step by step, and two more that isolate the knobs.
- [Explaining an edit miss](docs/findings.md#explaining-an-edit-miss) — `explainEditMiss`.
- [Noticing a repeated call](docs/findings.md#noticing-a-repeated-call) — `loop.maxRepeats`.
- [The pool task](docs/findings.md#the-pool-task) — `pool` and `pool2`, and what
  `context.budgetTokens` did on them.
- [Three ways out of a loop](docs/findings.md#three-ways-out-of-a-loop) — `repeatTemperature`,
  `freshContext`, `untilBash` and `repeatThinkTokens`.
- [A second model, 2026-10-09](docs/findings.md#a-second-model-2026-10-09) — Bonsai 2 27B on the old
  task and on `pool2`.

## Honest notes

Limits, known failure paths and what the numbers do not say:
[docs/honest-notes.md](docs/honest-notes.md).
