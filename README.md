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
`bench --n 5` on the setup below took 96 minutes, most of it `bare`.

## Backends

- `kind: "ollama"` talks to Ollama's native `/api/chat` so `num_ctx` is honoured.
  Ollama's OpenAI-compatible `/v1` ignores `num_ctx` and silently truncates the prompt.
- `kind: "openai"` works with llama-server (`--jinja` required for native tool calls), LM Studio, vLLM,
  and anything else serving `/v1/chat/completions`.

## CLI

    llm-harness-builder serve [--port 7331] [--no-open]
    llm-harness-builder run <harness.json> --workdir <dir> "task" [--yes] [--json] [--model m] [--base-url u] [--kind k]
    llm-harness-builder demo [--model m] [--base-url u] [--kind k]
    llm-harness-builder bench [harness.json ...] [--n 3] [--timeout 1800] [--out runs/bench-<ts>.json] [--model m] [--base-url u] [--kind k]

`run` exits 0 only when the model finished with a final answer. `--json` writes the event
stream as JSONL to stdout; human-readable progress goes to stderr.

`bench` runs the demo task `--n` times per harness, round-robin, with a per-run `--timeout`
(seconds). With no files it takes `bare`, `tuned` and `tuned-hermes` from `./harnesses` (the copies
`serve` made, i.e. what you edited in the UI) or from the package. It prints a PASS-rate table and
writes a JSON to `runs/` after every run, so Ctrl-C keeps what finished. The JSON carries each
harness's full config and each run's `reason`, `parseErrors`, `toolErrors`, `lastError`, temp `workdir` and
`trace` (the run's `runs/<id>.jsonl`), so two files are comparable by config, not by name. Exit
code is 0 whatever the verdicts.

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

Five runs per arm, on the same setup as **Bench results** below, on 2026-09-13:

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

So the window cost does not surface as "the model got confused". It surfaces one step later: the
runaway generation that `mcp-off` absorbs with room to spare leaves `mcp-on` no room to retry, and
a recoverable parse error becomes an unrecoverable 400. This is the same wall `bare` hits in
**Isolating the knobs** below, reached from the other direction — there by a tool result nothing
truncated, here by tool descriptions nothing pruned. `med errs` is 0 on both sides: the model
handled either set of tools without a single tool error.

Two caveats, both honest. **The arms differ in more than the size of the descriptions**: tool names
and argument shapes differ too, and MCP's `read_file` takes `head`/`tail`, which the built-in one
does not — in places MCP is the stronger arm. The pair therefore measures "MCP as a whole way of
handing tools to a model", not "the cost of tool descriptions". And **an MCP server runs outside
the `workdir` sandbox**: the built-in file tools are locked in by `resolveInside`, while a server
merely receives the directory as `cwd` and respects it out of goodwill.

## Read before edit

`tuned` already asks the model to read a file before it changes it:

    Never guess file contents. Read a file before you change it; …

It seems to work: `toolErrors` is 0 in every bench run that recorded the field. `bare`, whose
prompt says nothing of the kind, guessed twice in the run described below — a function body that
is nowhere in the project, then a semicolon the file does not have — and both edits came back
`found 0 occurrences`.

So the open question is not whether the rule is needed. It is whether a rule stated in the prompt
and the same rule enforced in code do the same thing. Claude Code does not ask the model to read
first; it refuses to edit a file the model has not read. `tools.requireReadBeforeEdit` is that
refusal:

    "tools": { "enabled": ["read_file", "edit_file"], "requireReadBeforeEdit": true }

`read_file` registers the file's resolved path for the rest of the run. `edit_file` refuses a path
that is not registered, and so does `write_file` when the file already exists — creating a new one
is always allowed. The model sees `src/x.js has not been read in this run; call read_file first`
and can recover from it like any other tool error. Nothing about the guard appears in the tool
descriptions, so the guard itself costs no context tokens.

The four arms are one 2×2 grid over "rule in the prompt" × "guard in the code". `rule-none`,
`guard-only` and `rule-and-guard` are `tuned` byte-for-byte except for the name, one sentence of
the system prompt, and the flag:

    llm-harness-builder bench harnesses/tuned.json harnesses/rule-none.json \
      harnesses/guard-only.json harnesses/rule-and-guard.json --n 5

Measured on 2026-09-18 on the same setup as **Bench results** below (the command above prints
without `--kind`/`--base-url`/`--model`, house style matching the MCP section; the run used the
flags from that section plus `--timeout 600`), five runs per arm. `tuned` came back at 5 turns and
34 s, the row already published there, so the two tables are comparable:

| harness | rule | guard | PASS | how the runs ended | median turns | `guard` | `editMiss` |
|---|---|---|---|---|---|---|---|
| `tuned` | yes | — | **5/5** | `final×5` | 5 | | 0 |
| `rule-none` | — | — | **4/5** | `final×4 backend_error×1` | 11 | | 16 |
| `guard-only` | — | yes | **0/5** | `max_turns×5` | 15 | 5 | 53 |
| `rule-and-guard` | yes | yes | **5/5** | `final×5` | 5 | 0 | 0 |

`guard` counts the edits the guard refused and `editMiss` the edits whose `old` did not occur
exactly once. Both are sums over the five runs, not medians: a median of five small integers is 0.
`guard` is blank for an arm that had the guard off — those arms cannot produce the error by
construction, which is also why this experiment does not read `med errs`.

What was decided before the run: the estimand is `guard`, a zero would be published, and PASS is
an argument only at 5-against-1 or 4-against-0. `guard-only` 0/5 against `tuned` 5/5 is p = 0.008
and against `rule-none` 4/5 is p = 0.048, so this time PASS is one. Three things the traces show,
identical in every run of an arm:

- **The sentence in the prompt does all the work.** Without it the model's first edit was blind in
  10 runs out of 10 — `edit_file` on `src/slugify.js` with an `old` it had invented, the file never
  opened. With it, 0 out of 10, and the guard in `rule-and-guard` never fired. The `editMiss` of 16
  in `rule-none` against 0 in `tuned` is the same fact counted from the other side, and it is the
  floor this experiment needed.
- **The guard does what it says.** Five blind edits, five refusals, and in all five the very next
  call was `read_file src/slugify.js`.
- **And then `guard-only` lost every run anyway**, not to the guard but to the next error. Having
  read the file, the model sent an `old` ending in a semicolon the file does not have — the guess
  `bare` makes in the run described below — got `found 0 occurrences`, and sent the identical call
  again, ten or eleven times, until `max_turns`. `rule-none` makes the same miss and gets out of
  it in four runs of five: there the model answers a miss by reading the file, or by giving up on
  `edit_file` and rewriting the three-line file with `write_file`. In `guard-only` the file is
  already read, and the model has no second idea.

So on this model a rule in the prompt and the same rule in code are not equivalent, and code is
the weaker of the two: the refusal repairs the one call it refuses, the sentence changes how the
model edits at all. What these five runs cannot separate is the guard from the path it forces —
the honest reading is "a recovered refusal left the model in a state it did not recover from
twice", not "guards are harmful". The cheap next knobs are on the other error: `found 0
occurrences` says nothing about what *is* in the file, and nothing in the loop notices the same
failing call arriving ten times in a row.

## Bench results

Measured with llama.cpp `llama-server` (`--jinja`), model `unsloth/Qwen3-8B-GGUF:Q4_K_M`,
8192-token context, ~20 tok/s, on 2026-09-12, five runs per harness:

    llm-harness-builder bench --n 5 --kind openai \
      --base-url http://127.0.0.1:8080/v1 --model unsloth/Qwen3-8B-GGUF:Q4_K_M

The task: find a bug report on the single `ERROR` line near the end of a 3002-line
`data/app.log`, fix `src/slugify.js`, and make `node --test` pass. Verdicts come from
`examples/check.sh`, which just runs `node --test`.

Every number in this README, the read-before-edit grid of 2026-09-18 included, was measured
against a test file that never produced a leading dash: the bug report asks for leading *and*
trailing dashes to be stripped, and the test of that name only checked the trailing one. Checked
by hand on the grid's 14 PASS runs, 11 fixed only the trailing dash — `slugify("!Hello")` still
returned `"-hello"` — and all 10 PASSes of the two arms with the rule were among them; the three
full fixes were all `rule-none`. The test asserts the leading case since 2026-09-18. Nothing was
re-measured: runs from that date on face a stricter oracle and do not belong in one table with
the numbers here.

| harness | PASS | how the runs ended | median turns | median s |
|---|---|---|---|---|
| `bare` — native tool calls, minimal prompt, no truncation | **1/5** | `final×3 aborted×1 parse_failed×1` | 8 | 1159 |
| `tuned` — prompted + `enforceSchema`, `opencode-like` preset, "run `node --test` before `final`", `/no_think`, one call per response, 4000-char truncation | **4/5** | `final×4 backend_error×1` | 5 | 35 |
| `tuned-hermes` — `tuned` with the `qwen3` family: `<tool_call>` blocks instead of the JSON object, no `enforceSchema` | **4/5** | `final×4 max_turns×1` | 6 | 34 |

Medians are over all five runs including failures; seconds are wall-clock per run, tools
included. The whole bench took 96 minutes. Generation-time figures in the prose below
are a different measure, from single runs.

Two entries in that column are not harness failures in the usual sense. `tuned`'s one
`backend_error` came 1 s after `bare`'s aborted run: llama-server had let `bare` fill the shared
KV cache to the 8192-token limit, the abort from our side does not free the server instantly, and
the next request on any slot got a 500. `tuned-hermes`'s one `max_turns` was a loop: fifteen tool
calls in 87 s without ever stopping to answer.

### One run, step by step

The table says how often; a trace says how. What follows is one run per harness (the v1 and
v2.0.1 demo runs), not the bench.

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
parse error. 34 s of generation, against the 35 s `tuned` took in the v2.0.1 re-run of all three: on this model
the XML shape costs nothing and buys the trace. And the server did not do the parsing — prompted
mode sends no `tools[]`, so llama-server left the blocks in `message.content` (visible in the raw
response in the trace) and `parseHermes` read them.

### Isolating the knobs: two more runs

Two single runs, not benched: they show which mechanism broke, not how often it does.

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

- Five runs per harness is a small sample. By Fisher's exact test only 5-against-1 or 4-against-0
  reaches p < 0.05: 4/5 against 2/5 is p = 0.52, and the `tuned` 4/5 against `bare` 1/5 above is
  p = 0.21 — suggestive, not proof. `toolChars` and the tool-error counts are measured rather than
  sampled, which is why the MCP pair reports them.
- Traces are raw. Anything the model reads (including `.env`) ends up in `runs/`. `run` without
  `--workdir` works in the current directory, so `runs/` lands inside the project the agent reads;
  pass `--workdir`. Point `workdir` at a scratch copy or a git repo. `bash` asks for approval by
  default.
- A CLI run writes `runs/<id>.jsonl.part` and renames it when done, on Ctrl-C included. Only a hard
  kill (or Ctrl-C during `bench`, where the Bench page still reads the `.part`) leaves one behind:
  rename it to `.jsonl` to open it in the UI.
- `enforceSchema` is not a guarantee: llama.cpp's grammar can fail open in some cases and is
  disabled in thinking mode. The parser is lenient regardless. In the run above, `enforceSchema`
  did nothing at all until thinking was off — the model kept spending its whole budget inside
  `<think>` and never reached the JSON.
- Streaming is always on. The raw response in the inspector is assembled from the stream (the last
  chunk plus the collected message), not the chunk log. `<think>` shows as a separate grey block only
  when the server separates it (llama-server `--jinja` with a reasoning format, Ollama `thinking`);
  otherwise the tags arrive inside the text. Known failure path: llama-server builds before May 2025
  answer 400 to `tools` together with `stream`; a buffering proxy delays the live text but the run
  still completes.
- Token counts are exact on llama-server (`/apply-template` + `/tokenize`: chat template and
  `tools[]` included) and a `chars / 4` estimate of the messages elsewhere; the budget trims by
  the estimate in both cases; the backend's `usage` is shown after each response.
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
- `demo --kind openai` needs `--base-url` (the default URL is Ollama's port).
- The UI has no built-in workdir: run `demo` once and point the UI's workdir at the temp directory it prints (or at any `workdir` from a bench JSON), or at any scratch project.
- `bench` PASS means `node --test` came back green, not that the bug was fixed the right way: the
  model has `write_file` and could edit the test instead, and a fix can satisfy the tests while
  missing the report (see the note under **Bench results**: 11 of 14 did). Open the run's trace (`runs[].trace` in
  the JSON, or the run list in the UI) to see what it changed.
- `demo` runs `check.sh` without a timeout; `bench` gives it 60 s.
- Aborting a run (`--timeout`) closes our side of the connection; llama-server keeps generating
  until it notices, so the next run can start against a busy server and fail with
  `backend_error`. The bench above has one such row.
- The guard covers `edit_file` and `write_file`, not the filesystem. `bash` can rewrite a file
  behind its back (`sed -i`, `>`, a formatter, `npm`), and the next edit will be checked against a
  registration that is still there.
- MCP tools bypass the guard completely: `runTool` hands an unknown name to the server before any
  check, so in a harness whose file tools come from an MCP server the flag does nothing. Same
  boundary as the sandbox: a server merely receives the workdir as `cwd`.
- The registry holds paths, not versions. A file that changed after it was read is not caught by
  the guard — `edit_file`'s exact match catches it instead, as `found 0 occurrences`.
- The registry records that the call happened, not what the model saw. A `read_file` whose output
  the run loop cuts at `maxToolOutputChars` (4000 in all four arms) still registers the path and
  unlocks the whole file for `edit_file`, truncated part included. This is a limit of what the guard
  checks, not a bug: it verifies the call was made, not the length of what came back.
- `serve` copies `harnesses/` into the working directory only when it is not already there, so an
  existing working directory does not grow the new arms by itself. Copy them by hand, as with
  `mcp-*.json`.
