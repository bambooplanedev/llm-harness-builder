**English** · [Українська](honest-notes.uk.md)

# Honest notes

Limits of [llm-harness-builder](../README.md) and of what its [findings](findings.md) say.

- Five runs per harness is a small sample. By Fisher's exact test only 5-against-1 or 4-against-0
  reaches p < 0.05: 4/5 against 2/5 is p = 0.52, and the `tuned` 4/5 against `bare` 1/5 under
  [Bench results](findings.md#bench-results) is
  p = 0.21 — suggestive, not proof. `toolChars` is measured rather than sampled — it is the same in
  every run — which is why the MCP pair reports it. The tool-error count is exact within a run, but
  it is what the model did, so it varies from run to run; the table shows its median.
- Traces are raw. Anything the model reads (including `.env`) ends up in `runs/` — except the
  value of the backend key (`backend.apiKeyEnv`), which every run redacts; what that misses is three
  bullets down. `run` without `--workdir` works in the current directory, so `runs/` lands inside
  the project the agent reads; pass `--workdir`. Point `workdir` at a scratch copy or a git repo.
  `run` asks before each `bash` command when `tools.approveBash` is on (every shipped harness has it
  on), before starting each MCP server and before `loop.untilBash`, unless `--yes`; other tools and
  MCP tool calls never ask; `demo` and `bench` approve everything, the harness files' `mcpServers`
  and `loop.untilBash` included.
- A note (`notes.enabled`) is the model's own summary of a run, written from the names of its calls,
  argument keys, paths and verdicts (a name or path that is not a plain token of up to 64 characters is
  passed as `<odd>` — a plain file name can still carry words), never from file contents or tool
  output; it is scrubbed for the backend key, common secret shapes and the home path by pattern, not
  by proof. A wrong note is sent after the task of every later run on that folder until you delete
  its line in the notes file `run` names. The file is outside the project, but `bash` runs as you
  and can write it like any other file. `bench` reads notes and never writes them, so its runs stay independent:
  measure notes as off against a fixed file, not as a bench that keeps writing.
- `bench --tasks` runs in clones, and a clone keeps git operations and the file tools off your repo,
  not `bash`: the model's commands still run as you, without asking, for the whole bench. The
  `node_modules` link is watched, not protected — a change to its `.bin`, a `package.json` or a
  package's top-level code stops the bench after the fact, and deeper files are not watched.
- In `bench`, a run's processes are killed when the run ends, before its check; one that left its
  session (`setsid`) is not.
- The environment of what the model runs — `bash`, `loop.untilBash`, and the task checks, which
  execute the model's code — is `PATH`, `HOME`, `LANG`, `LC_ALL`, `LC_CTYPE`, `LC_COLLATE`,
  `LC_MESSAGES`, `LC_MONETARY`, `LC_NUMERIC`, `LC_TIME`, `TERM`, `TMPDIR` and the names in
  `tools.bashEnv`. That keeps keys out of what a command prints by accident and out of tools that
  read `*_API_KEY` by themselves. It is not a boundary: a command runs as you and can read this
  process's environment (`ps -E` on macOS, `/proc/<pid>/environ` on Linux) and any of your files.
  With `backend.apiKeyEnv` the key is in this process's environment as well: a command can read it
  there, or from the file you keep it in, and send it anywhere. Only approving each command
  (`tools.approveBash`) or a container stops that, and `demo` and `bench` approve everything.
- MCP servers start with the whole environment of this process, except the variable
  `backend.apiKeyEnv` names; `mcpServers` has no `env`.
- The backend key is redacted by value: tool output, `loop.untilBash` output and every event carry
  `[redacted: <NAME>]` instead, before the history, the trace, the terminal or the UI see them. It
  is not found encoded (base64, split in parts), when the value is shorter than 20 characters
  (`run`, `demo`, `bench` and `replay` say so on stderr; the UI does not), or in the live text of a
  turn on the terminal and in the UI, where it can arrive split between chunks — the model never
  sees the key while all its inputs are clean, and the live text is not saved. A file the model
  rewrites from what it read gets the mark instead of the key. The rest of `.env` and the values of
  `tools.bashEnv` stay as they are. `replay` prints the server's replies as they come, the model
  list in the UI shows the ids as the server sent them, and the approval question in the terminal
  shows a command as the model wrote it.
- OpenRouter's error bodies — a 429, for one — can carry the account's user id, and a trace
  keeps an error body as it came (redaction looks only for the key).
- A harness file from someone else is code. It decides where requests go and, with `apiKeyEnv`,
  which of your `*_API_KEY` variables goes along; the start line (`the key in … goes to …`)
  names the host. The key normally leaves with the first request, so it has gone by the time you
  read the line (with `bench`, with its preflight); in `run` without `--yes` a question about an
  MCP server or `loop.untilBash` can come first. In the UI, opening a keyed harness or a bench run
  sends nothing until you press ↻ or Run.
- `serve` listens on 127.0.0.1 and refuses other hosts and any page from another origin, other ports
  of localhost included, but trusts every local process: whatever can connect to its port can start
  runs, answer approvals and, with `apiKeyEnv`, make it send one of its `*_API_KEY` variables to a
  host it names. The recording proxy refuses other hosts and pages from another origin the same way.
- `run` without `--yes` refuses to start when stdin is not a terminal and the harness may ask
  (`approveBash` with `bash` on, `loop.untilBash`, `mcpServers`): nobody could answer.
- A CLI run writes `runs/<id>.jsonl.part` and renames it when done, on Ctrl-C included (at the
  approval question too, where Ctrl-D does the same). Any other kill leaves one behind — SIGTERM
  (exit 143), SIGHUP (a closed terminal; 129 in a shell), SIGKILL — and so does Ctrl-C during
  `bench`, where the Bench page still reads the `.part`. Rename it to `.jsonl` to open it in the UI.
- `enforceSchema` is not a guarantee: llama.cpp's grammar can fail open in some cases, and whether
  it holds in thinking mode can depend on the build and the chat template. The parser is lenient
  regardless. In [Isolating the knobs](findings.md#isolating-the-knobs-two-more-runs),
  `enforceSchema` did nothing at all until thinking was off — the model kept spending its whole
  budget inside `<think>` and never reached the JSON. On llama-server b10826 thinking and the
  grammar coexisted and the content still parsed
  ([a replay](findings.md#a-fourth-thinking-on-the-turn-after-a-repeat-2026-09-20)).
- Streaming is always on. The raw response in the inspector is assembled from the stream (the last
  chunk plus the collected message), not the chunk log. `<think>` shows as a separate grey block
  only when the server separates it (llama-server `--jinja` with a reasoning format, Ollama
  `thinking`); otherwise the tags arrive inside the text. Known failure path: llama-server builds
  before May 2025 answer 400 to `tools` together with `stream`; a buffering proxy delays the live
  text but the run still completes.
- Token counts are exact on llama-server (`/apply-template` + `/tokenize`: chat template and
  `tools[]` included) and a `chars / 4` estimate of the messages elsewhere; the budget trims by
  the estimate in both cases; the backend's `usage` is shown after each response. With a key (a
  hosted API) they are always the estimate, next to the `usage` each reply reports.
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
  than having its thoughts accepted as the answer. If the cut-off text is in `content` and longer
  than the marker, the marker goes back instead of it (see the correction under
  [MCP](../README.md#mcp)).
- That does not make a truncation recoverable in general. When the window was already full before
  the response — the `backend_error×1` of `rule-none` is one: a 207-character reply to an 8123-token
  prompt — the retry is still a 400. So are the two `backend_error` of `tuned` under [Explaining an
  edit miss](findings.md#explaining-an-edit-miss): no truncation there, the history simply outgrew
  the window with `budgetTokens` at 0. All of this is llama-server behaviour; Ollama shifts the
  context instead of answering 400, and nothing here was measured on it.
- `backend.maxTokens` caps what one response may generate (`max_tokens` / `num_predict`), thinking
  included. Every shipped harness carries 1024 since 2026-09-19, except `bare` (no cap) and
  `curator` and `curator-judge` (4096). On the old task and in the MCP pair the `/no_think`
  harnesses never needed more than 162 tokens for a response, and that does not carry over: a
  healthy batch of edits on `pool` is 486 tokens at size 7 and up to 598 at size 8 (local traces,
  not in the repository), and on Bonsai 2, which ran `pool2` and not `pool`, it is 933 to 1004, so
  close to the cap that in 2 of 9 runs the first try was cut off at 1024. `bare` has no cap because
  it thinks: the largest finished response of each of its two recorded runs was 592 and 1317 tokens
  (the median of all eight is 493), and another `bare` run has one of 3046. There a runaway costs
  169 to 363 s in the four recorded (the 295 s under [MCP](../README.md#mcp) is `mcp-on`'s) before
  anything can react, and a second one after the clipped retry makes a ten-minute run that ends as
  `parse_failed`, or as `aborted` if the bench timeout comes first. The Bonsai 2 and `bare` figures
  above are from those traces as well, the 295 s excepted. A cap set below what a model needs to
  think turns every response into a parse error; the run then ends as `parse_failed` after two.
- Abort cannot interrupt a `bash` command that is already running (nor the `loop.untilBash` check,
  which runs the same way); the command returns within its 30 s timeout, then the run ends. An MCP
  call in flight is interrupted: abort closes the server, and the call comes back as an error.
- `demo --kind openai` needs `--base-url` (the default URL is Ollama's port).
- The UI has no built-in workdir: run `demo` once and point the UI's workdir at the temp directory
  it prints (or at any `workdir` from a bench JSON), or at any scratch project.
- `bench` PASS means `node --test` came back green on `slug` and in the pool family (`pool`,
  `pool2`, `pool3`), and that the output agrees with the fixture's key on `sift`, `triage` and
  `judge`. It does not mean a bug was fixed the right way: on `slug` the model has `write_file` and
  could edit the test instead (the pool family restores the pristine tests from the package before
  the check, so edits to `test/` do not count, but `bash` is not sandboxed), and a fix can satisfy
  the tests while missing the report (see the note under
  [Bench results](findings.md#bench-results): 11 of 14 did). Open the run's trace (`runs[].trace` in
  the JSON, or the run list in the UI) to see what it changed.
- `explainEditMiss` compares lines with everything but letters, digits and `_` removed, so it also
  calls `a = b + c` and `a = b - c` a match "except for punctuation"; it shows the first such line,
  says nothing for a multi-line `old` or a line over 300 characters, and edits made through MCP
  tools never reach it.
- `loop.maxRepeats` sees file changes only through a tool named `edit_file` or `write_file` —
  the built-in ones, or an MCP server's tool of the same name, as in `mcp-on`. After `bash sed -i`
  or a differently named MCP tool changed a file, re-running the same test command counts as a
  repeat: it still runs, but it draws the note and moves the run towards `repeat_loop`. An edit
  that has succeeded is counted over the whole run, so a model that legitimately makes the same
  successful edit a fifth time — after four undos — is ended at `maxRepeats: 3`; no recorded run
  does that outside a loop. The note itself did not move the model out of a flip-flop in the one
  replay that tried it.
- In `pool`, "N = 7" means "these seven units", not seven equal ones: the order is fixed and the
  units differ in difficulty. The size at which a healthy run fills the window belongs to this
  machine and this Node: about 120 of each failure's 870 characters are the absolute tmp path (Node
  24.18 prints it in the stack line), and the default test reporter differs between Node majors.
  The JSON records `node`.
- `context.budgetTokens` is in `chars / 4` units. On `pool` that is 0.69–0.83 of the real count, on
  the old task 0.55–0.72; where a budget of 4691 would fire it is 0.74–0.79, so 4691 means about
  5900–6300 real tokens. `applyBudget` stubs the oldest tool results first and whole messages only —
  in a prompted harness one message is all the results of a turn — leaves `[dropped: N chars]` with
  no word of what it was (naming the call in the stub was built and measured, changed nothing in
  what this model did on `pool2` and held the history down worse: "The stub that says what it was"
  under [The measurement, on `pool2`](findings.md#the-measurement-on-pool2)), and cannot touch the
  system prompt, the task, the assistant's own messages or the newest results. Since 2026-09-19 it
  stubs down to three quarters of the budget once over it. Measured on `pool2` only, with two
  models: Qwen3-8B in [The measurement, on `pool2`](findings.md#the-measurement-on-pool2) and
  Bonsai 2 in [A second model](findings.md#a-second-model-2026-10-09).
- In `pool2`, "N = 7" means those seven units; `formatBytes` was new to the model when it was
  measured. Two oracles have holes that were left alone: `parseDuration` passes a fix that
  special-cases the test's literal (it is in published rows), and `median` passes a sort in place
  (it is outside size 7). `pool3` closes both and leaves `pool2` as it was measured.
- `bench --max-turns` overrides the harness the way `--model` does and is recorded in
  `harnesses[].config`; `demo` runs the old task only.
- `demo` and `bench` give the task's check 60 s.
- Aborting a run (`--timeout`) closes our side of the connection; llama-server keeps generating
  until it notices, so the next run can start against a busy server and fail with
  `backend_error`. The bench in [Bench results](findings.md#bench-results) has one
  such row.
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
