# Honest notes

Limits of [llm-harness-builder](../README.md) and of what its [findings](findings.md) say.

- Five runs per harness is a small sample. By Fisher's exact test only 5-against-1 or 4-against-0
  reaches p < 0.05: 4/5 against 2/5 is p = 0.52, and the `tuned` 4/5 against `bare` 1/5 under
  [Bench results](findings.md#bench-results) is
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
  disabled in thinking mode. The parser is lenient regardless. In
  [Isolating the knobs](findings.md#isolating-the-knobs-two-more-runs), `enforceSchema`
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
  included. Every shipped harness except `bare` carries 1024 since 2026-09-19: across the recorded
  runs — one model, the tasks of this README — the `/no_think` harnesses never needed more than 162 tokens for a response. `bare` has no cap
  because it thinks — 592 tokens at the median and 1317 at most in its two recorded runs — so there a runaway still costs about
  295 s before anything can react, and a second one after the clipped retry makes a ten-minute run
  that ends as `parse_failed`, or as `aborted` if the bench timeout comes first. A cap set below
  what a model needs to think turns every response into a parse error; the run then ends as
  `parse_failed` after two.
- Abort cannot interrupt a tool that is already running; `bash` returns within its 30 s
  timeout, then the run ends.
- `demo --kind openai` needs `--base-url` (the default URL is Ollama's port).
- The UI has no built-in workdir: run `demo` once and point the UI's workdir at the temp directory it prints (or at any `workdir` from a bench JSON), or at any scratch project.
- `bench` PASS means `node --test` came back green (for `pool`: green on pristine tests the model
  cannot reach), not that the bug was fixed the right way: the model has `write_file` and could edit
  the test instead, and a fix can satisfy the tests while missing the report (see the note under
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
  machine and this Node: about 200 of each failure's 900 characters are the absolute tmp path, and
  the default test reporter differs between Node majors. The JSON records `node`.
- `context.budgetTokens` is in `chars / 4` units. On `pool` that is 0.69–0.83 of the real count, on
  the old task 0.55–0.72; where a budget of 4691 would fire it is 0.74–0.79, so 4691 means about
  5900–6300 real tokens. `applyBudget` stubs the oldest tool results first and whole messages only —
  in a prompted harness one message is all the results of a turn — leaves `[dropped: N chars]` with
  no word of what it was (naming the call in the stub was built and measured, changed nothing in
  what this model did on `pool2` and held the history down worse: "The stub that says what it was"
  under [The measurement, on `pool2`](findings.md#the-measurement-on-pool2)), and cannot touch the
  system prompt, the task, the assistant's own messages or the newest results. Since 2026-09-19 it
  stubs down to three quarters of the budget once over it. Measured once: [The measurement, on
  `pool2`](findings.md#the-measurement-on-pool2).
- In `pool2`, "N = 7" means those seven units; `formatBytes` was new to the model when it was
  measured. Two oracles have holes that were left alone: `parseDuration` passes a fix that
  special-cases the test's literal (it is in published rows), and `median` passes a sort in place
  (it is outside size 7). `pool3` closes both and leaves `pool2` as it was measured.
- `bench --max-turns` overrides the harness the way `--model` does and is recorded in
  `harnesses[].config`; `demo` runs the old task only.
- `demo` runs `check.sh` without a timeout; `bench` gives it 60 s.
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
