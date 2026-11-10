**English** · [Українська](configuration.uk.md)

# Configuration

## Harness file

A harness is one JSON file: backend, prompts, tools, limits. Start from
[`harnesses/tuned.json`](../harnesses/tuned.json):

```json
{
  "name": "tuned",
  "backend": { "kind": "ollama", "baseUrl": "http://localhost:11434", "model": "qwen3:8b", "numCtx": 8192, "maxTokens": 1024, "temperature": 0.2 },
  "systemPrompt": "…",
  "tools": { "enabled": ["list_dir", "read_file", "write_file", "edit_file", "bash"], "approveBash": true },
  "toolCalls": { "mode": "prompted", "enforceSchema": true, "promptedTemplate": "…{{tools}}…", "parseErrorHint": "…" },
  "context": { "maxToolOutputChars": 4000, "budgetTokens": 0 },
  "loop": { "maxTurns": 15 }
}
```

It is portable: no paths to your machine; `workdir` and the task are per-run parameters. A key the
format does not have is an error that names it, at the top level, in every section and in each
`mcpServers` entry and in `hooks.userPrompt`: every optional knob is off when absent, so a misspelt one would otherwise be
silently off.

| key | what it does |
|---|---|
| `backend.kind`, `baseUrl`, `model` | where requests go — see [Backends](#backends) |
| `backend.temperature` | sampling temperature |
| `backend.numCtx` | the context window, sent to Ollama only |
| `backend.maxTokens` | caps the tokens of one response, thinking included; without it a generation runs until the window is full |
| `backend.think` | the chat template's thinking switch (below) |
| `backend.apiKeyEnv` | the variable that holds a hosted API's key — see [Cloud](#cloud) |
| `backend.pricePerMTok` | prices per million tokens, for `$` per reply and per run — see [Anthropic](#anthropic) |
| `backend.reasoningEffort` | `low`, `medium` or `high`, on `kind: "openai"`: sent as `reasoning: {effort}` to openrouter.ai and as `reasoning_effort` (the OpenAI API's field) to any other server; absent sends nothing. A model whose OpenRouter `supported_parameters` lack `reasoning` gets it switched off with a `knobs_off` note; the bench JSON keeps it in the harness config |
| `description` | one line on what the harness is for; shown beside the picker, ignored by diffs |
| `systemPrompt` | the first message of every request |
| `tools.enabled` | built-in tools: `list_dir`, `read_file`, `write_file`, `edit_file`, `bash` |
| `tools.approveBash` | ask before each `bash` command |
| `tools.requireReadBeforeEdit` | refuse an edit of a file the run has not read |
| `tools.explainEditMiss` | say why an edit did not match |
| `tools.editMissEscalation` | after N failed edits of one file, tell the model to read it again (below) |
| `tools.readMaxBytes`, `bashMaxBytes`, `bashTimeoutS` | process limits; defaults 4194304, 1048576 and 30 |
| `tools.readRanges` | gives `read_file` `start` and `end` (from 1, inclusive; a final newline is not a line); a cut read names the lines shown and the next `start`; with the read guard, a file read only in part cannot be overwritten with `write_file`; off keeps the tool exactly as before |
| `tools.bashEnv` | names of environment variables `bash` gets from yours (below) |
| `toolCalls.mode` | `native` (tools in the API) or `prompted` (tools in the text) |
| `toolCalls.format` | `json` or `hermes`, in prompted mode |
| `toolCalls.enforceSchema` | hold the reply to a JSON schema on the server |
| `toolCalls.promptedTemplate`, `parseErrorHint` | the text of prompted mode and of its retry |
| `context.maxToolOutputChars` | cut each tool result to this many characters |
| `context.budgetTokens` | once over budget, stub the oldest tool results down to three quarters of it |
| `loop.maxTurns` | the run ends as `max_turns` after this many |
| `loop.maxRepeats` | a call repeated more times than this ends the run as `repeat_loop` |
| `loop.freshContext`, `repeatTemperature`, `repeatThinkTokens` | ways out of a loop — see [the findings](findings.md#three-ways-out-of-a-loop) |
| `loop.untilBash` | a final answer ends the run only once this command exits 0 |
| `mcpServers` | tools from MCP servers — see [MCP](mcp-and-hooks.md#mcp) |
| `hooks.userPrompt` | a command run before the first request; its output goes ahead of the task — see [Prompt hook](mcp-and-hooks.md#prompt-hook) |
| `notes.enabled`, `notes.maxTokens` | notes from earlier runs on the same folder, up to this many tokens, sent after the task; written after each run by a separate call; `bench` reads them and never writes |

**Context.** `context.maxToolOutputChars` and `context.budgetTokens` are optional, and so is
`context`. Absent, the harness does not limit that thing: tool output is not truncated, and no
budget stubs old results (`budgetTokens: 0` still means no budget, so older files keep working).
Present, they must be a positive integer and a non-negative integer.

**Notes.** A harness with `notes: { "enabled": true, "maxTokens": 400 }` keeps notes per folder in
`~/.local/state/llm-harness-builder/notes/<key>.jsonl` (`$XDG_STATE_HOME` if set, `LHB_NOTES_DIR`
to choose) — outside the project, so its file tools cannot write a note and nothing gets committed;
a notes dir inside the workdir is refused. `run` prints how many were sent and from which file;
delete a line, or the file, to drop a note. `$LHB_STATE_DIR` moves everything the harness keeps
(notes and consent). `bench` only reads: `task-<name>.jsonl` there, or with `--tasks` the notes of the
repo's folder; it says so when the file is empty. A note is a line of JSON, e.g.
`{"id":"n1","ts":1761000000000,"author":"user","text":"run npm test before finishing"}`;
it is read back as one line cut at 300 characters, hand-written `author: "user"` notes too, and the
secret scrub catches `key=`/`token:` style secrets in any case and `Bearer` tokens. `notes: { "enabled": false }` needs no `maxTokens`. See the [honest notes](honest-notes.md) for what a note can get wrong.

**Thinking.** `backend.think` sets `chat_template_kwargs.enable_thinking` on an OpenAI-compatible
server (llama-server reads it) and `think` on Ollama. Absent, nothing is sent and the model's own
default holds, so a harness without the key sends the request it always sent. It is for a model
that thinks unless told otherwise through the template; the `/no_think` line of the shipped
harnesses is a Qwen3 convention and another family does not read it. With `loop.repeatThinkTokens`
the thinking turn goes out with the switch on, whatever `think` says.

**Prompted mode.** With `format: "json"` the model answers with
`{"calls":[{"name":...,"args":{...}}],"final":null|"text"}`, and `enforceSchema` passes that shape
as `response_format` / `format`. With `hermes` it writes `<tool_call>{"name":…,"arguments":…}</tool_call>`
blocks, gets results in `<tool_response>`, and a plain-text reply means "done"; `enforceSchema`
applies to `json` only.

**A schema for the final answer.** In `native` mode `enforceSchema` does one other thing, and only
in a harness with no tools at all (`tools.enabled` empty, no `mcpServers`): when the task has a
schema for its final answer (the `judge` task of `bench` does), the request carries it, and the
server holds the reply to it. Such a run is one request. With any tool enabled the schema is not
sent: it is the form of the final answer, not of the turns before it. `run --answer-schema
<file.json>` gives such a schema to a task of your own. With a harness that would not send it, `run`
stops before any request and says why. The server does the enforcing, and a server may ignore the
field, so with the flag `run` exits 0 only when the final answer parses as JSON. Whether that JSON
fits the schema is left to the caller. The answer is the `text` of the `done` event in `--json`.

**Edit misses.** `tools.editMissEscalation: N` counts the failed `edit_file` calls on each file
since that file was last read or changed through a tool. From the Nth on, the error ends with
`note: miss #N on <path> — read the file again with read_file before editing it, or rewrite it with
write_file`. A `read_file` of that file, a successful edit or write of it, or a `freshContext` reset
start the count over; the read-before-edit guard's refusal is not counted, it has its own text. The
idea is Hermes Agent's (its per-file miss counter in `tools/file_operations.py`), and the reason here
is the 2026-10-10 count in [the findings](findings.md#a-second-model-2026-10-09): on `pool2` the
runs that read the looping file again passed far more often. It is built, not measured. Counted over
the recorded traces with no model, `N = 3` would have fired in 36 of the 166 runs that edited
anything — what the model would then have done, only a run can say.

**Limits.** `tools.readMaxBytes`, `tools.bashMaxBytes` and `tools.bashTimeoutS` protect the process:
how much of a file `read_file` returns, how much `bash` output is kept, and when a command is killed.
Each is a positive integer; a key left out keeps its default. A `read_file` cut at the ceiling ends
with `[truncated at N bytes]`; `loop.untilBash` uses the same `bash` limits.

**Environment.** `tools.bashEnv: ["NAME", ...]` names the environment variables that `bash`,
`loop.untilBash` and the task checks of `bench` and `demo` get from yours — names only; a harness
file never sets a value. Without it they get `PATH`, `HOME`, `LANG`, `LC_ALL`, `LC_CTYPE`,
`LC_COLLATE`, `LC_MESSAGES`, `LC_MONETARY`, `LC_NUMERIC`, `LC_TIME`, `TERM` and `TMPDIR`, and nothing
else: `TZ`, `HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS`, `CI` and every key are gone unless named. MCP
servers are not covered: they start with this process's whole environment, except the variable
`backend.apiKeyEnv` names. The prompt hook gets the same list and `CLAUDE_PROJECT_DIR`, nothing
more. `run`, `demo` and `bench` print the names on stderr when they start, and
the UI shows them under the tools. A value a command prints lands in `runs/` and in the next request
to the backend — the backend key's own value excepted, which is redacted (for the limits, see
[Cloud](#cloud)). This keeps keys out of what a command prints by accident; it is not a sandbox —
see the [honest notes](honest-notes.md).

## Backends

- `kind: "ollama"` talks to Ollama's native `/api/chat`, so `num_ctx` is honoured. Ollama's
  OpenAI-compatible `/v1` ignores `num_ctx` and silently truncates the prompt.
- `kind: "openai"` works with llama-server (`--jinja` required for native tool calls), LM Studio,
  vLLM, and anything else serving `/v1/chat/completions`. With `backend.apiKeyEnv` it talks to a
  hosted API such as OpenRouter — see [Cloud](#cloud).
- `kind: "anthropic"` talks to the Messages API — see [Anthropic](#anthropic).

**Knobs a model does not take.** Some models refuse a setting that the harness file carries. The
file keeps the value, the knob is just not sent, and `run` says so with one line per knob:
`temperature 0.2 not sent: <reason>`. For OpenRouter the list comes from the model's
`supported_parameters`, for Ollama from `/api/show`. OpenRouter's list is a union across the
providers that serve the model, so a knob missing from it is reliably unsupported, while one present
is no guarantee that the provider your request reaches takes it. In the form the knob is locked with
"this knob is not available for this model" (Ollama is asked about the model when it is committed in
the box, the others on ↻), and unlocks when you pick another model. A knob that would change the
harness itself is not dropped but refused before the first request: `toolCalls.mode: "native"` on a
model whose server says it takes no tools, and `enforceSchema` on a model that takes no response
schema (the same sources). The message names the fix: set `toolCalls.mode: "prompted"`, or
`toolCalls.enforceSchema: false`.

## Cloud

A harness talks to a hosted OpenAI-compatible API when its backend names the environment variable
that holds the key:

    "backend": { "kind": "openai", "baseUrl": "https://openrouter.ai/api/v1",
                 "apiKeyEnv": "OPENROUTER_API_KEY",
                 "model": "nvidia/nemotron-3.5-super-vl:free", "temperature": 0.2 }

The demo on the cloud, no GPU needed — a free OpenRouter account is enough: models whose id ends in
`:free` cost nothing, but OpenRouter allows them 20 requests a minute and 50 a day until you have
bought 10 credits (as of October 2026). Free models come and go, so pick another from OpenRouter's
list if this one is gone. For a paid model, use a key of its own with a credit limit, as OpenRouter
advises:

    export OPENROUTER_API_KEY=...
    npx llm-harness-builder demo --kind openai --base-url https://openrouter.ai/api/v1 \
      --api-key-env OPENROUTER_API_KEY --model nvidia/nemotron-3.5-super-vl:free

`harnesses/tuned-openrouter.json` is `tuned` on that backend; an older `harnesses/` copy made by
`serve` lacks it, so copy it by hand.

**Where the key goes.** The key itself is never in a harness file. It is read from the variable when
a command starts and sent as `Authorization: Bearer` to `baseUrl/models` and
`baseUrl/chat/completions`, nowhere else, and requests that carry it follow no redirect. The name
must be upper-case and end in `_API_KEY`, so a harness file from someone else cannot send your
`GITHUB_TOKEN` or `AWS_*` along. It can still send any of your `*_API_KEY` variables, to a host it
picks. `baseUrl` must be `https` (plain `http` only on `localhost`, `127.0.0.1` or `[::1]`). `run`,
`demo`, `bench` and `replay` say on stderr where the key goes — `the key in OPENROUTER_API_KEY goes
to openrouter.ai` — before the first request. That is a notice, not a question: the key leaves with
that request (with `bench`, with its preflight). A variable that is not set, is empty or holds what a
key cannot (spaces, control characters, non-ASCII; whitespace at the ends is trimmed first) stops the
command with exit code 2 before anything is sent.

**Redaction.** The value of the key is replaced with `[redacted: OPENROUTER_API_KEY]` in tool
output, `loop.untilBash` output and every event, before the history, the trace, the terminal or the
UI see them, and the prompt hook's context before it is cut; MCP servers start without the variable. The [honest notes](honest-notes.md)
list what that misses, among them an encoded key, one shorter than 20 characters, the live text of a
turn and a command that sends the key somewhere itself.

**What a hosted API gets.** Only what the OpenAI API defines: no `/apply-template` and `/tokenize`,
so token counts are the estimate next to the `usage` each reply reports; no `/props`; no
`chat_template_kwargs`, so `backend.think` with a key is an error — a hosted API has its own switch.
`bench`'s preflight checks the model against `baseUrl/models` (an OpenRouter routing suffix such as
`:nitro` is matched without it) and takes the window from that list: the smaller of the model's
`context_length` and its top provider's. A list whose `total_count` is above the number of models it
sent is incomplete, and the preflight does not refuse a model missing from it. OpenRouter's list is
public, so a wrong key passes the preflight and shows up as a 401 on the first request. A stream that
fails after its 200 (OpenRouter's `finish_reason: "error"`) is a `backend_error` with the provider's
message, not an empty reply; a 5xx ends the run the same way and is not retried. A 429 is retried
up to 3 times unless part of the reply has already streamed; one that lasts is a stop, and the run's
check is skipped (see evolve above).
`replay --api-key-env` sends the recorded request to a hosted API as it was recorded.

**In the UI.** `serve` reads the variable from the environment it was started in. The form takes a
loaded harness's backend only while no model is picked, so set kind, base URL, key env and model
there. With a key the form lists the models only when you press ↻, because that request sends the
key to the base URL: opening a harness or a bench run sends nothing to it. Without a key it lists
them by itself. The form picks a model from the list by itself only when there is no key and the
base URL points at this machine (`localhost`, `127.0.0.1`, `[::1]`): OpenRouter lists hundreds, at
every price, and its list is public, so it arrives before the key is typed.

## Anthropic

`kind: "anthropic"` talks to the Messages API with plain HTTP, no SDK. `baseUrl` is the server root
(`https://api.anthropic.com`; the harness adds `/v1/...` and does not read `ANTHROPIC_BASE_URL`),
and `apiKeyEnv` is required. Everything in [Cloud](#cloud) about the key holds: it goes to `baseUrl`
only, without redirects, and `run`, `demo` and `bench` say so before the first request.
`ANTHROPIC_API_KEY` is often exported globally, and someone else's harness may name it: read the
host in that notice. A harness whose backend is not Anthropic still starts its MCP servers with
`ANTHROPIC_*` in their environment.

    export ANTHROPIC_API_KEY=...
    npx llm-harness-builder bench harnesses/native-anthropic.json harnesses/budget-anthropic.json --n 1

`harnesses/native-anthropic.json` is `bare` on Claude Haiku 5.5 with thinking off;
`harnesses/budget-anthropic.json` leaves `think` out (adaptive thinking) and adds
`context.budgetTokens: 2670` and `loop.maxRepeats: 3`, so the stubs of `applyBudget` meet thinking
blocks. Like the other examples, `serve` does not copy them into an older `harnesses/`. The request
carries `anthropic-version: 2026-10-21`; `maxTokens` falls back to the model's own `max_tokens` from
`GET /v1/models/{id}`, and the run asks you to set it if the server does not name one. On this API
version `temperature` is never sent: it is a 400 on every model. Prompted mode with `enforceSchema`
is refused here, and `replay` of an Anthropic request says "not yet".

**Thinking.** Without `think`, or with `think: true`, the request asks for adaptive thinking with a
summary, and sets `block_binding.prefix_mismatch_behavior` to `drop_block` (beta
`thinking-binding-controls-2026-08-01`). The stubs of `applyBudget` rewrite old tool results, and on
accounts created on 31 August 2026 or later a thinking block that no longer matches its prefix is a
400. With `drop_block` the API drops the first mismatched block and the ones after it. The setting
also switches that check on for older accounts, which would otherwise pass the blocks through: there
they are dropped too, so a trace means the same on either. `think: false` sends
`thinking: {type: "disabled"}`, with no `block_binding` and no beta header. A model that cannot turn
thinking off (Opus 5.5, Sonnet 5.5) answers 400, and the trace shows a backend error.

**Cache.** The request always carries a top-level `cache_control: {type: "ephemeral"}`. On Haiku 5.5
the prefix must be at least 512 tokens to be cached.

**What a run costs.** Put prices in the harness, per million tokens:

    "pricePerMTok": { "input": 0.1, "output": 0.5, "cacheRead": 0.01, "cacheWrite": 0.125 }

With it the UI shows `$` on every reply, the CLI done line ends with `· $X total`, and `bench`
reports `med $`. Without `cacheRead` and `cacheWrite`, cached tokens are priced as `input`. The tool
has no price table: those numbers were Haiku 5.5's list prices for prompts up to 100,000 tokens
(cache read 0.1 times input, 5-minute cache write 1.25 times) when the example was written, and they
go stale. A prompt over 100,000 tokens, cache hits included, is priced on a second grid ($0.50
input, $2.50 output), which a flat `pricePerMTok` cannot express: past that size the figure is too
low.

<details>
<summary>Measured on 24 October 2026</summary>

`claude-haiku-5-5`, task `slug`, one run each: this model on this task, not a property of the knob.
`native-anthropic.json`: PASS in 3 turns, about $0.0005, cache reads from the second turn on, and the
`temperature 0.2 not sent` line appeared. `budget-anthropic.json` (`budgetTokens: 2670`): PASS in 4
turns and no stub fired: the harness estimates the context as chars/4 (about 460 tokens by the last
turn), which leaves out the tool schemas, while the server counted about 2000 prompt tokens. With
`budgetTokens: 200` the stubs came from turn 3 on and there was no 400, but the server reported every
thinking block after the first stub as dropped (`input_transformations`: `thinking_dropped`,
`prefix_binding_mismatch`), so the model went on without its earlier reasoning; PASS in 14 turns,
about $0.0054.

On Ollama 0.40.10 `/api/show` gave `capabilities` `["completion", "tools", "thinking"]` for
`qwen3:0.6b` and `["completion"]` for `gemma3:270m` (so a native harness with tools is refused on the
latter), and a 404 for a model it does not have; `prompt_eval_count` on a second turn with the same
prefix was the whole prompt (1234, then 1253), so Ollama's prompt tokens read like the other
backends'. Not checked live: the form's lock for an OpenRouter model (tests only).

One run that ends in zero is "this model on this task", not a property of the knob.

</details>

## Model families

A family button in the UI (`applyFamily` in `src/core/prompts.ts`) fills the tool-call mode,
format, prompted template and parse-error hint, and swaps the trailing family line of the system
prompt; the form then says what it changed. It never touches backend, tools, context or loop
settings, and nothing about the family is stored in the harness file — only the resulting plain
fields.

| family | mode / format | prompt line | why |
|---|---|---|---|
| `qwen3` | prompted / hermes | `/no_think` | trained on `<tool_call>` XML; `/no_think` kept Qwen3-8B from burning the window in `<think>` (one run: [Isolating the knobs](findings.md#isolating-the-knobs-two-more-runs)) |
| `gemma` | prompted / json | — | no native tool calling in the chat template (Ollama rejects `tools[]`); no line to add for thinking — a Gemma that thinks by default is switched by `backend.think` (Gemma 12B on llama-server: reasoning on 0 of 36 turns of `sift` with `think: false`) |
| `llama3` | native / json | — | native tool calls work through the chat template; nothing to add |

Why a prompted hermes format when llama-server (`--jinja`) and Ollama already parse Qwen's
`<tool_call>` natively: it works without `--jinja` and on any `/v1`; a malformed block becomes a
visible `parse_error` with a hint and a retry instead of an empty `content`; and the trace shows the
exact text the model wrote. If the server does lift the blocks into `tool_calls` anyway, the run
uses them and the raw response in the trace shows that it happened.
