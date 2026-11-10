**English** · [Українська](cli.uk.md)

# CLI

The usage lines and the table of commands are in the [README](../README.md#cli).

`--help` lists the commands, `<command> --help` (or `help <command>`) the options of one, and
`--version` prints the installed version.

**Exit codes.** 0 for help. `run` exits 0 when the model ended with a final answer (with
`--answer-schema`, one that parses as JSON) and 1 when it did not; `demo` and `bench` exit 0
whatever the verdicts, except that `bench` exits 1 when the model changed the `node_modules` its runs were linked to (see Your own tasks); `demo` exits 1 when the server is not up or lacks the model, or when a harness needs something the model lacks (a knob it refuses), with a hint.
2 for an argument a command cannot take (the message names it and the usage follows), for a file it cannot read, for a key variable that is not set, is empty or holds what a
key cannot (see [Cloud](configuration.md#cloud)), and for the refusal below. 130 for Ctrl-C in `run`, `demo` and
`bench` and `evolve`, which keeps the trace. `proxy` exits 0 when stopped. `evolve` exits 0 with a report, 1 for the `node_modules` change above or a stop under [evolve](#evolve) (a key refused, no credits, a 429 that lasts), 2 for its refusals and 130 for Ctrl-C. `bench` and `evolve` exit 2, with no JSON, when the server does not answer or lacks the model (see Preflight).

**Approvals.** `run` without `--yes` asks before each command it may run. When stdin is not a
terminal — a pipe, `/dev/null`, CI — nobody can answer, so a harness that may ask (`approveBash`
with `bash` on, `loop.untilBash`, `hooks.userPrompt`, any `mcpServers`) is refused before the first request, and
`yes | run …` does not answer for you: pass `--yes`. `demo` and `bench` never ask: they approve the
model's commands and the harness files' `mcpServers`, `loop.untilBash` and `hooks.userPrompt` alike, and say so on
stderr. `bench --tasks` and `evolve` ask once, before the first run, to accept the commands of your
`lhb-tasks.json` (`--yes` accepts without a terminal and prints the commands first, then saves the
consent); after that they approve everything, like `demo`.

## run

`--json` writes the event stream as JSONL to stdout; human-readable progress goes to stderr.
`--answer-schema` is described under [Harness file](configuration.md#harness-file).

## bench

`bench` runs a task (`slug`, the demo's, by default) `--n` times per harness, round-robin, with a
per-run `--timeout` in seconds. With no files it takes `bare`, `tuned-nothink` and `tuned-hermes`
(`tuned` instead of `tuned-nothink` on a hosted API, as in `demo`) from
`./harnesses` (the copies `serve` made, i.e. what you edited in the UI) or from the package. It
prints a PASS-rate table and writes a JSON to `runs/` after every run, so Ctrl-C keeps what
finished.

Next to each PASS count the table prints its 95% Wilson interval: 1/3 is 0.06–0.79 and 3/3 is
0.44–1.00, so at `--n 3` even 3/3 against 1/3 does not tell two harnesses apart. The JSON carries
each harness's full config and each run's `reason`, `parseErrors`, `toolErrors`, `lastError`, peak
tokens, temp `workdir` and `trace` (the run's `runs/<id>.jsonl`), so two files are comparable by
config, not by name.

`--wide` adds columns to the printed table (the JSON and the Bench tab always carry them). Per success: the mean turns,
tokens and model time of the passing runs, on the tasks shared with the first harness of the same model when
there are at least 5; under 5, a plain mean of the harness's own passes. `$/ok` is always a plain mean of the
passes. A cost dearer than `evolve` would allow is marked `!`; `tok/ok` also takes `!` on any number of tasks
past evolve's all-tokens gate (below). Nothing is refused.
Then, per run: the calls of each tool (built-in and mcp), the lines of tool output the model saw, and the
reasoning tokens the server reported. Means, not medians. `-` means the run did not report it, and is left out of
the mean; a reported 0 counts as 0.

Under `--wide` (and always on the Bench tab) every harness but the first on its model also gets a p-value per number
(PASS, turns, seconds, tokens, total calls, output lines, reasoning tokens): a two-sided permutation test of the
mean against that first harness, with the runs shuffled only inside their task, and the number of permutations
next to it (up to 20,000 all of them, so the p is exact; past that, 20,000 random ones with a fixed seed). It is
computed from the JSON when the table is printed, so an old file has it too. With many columns and harnesses, some
p < 0.05 come out by chance; nothing is corrected for it.

`--models a,b` runs every harness on every model into one JSON and one table, rows named `harness · model`; it
replaces `--model`, and the p of each row is against the first harness on the same model. "Run bench again"
on the Bench tab keeps each config's model, so it repeats the same grid.

**Preflight.** Before the first run `bench` asks each server what it can without generating. A
server that does not answer, or lacks the model, stops the bench with exit code 2 and no JSON. The
model name is checked only where the server serves by it: Ollama (`qwen3` means `qwen3:latest`) and
a llama-server router. A one-model llama-server answers to any name. On llama-server the window and
build come from `/props`; a router reports them per model at `/props?model=`, which loads that model
if it is not loaded yet. On Ollama the window is the harness's `numCtx`. Both go into the JSON as
each harness's `server`, and a `budgetTokens` that with `maxTokens` on top is over the window gets a
warning — the budget cannot keep such a run inside it. LM Studio and vLLM have no `/props`: window
unknown, no warning. With a key the model is checked against the hosted API's list, unless that
list says it is incomplete, and the window comes from that list — see [Cloud](configuration.md#cloud).

**Tasks.** `--task` picks another task, and every task but `slug` needs a `--size`.

| task | sizes | what it is |
|---|---|---|
| `slug` | — | the demo: find a bug report in a long log, fix `src/slugify.js`, make `node --test` pass |
| `pool`, `pool2` | 1–10 | ten small buggy units, more of them with each size; see [The pool task](findings.md#the-pool-task) |
| `pool3` | 1–10 | `pool2` with its two oracle holes closed (below); nothing measured on it yet |
| `sift` | 1–12 | split a screener's verdicts into two files, checked character by character |
| `triage` | 1–12 | write KEEP or DROP for each new post into a file; the fixture carries the key |
| `judge` | 1–12 | the same judgement as one request: posts in the task text, verdicts as the final answer |
| `polyglot` | 1–47 | the first N of 47 Exercism JavaScript exercises, each checked by its own tests |

`pool3` has the same order and buggy sources as `pool2`, and tests of its own for `parseDuration`
(minutes alone and next to the other units, so a fix that special-cases the old test's literal
fails) and `median` (the input array must come back as it was, so a sort in place fails). At
`--size 7` the two differ in `parseDuration` only; `median` is the eighth unit. Its rows do not
compare with `pool2`'s. `sift`, `triage` and `judge` are steps of a news curator on synthetic
fixtures (`examples-sift`, `examples-triage`). How they were measured and what they showed:
[docs/curator.md](curator.md).

**Polyglot.** Each exercise is one run: the model gets the exercise's `INSTRUCTIONS.md` and stub,
and the check runs the exercise's tests in a fresh directory. An exercise is PASS when all its tests
are green; the table adds a `tests` column (green / total, summed over runs) with no interval, since
the tests of one exercise are not independent. The set is `examples-polyglot/` (47 exercises, the
names from Aider's polyglot benchmark minus `grep` and `ledger`); sources, licenses and attribution:
`examples-polyglot/NOTICE.md`.

```bash
llm-harness-builder bench base.json yours.json --task polyglot --size 5 --n 1    # a rough estimate
llm-harness-builder bench base.json yours.json --task polyglot --size 47          # the full set, may take a night
```

Limits. A crashed run does not resume. With `--n` above 1 every run counts, so the interval is a
little optimistic. Each exercise's check has its own fixed 60 s limit, separate from `--timeout`. The
model has network, and Exercism's solutions are public. The shell is not isolated, so determined
cheating is not ruled out: a solution can rewrite the test file while it runs, or otherwise forge the
test runner, and a model that does so on purpose can PASS. There are no hidden rules; the check runs
what the model ran, and while it runs the model's workdir has `npm test`. The bench header counts the real runs per harness
(size × `--n`). The numbers do not compare
with Aider's leaderboard (there: two attempts, the second with the test output; here: one agent run).

**Your own tasks.** `bench --tasks <repo>` runs your tasks instead of a built-in one, from a
`lhb-tasks.json` at the top of a git repo:

```json
{ "tasks": [
    { "name": "limit", "prompt": "Add a limit option to paginate() so test/paginate.test.js passes", "check": "npm test -- paginate" },
    { "name": "dates", "prompt": "Fix parseDate for ISO weeks", "check": "npm test -- dates", "checkTimeoutS": 120 } ],
  "setup": "npm ci" }
```

```bash
llm-harness-builder bench --tasks ../myrepo --n 3
llm-harness-builder bench --tasks ../myrepo --only a2   # just these tasks, by name; the JSON records "only"
```

A task can be a question. Its `check` reads the run's final answer from the file `$LHB_FINAL_FILE`:

```json
{ "name": "where", "prompt": "Which file parses ISO weeks? Answer with the path.",
  "check": "test -s \"$LHB_FINAL_FILE\" && grep -q 'src/dates.js' \"$LHB_FINAL_FILE\"" }
```

The file is in a temp directory outside the clone, so `git status` does not see it, and it is removed
after the check. It exists for every check and is empty when the run ended with no final answer, so
test `-s` first: `! grep -q wrong "$LHB_FINAL_FILE"` passes an empty file. This is not a boundary: the
check runs code the run could have changed, and that code can read the file, as can anything else running as you.
So read the file in the check before it runs repo code.

Only the last commit is read: uncommitted changes, `lhb-tasks.json` included, are not in the runs,
and `bench` says so. Each run is a `git clone --shared` in the OS temp dir, at that commit, with no
remote, deleted after its check; the harness reads what a run changed through a git dir of its own,
so whatever the model writes into the clone's `.git` does not reach your repo or the verdict. Tests,
manifests, lock files, test-runner configs (`vite.config.*` too), `.npmrc` and `.gitignore` files are
protected (add your own paths with `protect`), and so is the `node_modules` the run was given: a run
that adds, changes or deletes one is a FAIL, and its check does not run. A `.gitignore` or `.npmrc` the run
adds counts even when a rule ignores it, save the `.gitignore` a tool cache writes into a new folder of its
own: `.pytest_cache`, `.mypy_cache`, `.ruff_cache`, or a venv under a dot name (`.venv` with its
`pyvenv.cfg`). A `node --test` check
that finds 0 tests is a FAIL too. Before the first run `bench` shows every command it will run and
where, and the prompt and check JSON-escaped, so a control character shows up as text, and asks
once; `--yes` accepts without a terminal and prints the same commands before it saves the consent, and a change to a command or to the scripts of
`package.json` asks again. `setup` runs once in a clone of its own, and the runs link its
`node_modules` (without `setup`, your repo's): a run that changes its `.bin`, a package's
`package.json` or a package's top-level code stops the bench after the JSON is written; files deeper
in a package are not watched. What each run changed is kept as `runs/<trace>.patch` (files that look like secrets left
out, at most 1 MiB).

A clone is a full checkout of the commit, which is slow on a big monorepo, and its submodules are
not initialised. `setup` runs with the env names the harnesses pass in `tools.bashEnv`, and what it leaves in the
background is killed when it ends, so start a service the tests need outside `bench`. A server
that is down is reported after the consent question and before `setup`. Traces and patches go to
`./runs` of the folder you run `bench` from: run it from outside the repo, as above (with no harness
files it takes the default ones), since from the repo itself (`bench --tasks .`) that leaves it with
uncommitted files; or add `runs/` to `.gitignore`.

## evolve

`evolve` improves a harness on your own tasks. It reads the same `lhb-tasks.json` as `bench --tasks`
(the last commit; a task's optional `"set": "train" | "gate" | "test"` picks its set, the rest are
split by a hash of the name), asks a proposer model for one edit at a time to one allowed field
(`systemPrompt`, `loop.*`, `context.*`), runs it on train and gate, and keeps it only if it wins on
tasks the proposer never saw; the last kept version is then measured against the original on test.
The harness file you give is never written.

```bash
llm-harness-builder evolve harnesses/tuned-nothink.json --tasks ../myrepo --mode night
```

`--mode` has no default: a default would silently buy a night of runs.

| Mode | Repeats, rounds | What it promises | `--task polyglot` |
|---|---|---|---|
| `hours` | 1, 1 | orientation, never a winner | 24 exercises, up to 72 runs |
| `night` | 3, 1 | a large gain only | 47 exercises, up to 394 runs, about 11–13 h on the model measured below |
| `days` | 5, 2 | a gain from +5 tasks of 32 | 47 exercises, up to 1126 runs |

Only `night` and `days` declare a winner, and only with at least 16 train + gate and 8 test tasks; any
other result is labelled "orientation, not proof" and says why. On `--tasks` the repo sets the task
count and the mode sets repeats and rounds. evolve prints the mode's run count at the start. After the
first step it prints the time for the rest at that pace, the money when the harness has a price, and
the smallest gain the mode can tell from noise on this model (`at most` at one repeat: one repeat
gives no within-task variance, so it is an upper bound). These are upper counts: the test runs only if a version is found. The mode, its repeats and
its rounds are pinned: another mode or `--rounds` refuses a resume, and `--report` reads them from the
journal.

A change is a *candidate* when, on train + gate, PASS rises past noise (a one-sided permutation test inside
each task, p < 0.05 with at least 5 tasks better; outside a declaring run, simply more PASS than the current
version), it is no worse on gate, and no cost passes its tolerance. Of two in a round the one with more PASS
stays, then the one with the lower tokens per success × model time, then the first. The *winner* is the last
candidate when it also has p < 0.05, with the same flips and costs, against the original on the test tasks,
in `night` or `days`. The report says `Use` for a winner, `Try` for a better result that only orients, and
keeps the original otherwise; a candidate that did not win stays on disk, for reference.

The tolerances, none of them a flag. Turns: +20% up to 10 turns (at least +1), +10% beyond (at least +2).
Tokens: +10%. Both count against the original, on tasks both versions pass and on the candidate's runs within
the original's `loop.maxTurns`. Model time: +10% against the current version, in the same sweeps. A cost is
over when the geometric mean of the per-task ratios passes its tolerance and a sign test gives p < 0.10.
Under 5 such shared tasks, or at 0 PASS in the original, none of these three applies. The all-tokens gate
always does, so failures are not free: +10% on tokens per success over all runs, or on all tokens at 0 PASS.
The first request may be up to +25% heavier.

Two refused candidates in a row on one field close it until a candidate is accepted: the proposer is told,
and a second reply on that field is refused with no runs (`field exhausted`). With every field closed, the
rounds end and the report says so.

Every new journal is an attempt, counted in the state directory per harness (its parsed JSON, not its
whitespace), task definitions and mode; a commit that leaves the tasks alone does not reset it. The report
prints `attempt N`, so restarting until something wins shows. It prints `test sweeps started: N of R` when
that count differs from the mode's repeats: a test was cut and rolled again. Neither number decides anything.

It writes to `./harnesses`: `<name>.evolve.jsonl` (the journal), `<name>.evolve.notes.jsonl` (a frozen
copy of the repo's notes, so every version reads the same) and `<name>.v1.json`, `v2.json`… for each
kept version. All three are private to the run: add them to your `.gitignore` (this package's own
already does, and does not pack them). Runs and traces go to `./runs` as in `bench` (`runs/evolve-<name>.json`). The proposer is told the
harness's own current values (the system prompt, scrubbed, and the numbers), the edits already refused
(values cut to 200 characters) and, for failed runs, fixed words and counts: how each ended, which tool
names it called, which file types it edited (from a fixed list of extensions). Never repo files,
paths or task names. `--proposer` picks another harness
for the proposing backend.

No repo of your own? `--task polyglot` practises evolve on the Exercism set: exercise `i` goes to train,
gate or test by `i % 3`. `--rounds N`, and on polyglot `--size N` (3 to 47, not with `--tasks`), replace
`--mode` for a quick look of your own: one repeat, always orientation. `--size 6 --rounds 1` is the
quickest.
The proposer never gets exercise names, test names or paths. The journal is bound to the loaded set and
the size: a changed set refuses a resume, `--report` still prints. The proposer is asked about only when
its host differs from the harness's (`--yes` accepts); the same host gets a notice line.

A harness with `backend.pricePerMTok` needs `--max-usd <dollars>`; without a price the flag is refused
(`no price to count against`). Before each run and each proposal evolve adds up what the journal holds
and stops with exit 1 once that reaches the limit; the same command with a higher limit continues. The
money of a sweep or a proposal that a stop cuts stays in the journal in a `cut` line and counts, whether the
stop was Ctrl-C, SIGTERM, SIGHUP, the limit, a refused key or a changed `node_modules`. The run in flight at
a signal is not in it (its cost is known only when it ends), and a `kill -9` writes no line, so it leaves out
the money of the sweep or proposal it cut. A proposer with no price of its own is not counted (evolve says so at the start). `--report`
needs no flag and prints what the journal says was spent.

A 429 is retried up to 3 times (the `Retry-After` wait, at most 300 s, else 60 s); a 429 after part of
the reply has streamed is not retried and stops at once. A 401, a 402, a 403 without
moderation reasons and a 429 that lasts stop evolve with exit 1 and none of the cut step's runs in the
journal; the same command resumes. A cut sweep is measured again on resume, up to its runs: train + gate
times the current version and the candidates in a round, the test tasks times two in the final test. The proposal is journaled before its runs, so a resume measures the same
edit. `bench` records `stop` in its JSON and skips that run's check. A new key under the same variable
resumes an evolve; a different variable (`--api-key-env`) is refused as "the harness or its options
changed". Give the harness enough `backend.maxTokens`: the proposer inherits it when there is no
`--proposer`, and a proposal cut there is refused as `reply cut at maxTokens`.

The journal is checked, not trusted. Every start and every resume replays it and re-checks each
decision against its own numbers; a journal edited by hand, a changed harness or option, a new commit
in the repo or a changed notes snapshot is refused, and the message says how to start over: delete
the journal and move away `harnesses/<name>.v*.json`; for a finished evolve whose journal is intact it
points at `--report` and says to move the journal away, not to delete it. On a repo with no `setup` the
start line also holds a hash of `node_modules`, timestamps included: other packages refuse a resume, a
reinstall of the same ones too, and the way on is to start over. A repo with `setup` installs anew and
resumes. A resumed evolve continues at the step it stopped on. `--report` prints the report of a finished evolve from the journal alone, with no run and no API key
(the mode, the size and the rounds come from the journal; give only the backend overrides, `--proposer` and `--timeout` the run had): it reads the tasks at the commit the journal started at, so it prints
even after new commits or a deleted notes snapshot, and it says when `vN.json` on disk differs from
the version that was measured. To use `vN`, point at it; copying it over the original file changes
the harness the journal was pinned to, and a later `--report` refuses.

Exit codes: 0 with a report; 1 when the model changed the linked `node_modules` or a stop above ended it; 2 for a refusal, a
bad argument, or a server that does not answer or lacks the model (that one costs no attempt and leaves no journal); 130 for Ctrl-C, after which the journal holds every finished step.

Measured on 28–29 October 2026 (`qwen/qwen3-coder-30b-a3b-instruct` on OpenRouter, `tuned-qwen-coder`,
`--task polyglot --size 47 --rounds 3`, one repeat, its verdicts under the strict gate of that time, not `night`, about 8.5 hours of runs; $0.14 measured for two steps of
32 runs, so about $0.65 for all nine):

| Step | Edit | PASS of 32 (train + gate) | Verdict |
|---|---|---|---|
| original, round 1 | | 15 | |
| candidate 1.1 | `loop.maxRepeats` 6 | 10 | within noise (p=1.00) |
| candidate 1.2 | `loop.maxRepeats` 4 | 13 | within noise (p=0.86) |
| original, round 2 | | 8 | |
| candidate 2.1 | `loop.maxRepeats` 8 | 12 | within noise (p=0.06) |
| candidate 2.2 | `loop.maxRepeats` 10 | 14 | costs 13% more tokens per success |
| original, round 3 | | 11 | |
| candidate 3.1 | `loop.maxRepeats` 5 | 12 | within noise (p=0.50) |
| candidate 3.2 | `loop.maxRepeats` 3 | 12 | within noise (p=0.50) |

No version beat the original, so the 15 test tasks were not run. No gain is this model on this task,
not a property of evolve. The unchanged harness alone scored 15, 8 and 11 of 32, so a gain of a few
tasks is noise here, which is what the strict threshold is for. The proposer edited only
`loop.maxRepeats`, all six times. `loop.maxTurns` (15) ended 5 of the 16 gate tasks; evolve may raise it
up to twice the original (30), and a 31.10 spike found 15 → 30 gave no gain beyond noise and ×3.4 tokens, on this model
and these tasks only. In an earlier, shorter run, `--size 6 --rounds 1` took about
20 minutes and about $0.04.

### Evolve tab

The **Evolve** tab runs the same evolve as the CLI on a
saved harness and a repo, one job at a time together with a bench started from the page.
**Stop — resume later** stops it the way Ctrl-C does; the next Start with the same harness, repo and mode
resumes. When the report says `Use`, **Use vN** shows what `vN` changes in plain words, field by field,
with lines that look like an address or a command and fields outside what evolve may change flagged;
a report that says `Try` gets the same view as **Review vN**, and one that keeps the original gets neither.
Nothing reaches the form before **Load vN into the form**. The repo's notes can be deleted there,
one or all. Polyglot and `--proposer` stay in the CLI. Evolve runs the model's shell commands for
hours without asking, as you. It notices changes to `node_modules` and stops, but it does not
isolate them. Start runs `git status` in the folder you name; open only repos you trust.

## replay

`replay` takes the request a recorded run sent at turn N (`runs/<id>.jsonl` keeps every one) and
sends it again, as it was sent, `--n` times; `--temperature` and `--max-tokens` are the only things
it can change. It prints how many distinct replies came back and which of them is the recorded one.
Replies are compared by content and native tool calls, not by thinking text or call ids. No tool
runs, so a replay says where the next call goes on that turn and nothing about how a run would end.

The trace does not record where the run was sent, hence `--base-url` and `--kind`, and
`--api-key-env` for a hosted API, which gets the recorded request as it was recorded: a run with a
key recorded only OpenAI fields, while a local trace sent there keeps its model name and any
`chat_template_kwargs`. The server has to have the window the run had; one that is too small
refuses the request.

<details>
<summary>Which checks in the findings this command repeats</summary>

Of the checks the findings call replays, the command repeats the ones that sent a recorded request
unchanged: the `pool2` loop turn and the harmless turn under `repeatTemperature`
(`replay 153d3718 --turn 8 --temperature 1 --n 10`, and `411812a4 --turn 6` likewise). It does not
repeat the ones that edited the recorded history first (the stub text, the notes of a counter the
run did not have), and the "replayed against 5120" passages are arithmetic over traces, with no
model in them. The traces named here are not in the repository; the command is for yours.

</details>

## analyze

`analyze` reads traces and prints, per run, what the model never saw again: the turn the budget
first stubbed and which tool results that stub removed, the turn of the first successful edit, the
file with the most failed edits (with the errors by kind), and the first time the model read a file
again after its earlier read was stubbed. A trace records each request as sent, not what a stub
removed, so the stubs are rebuilt by comparing consecutive requests; a stub that cannot be tied to
results is printed as `unmatched`, never guessed. It takes bench JSONs, run ids and trace paths,
`.jsonl.part` included; `--json` prints the whole analysis. The Bench tab shows the same cells under
each run, and a trace shows them above its first turn, with `[stubbed at tN]` on each removed
result.
