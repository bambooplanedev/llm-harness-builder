**English** · [Українська](mcp-and-hooks.uk.md)

# MCP and the prompt hook

## MCP

A harness can take its tools from MCP servers over stdio instead of, or beside, the built-in five:

    "tools": { "enabled": ["bash"], "approveBash": true },
    "mcpServers": {
      "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] }
    }

Each server starts with `cwd` set to the run's `workdir` — the same relative-path behaviour `bash`
already has — and every start asks for approval unless `--yes` (`demo` and `bench` never ask). Tool
names stay flat, with no server prefix; a name that collides with a built-in one ends the run before
the first request to the model. A server's `tools: [...]` is an allow-list; absent or empty means
everything the server offers.

A server may answer `initialize` with `instructions`, its own notes on how to use it. They are
dropped unless the server has `"useInstructions": true`; then they go after `systemPrompt`, under
`Instructions from MCP server "<name>":`, one block per server in the order of `mcpServers`. The
`mcp_server_start` event keeps the text, and `toolChars` counts it.

**Mind the allow-list.** The tool text is the first thing to eat the context window. Against
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
`med errs`, tool results that came back as errors. Unlike the PASS rate, `toolChars` does not
depend on the sample size: it is the same in every run. `med errs` is a median over the runs, and
the count itself varies from run to run, because it is what the model did.

Two caveats. **The arms differ in more than the size of the descriptions**: tool names and argument
shapes differ too, and MCP's `read_file` takes `head`/`tail`, which the built-in one does not — in
places MCP is the stronger arm. The pair therefore measures "MCP as a whole way of handing tools to a
model", not "the cost of tool descriptions". And **an MCP server runs outside the `workdir`
sandbox**: the built-in file tools are locked in by `resolveInside`, while a server merely receives
the directory as `cwd` and respects it out of goodwill.

<details>
<summary>Five runs per arm, 2026-09-13, and the correction of 2026-09-19</summary>

On the same setup as [Bench results](findings.md#bench-results):

| harness | PASS | how the runs ended | median turns | median s | `toolChars` | `med errs` |
|---|---|---|---|---|---|---|
| `mcp-off` — file tools from the built-ins | **5/5** | `final×5` | 5 | 31 | — | 0 |
| `mcp-on` — the same tools from the server | **3/5** | `backend_error×2 final×3` | 5 | 45 | 6439 | 0 |

Fisher's exact test puts 5-against-3 at p = 0.44, so read that PASS column as an illustration and
nothing more. The traces are worth more than the count, because both failures are identical to the
token.

Every `mcp-off` run opened with 605 tokens of context and every `mcp-on` run with 1742. The prompt
is fixed, so that 1137-token gap is the tool text, the same in all ten runs. In the two failing runs
turn 4 ran away to 5062 completion tokens and came back `finish_reason=length` — a `parse_error`,
which normally costs one retry and nothing else. The retry request carried 8229 tokens against a
`numCtx` of 8192, and llama-server answered 400.

**Correction, 2026-09-19.** This section used to conclude that the window cost surfaces one step
late: that `mcp-off` absorbs the same runaway with room to spare while `mcp-on` has no room left to
retry, so "a recoverable parse error becomes an unrecoverable 400". Both halves were wrong, and the
traces that were already on disk say so. No `mcp-off` run ran away — its largest completion in five
runs is 110 tokens — so there was nothing it absorbed. And the 1137-token gap plays no part in the
400. No output cap is sent, so a response that comes back `finish_reason=length` has filled the
window exactly (3130 + 5062 = 8192), and the retry — that history, that response and the hint — is
8192 + 37 tokens in any arm, however small its tool text. With the runaway in `content`, the retry
this harness offered could never fit on llama-server. (A runaway inside `<think>` comes back as
`reasoning`, which is never sent again, and there the retry works: that is `bare`, in the findings.)

What ran away was one string. The request carried the `enforceSchema` grammar; both failing runs
wrote the replacement as `\"\"`, lost the escaping around character 396 and closed their JSON while
the grammar still held them inside an open string, where the output is not allowed to end. They
produced `` `** `` for 295 s, until the window was full. The three passing runs wrote `''` from the
same prefix and were done in about 160 tokens. Code inside a nested JSON string — MCP's
`edits[].newText` — is a likelier trigger than the size of the descriptions; that is the first
caveat above, and it is still not shown. What stays measured: 22% of the window, 1742 against 605
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

The other half is the 295 s. `mcp-on`, like every shipped harness but `bare` and the two curator
ones (4096), now sends `"maxTokens": 1024`. The recorded turn-4 request that ran away, sent again
with that cap — six times through the shipped adapter, three as plain non-streaming requests: nine
tries, eight of them the healthy 162-token answer, and one ran away again — the same `` `** `` — and
was cut at 1024 tokens after 55 s. With the cap the retry fits even without the marker
(3130 + 1024 + 37), for as long as the prompt leaves that much room. One in nine here against two in
five in the table is not a rate either; it says the runaway is sampling, not something in those two
prompts.

</details>

## Prompt hook

A harness can run one command before the first request and put what it prints ahead of the task:

    "hooks": { "userPrompt": { "command": "wiki", "args": ["hint", "--claude-hook"] } }

It follows Claude Code's `UserPromptSubmit` hook. `command` is a name on `PATH` or an absolute path;
a relative path with a `/` is refused by the config check, since it would run a file the project or
the model controls, under an approval that shows only its name. `args` is a list of strings.

The command is spawned directly, with no shell, in the run's `workdir`. Its stdin is one JSON object:

    { "hook_event_name": "UserPromptSubmit", "prompt": "<the task>", "cwd": "<workdir>", "session_id": "<uuid>" }

`prompt` is the task as given, before notes and not redacted; `session_id` is new for each run. Its
environment is the short list under [Environment](configuration.md#harness-file) (`PATH`, `HOME`, locale, `TERM`,
`TMPDIR`) plus `CLAUDE_PROJECT_DIR`, set to the `workdir`: no key, and nothing from `tools.bashEnv`.

What it prints:

- Exit 0 and a JSON object: `hookSpecificOutput.additionalContext`, when it is a string, is the
  context. An object without it adds nothing. `"decision": "block"` blocks (below).
- Exit 0 and anything else: the trimmed stdout is the context.
- Exit 2, or exit 0 with `"decision": "block"`: the run ends as `aborted`, with the error `the prompt
  hook blocked the task` and the hook's `reason` (or its stderr) after it. The task is never sent to the backend, so a
  guard hook does not let a task go to a cloud backend. In `bench` that is a FAIL with that reason.
- Any other exit code, a spawn error, the 30 s timeout or an empty output: no context, and the run
  goes on with the task as it is. The trace says why.

The context is redacted for the backend key, then cut to 10 000 characters, with a `[truncated: N
more chars]` line after the cut. It becomes one user message, `<context>`, a blank line, the task, and
then the notes as before. A `loop.freshContext` reset sends it again without running the hook again.
Stdout is read up to 1 MB and stderr up to its last 8 KB; stderr goes into the `prompt_hook` event
and never to the model. The event comes before the first request, also when the hook blocked or was
aborted while it ran. Ctrl-C and abort kill the hook's whole process group.

The hook asks for approval once, like `loop.untilBash`: after it and before any MCP server starts.
`run` without `--yes` shows the command and the line `run before the task, with the task on stdin,
its output sent to the model`; `demo` and `bench` never ask.

**Where the hook finds its data.** A `bench --tasks` workdir is a fresh `git clone` at the pinned
commit, and `setup` runs in a separate clone, so files git ignores are not there. `.wiki/` is one:
`wiki hint --claude-hook` would print nothing in every run. Give the hook the place, for example
`"args": ["hint", "--claude-hook", "--dir", "/abs/path/.wiki"]`. Two costs. The harness file becomes
specific to your machine: do not commit it with a path from your home directory. And that `.wiki`
reflects the source repo's tree now, not the pinned commit, so a hint can be stale. The `no context`
line shows a missing wiki, not a stale one.
