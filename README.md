**English** · [Українська](README.uk.md)

<div align="center">

# llm-harness-builder

**See what your agent harness really sends to the model — local or cloud — and why it fails.**

[![npm](https://img.shields.io/npm/v/llm-harness-builder?logo=npm)](https://www.npmjs.com/package/llm-harness-builder)
[![CI](https://github.com/bambooplanedev/llm-harness-builder/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/bambooplanedev/llm-harness-builder/actions/workflows/ci.yml)
[![Node](https://img.shields.io/node/v/llm-harness-builder)](https://nodejs.org)
[![License: MIT](https://img.shields.io/npm/l/llm-harness-builder)](LICENSE)

![The example bench shipped with the package, filmed with ?film=1: the PASS table, the strip of per-request columns above a trace and the anatomy line of each turn, then a Diff of a PASS run and a FAIL run](docs/demo.gif)

</div>

An agent harness is the code around a model: the system prompt, the tools it may call, and the loop that feeds
results back. This is a small workbench for the model layer of that harness: system prompt, tool description format, native
vs prompted tool calls, schema enforcement, tool-output truncation, context budget. Every run is a
JSONL trace of exactly what went to the model and what came back.

Not a coding agent for daily work. A lab for understanding why your 8B model breaks.

No model needed to look: `npx llm-harness-builder`, then **Start here** → **PASS**. A trace is one
JSON line per event; here is turn 3 of that run, abbreviated:

    {"seq":13,"turn":3,"type":"llm_request","payload":{…}}
    {"seq":14,"turn":3,"type":"llm_response","content":"{\"calls\": [{\"name\": \"read_file\", \"args\": {\"path\": \"src/slugify.js\"}}], \"final\": null}","usage":{"promptTokens":871,"completionTokens":30}}
    {"seq":15,"turn":3,"type":"tool_call","call":{"callId":"c3","name":"read_file","args":{"path":"src/slugify.js"}}}
    {"seq":16,"turn":3,"type":"tool_result","callId":"c3","name":"read_file","output":"export function slugify(s) {\n  return s.toLowerCase()…","truncated":false,"error":false}
    …
    {"seq":28,"turn":5,"type":"done","reason":"final","text":"Fixed slugify.js to strip leading and trailing dashes, and all tests passed.","turns":5,"toolCallCount":5}

and what the request of that turn was made of, as the UI prints it (prompted mode, so the tool
descriptions are part of the system prompt; each share is rounded on its own):

    system + tools 75% · history 15% · tool results 11% · 871 tok

**What it found so far** — one model and one task each, small n ([how to read](#how-to-read-the-results)):

1. **Thinking ate the reply cap.** `tuned` 0/2 (`parse_failed`); thinking off alone 0/2
   (`max_turns`, the same failing edit); `tuned-nothink` — thinking off plus `explainEditMiss` and
   `editMissEscalation: 2` — 5/5. qwen3:8b on Ollama, `slug`. ([table](#quick-start))
2. **A rule in the prompt beat the same rule in code.** "Read a file before you change it" as a
   sentence: 5/5; as a guard in code without the sentence: 0/5, the next miss repeated to
   `max_turns`. ([Read before edit](docs/findings.md#read-before-edit))
3. **Explaining an edit miss shortened the loop; the model never used the explanation.** Eleven
   identical failing calls in a row became seven; shown 16 times, used 0.
   ([Explaining an edit miss](docs/findings.md#explaining-an-edit-miss))
4. **A context budget held the window and cost passes.** `pool2` on a 5120 window: no budget died
   at 5344 tokens; `budgetTokens` 2670 stayed at or under 3364, PASS 1/3, and 0/3 with the 0.75·B
   low-water mark that ships. Qwen3-8B on llama-server.
   ([The measurement, on `pool2`](docs/findings.md#the-measurement-on-pool2))
5. **A repeat detector stops a loop; it does not fix it.** `loop.maxRepeats` ended a loop at turn
   12 in 57 s where `guard-only` ran 15 turns; on a replayed flip-flop all ten replies, with the old
   notes or the new, were the same undo. ([Noticing a repeated call](docs/findings.md#noticing-a-repeated-call))

## Contents

- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Usage](#usage) — [web UI](#web-ui) · [CLI](#cli) · [recording another agent](#recording-another-agent)
- [Configuration](#configuration) — [harness file](#harness-file) · [backends](#backends) ·
  [cloud](#cloud) · [Anthropic](#anthropic) · [model families](#model-families) · [MCP](#mcp)
- [How to read the results](#how-to-read-the-results) · [Findings](#findings)
- [Limitations](#limitations)
- [Development](#development)
- [License](#license)

## Features

- **Traces of everything.** Each request as sent and each reply as received, one JSONL file per run
  in `./runs`, from the UI and the CLI alike.
- **Workbench.** Edit a harness in a form, run it on a folder, watch the turn stream live and approve
  each command.
- **Bench.** Run several harnesses on one task many times and get PASS rates with 95% Wilson
  intervals, decided by a check script — not by eyeballing the output.
- **Diff.** Compare two runs of a bench: which config knobs differ, both paths turn by turn, and
  where they split.
- **Replay and analyze.** Send a recorded request again N times to see where the next call goes;
  read from traces what the context budget took away and when.
- **Recording proxy.** Put it between another agent (opencode, Claude Code) and its server, and its
  conversations become traces too.
- **Local and cloud.** Ollama, llama-server, LM Studio, vLLM, any OpenAI-compatible API with a key
  (OpenRouter), and the Anthropic Messages API.
- **MCP.** Tools from MCP servers over stdio, beside or instead of the five built-in ones.

## Requirements

- Node.js 22.12 or later.
- A model server: [Ollama](https://ollama.com), llama-server (`--jinja` for native tool calls),
  LM Studio, vLLM, or a hosted API key.

## Installation

Nothing to install for a try — `npx` fetches it (pin a version with `npx llm-harness-builder@0.5.0`):

    npx llm-harness-builder --help

Or install it globally:

    npm install -g llm-harness-builder

Or as a dev dependency of a project, then run it with `npx`:

    npm i -D llm-harness-builder@0.5.0
    npx llm-harness-builder

Without the npm registry, from the archive on the [GitHub release](https://github.com/bambooplanedev/llm-harness-builder/releases) page:

    npm i -g https://github.com/bambooplanedev/llm-harness-builder/releases/download/v0.5.0/llm-harness-builder-0.5.0.tgz

In a container, for the CLI only — the commands the model runs then run inside the container, not on
your machine:

    docker run --rm -it -v "$PWD":/work -w /work node:22.12-slim npx llm-harness-builder …

A model server on the host is reached at `http://host.docker.internal:11434` (on Linux add
`--add-host=host.docker.internal:host-gateway`), not 127.0.0.1. The UI is not reachable from a container: `serve` listens on 127.0.0.1. From source, see
[Development](#development).

## Quick start

    ollama pull qwen3:8b                                 # once; needs Ollama running
    npx llm-harness-builder demo --model qwen3:8b
    npx llm-harness-builder                              # opens the workbench UI

Against anything that speaks the OpenAI API (llama-server, LM Studio, vLLM):

    npx llm-harness-builder demo \
      --kind openai --base-url http://127.0.0.1:8080/v1 \
      --model unsloth/Qwen3-8B-GGUF:Q4_K_M

`demo` runs the same task once with each of three harnesses, `bare`, `tuned-nothink` and
`tuned-hermes`, on the same model, and prints PASS/FAIL from a check script. On a hosted API
(`--kind openai` with `--api-key-env`, OpenRouter for one) `tuned` takes the place of
`tuned-nothink`, because such an API refuses `backend.think`. `bench` repeats it and reports PASS
rates:

    npx llm-harness-builder bench --n 5 \
      --kind openai --base-url http://127.0.0.1:8080/v1 \
      --model unsloth/Qwen3-8B-GGUF:Q4_K_M

From zero to a first PASS:

1. Install [Ollama](https://ollama.com) and start it.
2. `ollama pull qwen3:8b`
3. `npx llm-harness-builder demo`, or open the UI and follow Start here.

Run `demo` first: it takes a few minutes and shows you the trace and that the backend is alive.
`bench --n 5` on the setup of [Bench results](docs/findings.md#bench-results) took 96 minutes, most
of it `bare`.

No GPU? See [Cloud](#cloud): a free OpenRouter account runs the demo.

Try it by hand: the [lab kit](https://github.com/bambooplanedev/llm-harness-builder/tree/main/docs/lab) has three short exercises, one of them with no model.

Why `tuned-nothink` and not `tuned`:

| harness | what differs from `tuned` | PASS | how runs ended | time per run |
|---|---|---|---|---|
| `tuned` | — (thinking on, the model's default) | 0/2 | `parse_failed` ×2: thinking eats the 1024-token cap, empty replies | — |
| `tuned` + `think: false` | thinking off | 0/2 | `max_turns` ×2: the same failing `edit_file` repeated | — |
| `tuned-nothink` | thinking off, `explainEditMiss`, `editMissEscalation: 2` | 5/5 | `final` ×5 | 5–18 s |
| `bare` | one-line prompt, native tool calls, no reply cap, no output limits | 2/4 | across three benches; two runs aborted at 1800 s after endless generation | — |

qwen3:8b on Ollama (RTX 4070 laptop), `slug` task, n = 2–5: this model on this task, small n.
`tuned` fails on a thinking model because its `maxTokens: 1024` covers the thinking too: qwen3 on
Ollama thinks unless told not to, spends the whole cap there and sends back an empty reply.

## Usage

### Web UI

    npx llm-harness-builder serve [--port 7331] [--no-open]

Running the package with no command does the same. The page has two tabs:

- **Workbench** runs one harness on a folder and shows its trace. The current turn streams live:
  `<think>` and the answer appear as they are generated, with a rough `~N tok` counter. The trace
  keeps one `llm_response` per turn; the live text is not saved. Names on the form carry hover hints, in English or
  Ukrainian: **Settings**, at the right of the tabs, picks the page's language (the browser's by
  default). Names of fields stay English, as in the harness file and the CLI.
- **Bench** shows a `bench` run, whether it is still going in another terminal or finished long ago:
  its table, the live trace of the run in flight, and **Run bench again**, which repeats it into a
  new JSON. Press `⇄` on a run to compare it with the open one — which config knobs differ, the
  per-turn path of both with the first divergence marked, and the time and tokens each turn cost.

![The Bench tab on the example bench shipped with the package: two harnesses on one task, and a passing run compared with a failing one](docs/screenshot.png)

Above every trace a strip shows one column per request, its height the prompt tokens and its
colours the layers; a click opens that turn. Each request in the trace carries the same split as a
line: system prompt, tool descriptions, history and tool results, measured in characters and
scaled to the server's `prompt_tokens`. When the server sent no usage the count is an estimate and
starts with "≈". In prompted mode the tool descriptions are part of the system text, so the two
show as one `system + tools` layer, and the results it sends back as user text still count as tool
results. Anthropic thinking blocks are counted in no layer, and the line says so.

`?film=1` (for example `http://127.0.0.1:7331/?film=1`) is for filming or showing the screen:
larger, higher-contrast type, and model names, server addresses and paths under /tmp, /Users,
/home, /var, /private replaced on display. The trace files are not changed. It is a convenience for showing a screen, **not a privacy guard**: text it does
not recognise still shows, and an approval shows its command exactly as it will run.

On a first open, with no runs yet, **Start here** in the Runs list walks through three steps: open a
recorded PASS run and a FAIL one, open the example bench, then make a run of your own. **Examples**
opens the recorded runs and bench that ship with the package: read-only, no model needed.

- **Create demo project** makes a fresh copy of the demo task in a temp folder and points the
  workdir at it; after the run, **Check** runs `node --test` on the code the model wrote and shows
  PASS or FAIL. The verdict is shown on the page only, never written to the trace.
- **Advanced** folds the rarer knobs of the form. Nothing is removed, and the fold shows how many of
  them are set. Each shipped harness carries a `description`, shown beside the picker.
- **New bench** on the Bench tab starts a bench from the page: harnesses from `./harnesses`, a task,
  `--n`, and the model of the Workbench form. **Stop bench** stops it the way Ctrl-C does: the
  finished runs stay in the JSON.

Every run, from the UI or the CLI, is kept in `./runs/*.jsonl`. Start `serve` from the same
directory to browse them, and reload the list after a CLI run. On every start `serve` adds the shipped
`harnesses/` that are missing from its working directory and never overwrites an existing file; `bench` and `demo` fall back to the package's file.

### CLI

    llm-harness-builder --help | --version | help <command>
    llm-harness-builder serve [--port <n>] [--no-open]
    llm-harness-builder run <harness.json> "task" [--workdir <dir>] [--yes] [--json] [--answer-schema <file.json>] [--model <m>] [--base-url <u>] [--kind <k>] [--api-key-env <NAME>]
    llm-harness-builder demo [--json] [--model <m>] [--base-url <u>] [--kind <k>] [--api-key-env <NAME>]
    llm-harness-builder bench [harness.json ...] [--n <n>] [--timeout <s>] [--out <file>] [--task <name>] [--size <N>] [--tasks <repo>] [--only <a,b>] [--yes] [--max-turns <N>] [--wide] [--models <a,b>] [--model <m>] [--base-url <u>] [--kind <k>] [--api-key-env <NAME>]
    llm-harness-builder evolve <harness.json> [--tasks <repo>] [--task polyglot] [--mode <m>] [--size <N>] [--rounds <N>] [--proposer <harness.json>] [--max-usd <dollars>] [--timeout <s>] [--yes] [--report] [--model <m>] [--base-url <u>] [--kind <k>] [--api-key-env <NAME>]
    llm-harness-builder replay <run-id | trace.jsonl> [--turn <N>] [--n <n>] [--temperature <t>] [--max-tokens <m>] [--base-url <u>] [--kind <k>] [--api-key-env <NAME>] [--json]
    llm-harness-builder analyze <bench.json | run-id | trace.jsonl> ... [--json]
    llm-harness-builder proxy [--upstream <url>] [--port <n>] [--name <label>]

| command | what it does |
|---|---|
| `serve` | the web UI |
| `run` | one harness, one task, one folder |
| `demo` | the demo task once per shipped harness |
| `bench` | a task `--n` times per harness, with a PASS-rate table and a JSON |
| `evolve` | improves a harness on your own tasks, one edit at a time, keeping only what wins on tasks it never saw |
| `replay` | one recorded request sent again `--n` times |
| `analyze` | what the context budget removed, and what the model did after |
| `proxy` | records another agent's conversations as traces |

`--help` lists the commands, `<command> --help` (or `help <command>`) the options of one, and
`--version` prints the installed version.

**Exit codes.** 0 for help. `run` exits 0 when the model ended with a final answer (with
`--answer-schema`, one that parses as JSON) and 1 when it did not; `demo` and `bench` exit 0
whatever the verdicts, except that `bench` exits 1 when the model changed the `node_modules` its runs were linked to (see Your own tasks); `demo` exits 1 when the server is not up or lacks the model, or when a harness needs something the model lacks (a knob it refuses), with a hint.
2 for an argument a command cannot take (the message names it and the usage follows), for a file it cannot read, for a key variable that is not set, is empty or holds what a
key cannot (see [Cloud](#cloud)), and for the refusal below. 130 for Ctrl-C in `run`, `demo` and
`bench` and `evolve`, which keeps the trace. `proxy` exits 0 when stopped. `evolve` exits 0 with a report, 1 for the `node_modules` change above or a stop under [evolve](#evolve) (a key refused, no credits, a 429 that lasts), 2 for its refusals and 130 for Ctrl-C. `bench` and `evolve` exit 2, with no JSON, when the server does not answer or lacks the model (see Preflight).

**Approvals.** `run` without `--yes` asks before each command it may run. When stdin is not a
terminal — a pipe, `/dev/null`, CI — nobody can answer, so a harness that may ask (`approveBash`
with `bash` on, `loop.untilBash`, any `mcpServers`) is refused before the first request, and
`yes | run …` does not answer for you: pass `--yes`. `demo` and `bench` never ask: they approve the
model's commands and the harness files' `mcpServers` and `loop.untilBash` alike, and say so on
stderr. `bench --tasks` and `evolve` ask once, before the first run, to accept the commands of your
`lhb-tasks.json` (`--yes` accepts without a terminal and prints the commands first, then saves the
consent); after that they approve everything, like `demo`.

#### run

`--json` writes the event stream as JSONL to stdout; human-readable progress goes to stderr.
`--answer-schema` is described under [Harness file](#harness-file).

#### bench

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
tokens, model time and dollars of the passing runs, on the tasks shared with the first harness of the same
model (at least 5, else `-`); a cost dearer than `evolve` would allow is marked `!`, and nothing is refused.
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
list says it is incomplete, and the window comes from that list — see [Cloud](#cloud).

**Tasks.** `--task` picks another task, and every task but `slug` needs a `--size`.

| task | sizes | what it is |
|---|---|---|
| `slug` | — | the demo: find a bug report in a long log, fix `src/slugify.js`, make `node --test` pass |
| `pool`, `pool2` | 1–10 | ten small buggy units, more of them with each size; see [The pool task](docs/findings.md#the-pool-task) |
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
[docs/curator.md](docs/curator.md).

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

#### evolve

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
money of a sweep that a stop cuts is not in the journal and is not counted, so the real total may be one
sweep higher. A proposer with no price of its own is not counted (evolve says so at the start). `--report`
needs no flag and prints what the journal says was spent.

A 429 is retried up to 3 times (the `Retry-After` wait, at most 300 s, else 60 s); a 429 after part of
the reply has streamed is not retried and stops at once. A 401, a 402, a 403 without
moderation reasons and a 429 that lasts stop evolve with exit 1 and none of the cut step's runs in the
journal; the same command resumes. A stop in the middle of a set re-measures that set, in the middle of
the final test up to 30 runs. The proposal is journaled before its runs, so a resume measures the same
edit. `bench` records `stop` in its JSON and skips that run's check. A new key under the same variable
resumes an evolve; a different variable (`--api-key-env`) is refused as "the harness or its options
changed". Give the harness enough `backend.maxTokens`: the proposer inherits it when there is no
`--proposer`, and a proposal cut there is refused as `reply cut at maxTokens`.

The journal is checked, not trusted. Every start and every resume replays it and re-checks each
decision against its own numbers; a journal edited by hand, a changed harness or option, a new commit
in the repo or a changed notes snapshot is refused, and the message says how to start over: delete
the journal and move away `harnesses/<name>.v*.json`; for a finished evolve whose journal is intact it
points at `--report` and says to move the journal away, not to delete it. A resumed evolve continues at the step it
stopped on. `--report` prints the report of a finished evolve from the journal alone, with no run and no API key
(the mode, the size and the rounds come from the journal; give only the backend overrides, `--proposer` and `--timeout` the run had): it reads the tasks at the commit the journal started at, so it prints
even after new commits or a deleted notes snapshot, and it says when `vN.json` on disk differs from
the version that was measured. To use `vN`, point at it; copying it over the original file changes
the harness the journal was pinned to, and a later `--report` refuses.

Exit codes: 0 with a report; 1 when the model changed the linked `node_modules` or a stop above ended it; 2 for a refusal, a
bad argument, or a server that does not answer or lacks the model; 130 for Ctrl-C, after which the journal holds every finished step.

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

##### Self-improvement window

**Self-improvement…**, under the form on the Workbench tab, runs the same evolve as the CLI on a
saved harness and a repo, one job at a time together with a bench started from the page.
**Stop — resume later** stops it the way Ctrl-C does; the next Start with the same harness and repo
resumes. After a finished evolve, **Use vN** shows what `vN` changes in plain words, field by field,
with lines that look like an address or a command and fields outside what evolve may change flagged;
nothing reaches the form before **Load vN into the form**. The repo's notes can be deleted there,
one or all. Polyglot and `--proposer` stay in the CLI. Evolve runs the model's shell commands for
hours without asking, as you. It notices changes to `node_modules` and stops, but it does not
isolate them. Start runs `git status` in the folder you name; open only repos you trust.

#### replay

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

#### analyze

`analyze` reads traces and prints, per run, what the model never saw again: the turn the budget
first stubbed and which tool results that stub removed, the turn of the first successful edit, the
file with the most failed edits (with the errors by kind), and the first time the model read a file
again after its earlier read was stubbed. A trace records each request as sent, not what a stub
removed, so the stubs are rebuilt by comparing consecutive requests; a stub that cannot be tied to
results is printed as `unmatched`, never guessed. It takes bench JSONs, run ids and trace paths,
`.jsonl.part` included; `--json` prints the whole analysis. The Bench tab shows the same cells under
each run, and a trace shows them above its first turn, with `[stubbed at tN]` on each removed
result.

### Recording another agent

`proxy` sits between an agent you did not write and llama-server. It forwards every request as it
came and writes each conversation it sees to `runs/<id>.jsonl`, the file `run` writes. The Runs list
then shows that agent's requests and replies, and `replay` takes any of its turns.

    llm-harness-builder proxy --upstream http://127.0.0.1:8080 --port 8090 --name opencode

Start it in the directory `serve` runs in (both use `./runs`) and give the agent
`http://127.0.0.1:8090/v1` as its OpenAI base URL. `--upstream` is the server root, not its `/v1`.
Every path goes through; only `POST …/chat/completions` and `POST /v1/messages` are recorded. Ctrl-C (or `kill`) ends every
open run with `done: proxy_stopped`: the recording stopped, which says nothing about how the agent did.
The proxy refuses requests from a browser page served from another origin (other ports of
`localhost` included), as `serve` does; agents that are not browser pages send no `Origin` and are
not affected.

**What the file holds** is a transcription, never a guess:

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

**Where a run starts.** The proxy keys a conversation by its first system message and its first
user message, and a request with the same pair and no fewer messages than the last one continues
it. That fits agents whose first user message is the task and whose history only grows; it does not
fit aider, whose first user message is its edit examples. So:

- a new round of the same task, and a history the agent compacts, start new runs; a retry stays;
- a side request with its own system prompt is its own short run: each of opencode's history
  compactions is one. Its session title is not: that request never grows past three messages and
  does not depend on the task, so every session's title request over the proxy's whole lifetime
  joins the one run opened by the first; that run's row shows the title instruction, not the task;
- our own harness through the proxy splits where it changes those messages: a
  `loop.repeatThinkTokens` turn is a one-turn run, and `loop.freshContext` starts a new one;
- two identical sessions at the same time interleave in one run, and two sessions of the same task
  one after the other share the run of their identical one-message side requests.

**Claude Code.** Point the proxy at Anthropic and Claude Code at the proxy's root, not its `/v1`.
On start the proxy prints two lines: `proxy on http://127.0.0.1:<port>/v1 -> …` is the base URL for
OpenAI-style agents; Claude Code takes the value from the second one,
`for Claude Code: ANTHROPIC_BASE_URL=http://127.0.0.1:<port>`, without `/v1`:

    llm-harness-builder proxy --upstream https://api.anthropic.com --name claude-code
    ANTHROPIC_BASE_URL=http://127.0.0.1:8090 claude

Both sign-ins work. With an API key, set `ANTHROPIC_API_KEY` (sent as `x-api-key`) or
`ANTHROPIC_AUTH_TOKEN` (sent as `Authorization: Bearer`) as usual. With the subscription, set only
`ANTHROPIC_BASE_URL`: the saved OAuth token and its `anthropic-beta` value pass through unchanged.

- Recorded: `POST /v1/messages`, streamed or not. Claude Code's `x-claude-code-*` headers split a
  session into one run per agent, the main one and each subagent, and the Runs list groups them
  under their session. Auxiliary calls (titles, classifiers) are notes in the main run, and a
  compaction is a marker in its agent's run. Without those headers (older versions) the
  system-and-first-user rule above applies.
- Not recorded: `count_tokens`, every other path. No request header is written as such; only the
  session, agent, parent agent and agent type ids from `x-claude-code-*` go, scrubbed, into the
  run's meta line to group the runs. The request's key or token is replaced by
  `[redacted: x-api-key]` or `[redacted: authorization]` wherever it shows up, a reply that echoes it
  included; a value shorter than 20 characters is not looked for. Telemetry and update checks go to
  anthropic.com directly, not through the proxy.
- `--upstream` refuses a URL with a login or password, a query or fragment, and plain http to
  anything but loopback.

Claude Code sends your CLAUDE.md, memory, git identity and local paths in every request, so the
trace holds them. Record a session you will show from a clean profile: a temporary `HOME` or
`CLAUDE_CONFIG_DIR`, no global CLAUDE.md or memory, a synthetic repository with a throwaway git
identity. Hiding names on screen while filming is a display convenience, not privacy protection.
Recordings stay on your machine; never commit them.

**A running session.** While the proxy that writes it is alive (its pid is in the meta line)
`serve` does not mark the run aborted, and the page picks up new events every few seconds. If the
proxy was killed and the system has given its pid to another process, the run shows as running
until that process ends.

Like every trace, a recorded one holds everything the agent read and its system prompt, local paths
included. Request headers, an API key among them, are never written as such; only Claude Code's
grouping ids above go into the meta line.

<details>
<summary>Checked with opencode: setup and what the proxy saw</summary>

opencode 1.18.32 (`npx opencode-ai run --pure "calc.py has a bug in add; fix it"`) on
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

Every request was streamed and asked for `usage`, which came on every reply. The main session's
first request is two messages and eight tools, about 8,900 tokens, so opencode does not fit the
4096 window the other checks here use. At `-c 4096` the server refused it; opencode took the refusal
for oversized attachments and compacted its history again and again, nine runs in five minutes
before it was stopped. At `-c 16384` it fixed the bug in three turns (a `read`, an `edit`, then
nothing), recorded as the main run plus a one-turn title run. The third turn is worth opening: the
model wrote its next `read` call inside its thinking, the server found no tool call in the reply,
and opencode took that as the end. `replay` of the `edit` turn gave the recorded call 2 times out
of 2. That is one model on one task: it says the proxy records what opencode sends, not how opencode
does on local models.

Whether that third turn was worth a knob — taking a call out of the thinking — was checked by
`replay`, each turn of that session sent ten times as recorded. The first two turns gave a real
call ten times out of ten: the `read`, then the `edit`. The third, after the fix, gave a final text
seven times and the `read` inside the thinking three times. None of the 197 earlier traces in
`runs/` has a reply that ended with a call in its thinking. So on this model and task the call went
into the thinking only on the turn that checks finished work, never on a working turn (0 of 20),
and no knob was built for it. That says nothing about other models.

</details>

## Configuration

### Harness file

A harness is one JSON file: backend, prompts, tools, limits. Start from
[`harnesses/tuned.json`](harnesses/tuned.json):

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
`mcpServers` entry: every optional knob is off when absent, so a misspelt one would otherwise be
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
| `loop.freshContext`, `repeatTemperature`, `repeatThinkTokens` | ways out of a loop — see [the findings](docs/findings.md#three-ways-out-of-a-loop) |
| `loop.untilBash` | a final answer ends the run only once this command exits 0 |
| `mcpServers` | tools from MCP servers — see [MCP](#mcp) |
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
secret scrub catches `key=`/`token:` style secrets in any case and `Bearer` tokens. `notes: { "enabled": false }` needs no `maxTokens`. See the [honest notes](docs/honest-notes.md) for what a note can get wrong.

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
is the 2026-10-10 count in [the findings](docs/findings.md#a-second-model-2026-10-09): on `pool2` the
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
`backend.apiKeyEnv` names. `run`, `demo` and `bench` print the names on stderr when they start, and
the UI shows them under the tools. A value a command prints lands in `runs/` and in the next request
to the backend — the backend key's own value excepted, which is redacted (for the limits, see
[Cloud](#cloud)). This keeps keys out of what a command prints by accident; it is not a sandbox —
see the [honest notes](docs/honest-notes.md).

### Backends

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

### Cloud

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
UI see them, and MCP servers start without the variable. The [honest notes](docs/honest-notes.md)
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

### Anthropic

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

### Model families

A family button in the UI (`applyFamily` in `src/core/prompts.ts`) fills the tool-call mode,
format, prompted template and parse-error hint, and swaps the trailing family line of the system
prompt; the form then says what it changed. It never touches backend, tools, context or loop
settings, and nothing about the family is stored in the harness file — only the resulting plain
fields.

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

### MCP

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

On the same setup as [Bench results](docs/findings.md#bench-results):

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

## How to read the results

Every number in this README and in [the findings](docs/findings.md), and every "did not help", comes
from one model — Qwen3-8B Q4_K_M on llama-server — and three small tasks, two of which are the same
ten units in another order; five runs or fewer per arm, often near-clones at temperature 0.2. The
one exception is its own section, [A second model](docs/findings.md#a-second-model-2026-10-09),
three runs per arm of one other model on two of those tasks, plus the one-run Anthropic checks
[above](#anthropic). A result here says what that model did on that task with that harness. It does
not say what a knob does: a knob that moved nothing here may move another model, or this one on
another task, and a knob that helped here may not help yours. That is what `bench` and the traces
are for. The knobs that showed no effect are still in the tool, off by default, for that reason; the
one change that was dropped (the labelled stub) was dropped for what it cost, and its paragraph says
on what evidence. At five runs an interval is wide: `bench` prints the 95% one next to every PASS
count now, and the tables in the findings, printed before it did, carry none.

## Findings

What was measured with this tool, each section with its setup and its traces, in
[docs/findings.md](docs/findings.md). Read [How to read the results](#how-to-read-the-results) first.

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

## Limitations

Known failure paths, what the redaction misses, what is not a sandbox, and what the numbers do not
say: [docs/honest-notes.md](docs/honest-notes.md).

## Development

    git clone https://github.com/bambooplanedev/llm-harness-builder
    cd llm-harness-builder
    npm install

    npm test               # vitest, no model needed
    npm run typecheck      # tsc and vue-tsc
    npm run build          # dist/ and web/dist/
    npm run cli -- demo    # the CLI from source
    npm run dev:server     # serve from source, and in another terminal:
    npm run dev:web        # the page with hot reload

The CLI and the server are TypeScript in `src/`, the page is Vue 3 in `web/src/`, and the tests in
`tests/` run against fake backends. Issues and pull requests are welcome; a change to a knob should
come with a test, and a claim about what a knob does with the bench and traces behind it.

Before a release, `scripts/launch-check.sh <tgz>` runs the checklist in its header on the packed
tarball, in a `node:22.12-slim` container (Docker needed). Keys go in by name only; a step whose key
is not set is `SKIP`, and a run with a skip is not green. The release:

    npm ci && npm pack --pack-destination ..    # in a fresh clone of the release commit
    scripts/launch-check.sh ../llm-harness-builder-X.Y.Z.tgz
    git tag -a vX.Y.Z && git push origin vX.Y.Z
    gh release create vX.Y.Z ../llm-harness-builder-X.Y.Z.tgz
    npm publish ../llm-harness-builder-X.Y.Z.tgz    # 2FA
    npm view llm-harness-builder@X.Y.Z dist.shasum    # equals the sha1 the check printed

## License

[MIT](LICENSE)
