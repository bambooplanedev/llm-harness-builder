# Findings

What was measured with [llm-harness-builder](../README.md). Read
[How to read the results](../README.md#how-to-read-the-results) first: every result here is one
model on one task with one harness.

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

- **In these runs the sentence in the prompt did all the work.** Without it the model's first edit was blind in
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

So on this model and this task a rule in the prompt and the same rule in code were not equivalent,
and code was the weaker of the two: the refusal repaired the one call it refused, the sentence
changed how the model edited at all. What these five runs cannot separate is the guard from the path it forces —
the honest reading is "a recovered refusal left the model in a state it did not recover from
twice", not "guards are harmful". The cheap next knobs are on the other error: `found 0
occurrences` says nothing about what *is* in the file, and nothing in the loop notices the same
failing call arriving ten times in a row.

The first of those knobs was tried next, and its premise turned out to be wrong — see
**Explaining an edit miss** below.

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
parse error. 34 s of generation, against the 35 s `tuned` took in the v2.0.1 re-run of all three: in this
one run the XML shape cost nothing and bought the trace. And the server did not do the parsing — prompted
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

Read that as: on this model and this task, in one run each, no single knob fixed `bare`. Turning
thinking off stopped the model from burning its whole context window before it answered;
truncating tool output stops one `read_file` from doing the same. Only both together left enough
room for the loop to finish. The knobs that come next in the trace — "run `node --test` before you
answer" and one tool call per response — are there because both harnesses declared victory on a
red test suite on the very first run of this demo; what each of them contributes was not isolated.

## Explaining an edit miss

`guard-only` lost every run above to one error repeated ten times: an `old` that is line 2 of the
file plus a semicolon, answered with `found 0 occurrences`. The obvious repair is a better error.
Before writing it, the traces corrected the premise: the error does not hide what is in the file.
The whole 91-character file had been read one turn earlier and was still in the context, and in
`rule-none` the model twice re-read it between two identical misses and missed again. What the
context never contains is the *difference*. `tools.explainEditMiss` says it:

    "old" must occur exactly once; found 0 occurrences. Line 2 of src/slugify.js matches your
    "old" except for punctuation or whitespace; the file has exactly:
      return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-')

It fires only for a one-line `old` that equals some line of the file once everything but letters,
digits and `_` is dropped; otherwise the message is what it always was. The edit is still refused:
finding the line and declining to use it is the point, the question being whether the model can use
an explanation. Off by default, nothing in the tool descriptions, so no tokens until a miss.

`guard-hint` is `guard-only` plus the flag; `tuned` rides along as a reference. Five runs each,
same setup as **Bench results**, against the test file as of commit `7b66d05` — the one that also
asserts the leading dash, so these numbers do not share a table with anything above:

| harness | PASS | how the runs ended | `editMiss` | explained | recovered after a miss | most repeats of one failing call, per run |
|---|---|---|---|---|---|---|
| `guard-only` | 1/5 | `max_turns×4 final×1` | 43 | | 0 of 5 | 11, 11, 10, 11, 1 |
| `guard-hint` | 1/5 | `max_turns×3 final×2` | 17 | 16 | 2 of 5 | 7, 1, 7, 2, 2 |
| `tuned` | 3/5 | `final×3 backend_error×2` | 0 | | | |

Decided before the run: the estimand is "recovered after a miss" — runs with a successful
`edit_file` or `write_file` on `src/slugify.js` after the first miss — read as "gets the model out
of the loop" at 4 of 5 or more against 0, as a null at 0, and as "partly" in between, to be
published without the word for success. The repeats column counts failing calls with identical
name and arguments, consecutive or not. PASS is not an argument here, and there is no significance
test: runs of one arm are close to one trajectory, so this is an existence proof on one string,
one three-line file and one model.

It is "partly", and the traces make it less than that:

- The explanation was shown 16 times and was **used zero times**. Not once did the next
  `edit_file` drop the semicolon. Seven times the model sent the identical call again; eight times
  it ran `node --test` on the file it had not changed, watched it fail, and in six of those went
  straight back to the same `old`; once it gave up on `edit_file` and rewrote the file with
  `write_file`.
- So of the two recoveries, one is that `write_file` — the same exit `rule-none` finds with no
  explanation at all — and the other never saw an explanation: its only miss was an invented
  `return cleanedString;`, which matches no line.
- What the explanation did change is the shape of the loop: eleven identical calls in a row became
  seven, interleaved with test runs. Shorter, not broken. `editMiss` fell from 43 to 17 mostly
  because those turns went to `node --test` instead.
- The control did not stay a clone of itself either: one `guard-only` run matched on its first
  edit after the refusal and went on to PASS. The floor held in four runs of five.

What this does not show: there was no placebo arm, so "the model reacts to a longer error" and
"the model reacts to this error" are not separated — and since it never acted on the content, the
first reading is the likelier one. The matcher was exercised by exactly one string. On `tuned` the
knob is inert: `editMiss` is 0 there.

`tuned` is the more useful row. Against the stricter test its first edit is a half fix in
all five runs — the trailing dash only — and the test goes red. Three runs fix it on the second
edit; two send the same `new` eight times, red each time, until the context runs out
(`backend_error`). Every PASS in this table is a full fix, and the price was 5/5 → 3/5. With the
`;` loop and the `node --test` loop in `guard-hint`, that is the third place this model repeats a
call that has just failed, and in these runs telling it why did not help. The knob they argue for is the
one that notices the repetition.

## Noticing a repeated call

`loop.maxRepeats` is that knob. The run loop counts how many times each call — same name, same
arguments — has been made since the files last changed through `edit_file` or `write_file`; an
edit that has itself succeeded is counted over the whole run (why: the end of this section). A
repeat is never refused: it runs, and its result gets one more line,

    note: identical call #3 since the last file change
    note: identical call #3 in this run

and when one call has been repeated more than `maxRepeats` times the run ends with
`repeat_loop` instead of burning turns up to `max_turns` or context up to a 400. Absent means off,
so nothing above is affected. An edit the guard refused is not counted, because `read_file` followed
by the same edit is exactly the recovery the guard asks for.

`guard-repeat` is `guard-only` plus `"maxRepeats": 3`. This is a smoke test, not a bench — four
runs of it and one of `guard-only`, same setup as above, on 2026-09-19. `e4!` is the fourth distinct
call, an `edit_file`, and it failed; `(#2)` is the note:

    guard-only    max_turns    r0 b1 e2! r3 e4! e4! e4! e4! e4! e4! e4! e4! e4! e4! e4!
    guard-repeat  final  PASS  r0 b1 e2! r3 e4 b5 e6 b5 e7 b5
    guard-repeat  max_turns    r0 b1 e2! r3 e4! e4!(#2) e4!(#3) w5 b6 e7 b6 e8 b6 e9 b6 e10
    guard-repeat  repeat_loop  b0 e1! r2 e3! r2(#2) e3!(#2) b4 e3!(#3) b4(#2) e3!(#4) b4(#3) e3!(#5)
    guard-repeat  final  PASS  r0 b1 e2! r3 e4! e4!(#2) e4!(#3) w5 b6 e7 b6 e8 b6 e9 b6

What it shows: the breaker works — the fourth run stopped at turn 12 and 57 s where `guard-only`
spends 15 turns and about 90 s; and the second run, which never looped, ran `node --test` three
times without drawing a note. What it only hints at: both runs that entered the eleven-call loop
left it for `write_file` right after note `#3`. Two runs cannot carry that — `guard-hint` has one
run above that made the same exit with no such note — and whether the note or the longer result
did it would need the placebo arm this README keeps not having.

**Two fixes, 2026-09-19, after the pool calibration below.** The first is unconditional; the
second changes `loop.maxRepeats`, which is still absent — and so off — in every shipped harness
but `guard-repeat` and `tuned-repeat`.

- `edit_file` with `old` equal to `new` used to write the file back and answer `edited`. It is an
  error now — `"old" and "new" are identical: nothing to change` — and an error clears no counts.
  Before, that false success counted as a file change and reset the count of every other call.
  Eight of the 95 traces recorded before this change contain such an edit, all of them FAIL: the
  two `backend_error` runs of `tuned` in "Explaining an edit miss" (seven each — the "same `new`
  eight times" there is one real edit and seven of these), two FAIL runs of `guard-hint` in the
  same table (one each), and four `tuned` runs of the pool calibration — `bench-pool7-unbound-n2`
  #1 (3), `bench-pool7-bound-n1` (2) and two of the void runs before the rewrite (4 each). Those
  rows were measured with the old tool and would not replay turn for turn with the new one. None
  of the 43 bench runs recorded as PASS contains one.
- With `maxRepeats` set, a successful edit now clears the counts of every call except the edits
  that have succeeded: such an `edit_file` or `write_file` is counted over the whole run, and its
  note reads `note: identical call #2 in this run`. The same edit can succeed twice only if
  something undid it in between, and until now two edits that undo each other cleared each
  other's counts. An edit that has only ever failed is still new again after a file change, as
  before. The four `guard-repeat` runs above replay to the same notes under the new counter — at
  the same calls, with the same numbers — and none of the 43 PASS runs repeats a successful edit.

What was checked, and what it showed. `tuned-repeat` is `tuned` plus `"maxRepeats": 3`. A smoke
run of it on the pool task — `--size 7 --max-turns 12 --n 2`, 32768 window, as in the calibration
— was 2/2 PASS in 5 and 7 turns, 112 s and 129 s. Each run had one runaway cut
at the cap and went on; neither entered a loop. One note was written in the two runs, on a second
`node --test` that followed a `read_file`, and that run then fixed `paginate` and passed. So the
smoke run shows no harm and says nothing about the flip-flop. For that, the recorded flip-flop of
`bench-pool6-unbound-cal-r2` was replayed against the model at its turn 6 — 11.6k tokens of
history, the point where `return out` → `return out.length > 0 ? out : []` has just succeeded for
the second time — once with the notes the old counter would have written into that history and
once with the new ones, five requests each. All ten replies are the same 155 tokens: undo it
again, flip `paginate` back, run the tests twice. The note changes nothing here. What the fix adds
is the breaker: counted this way that run ends as `repeat_loop` at turn 11, on the fifth identical
edit, where as recorded it flipped until the bench timeout at 420 s. One recorded history, by
substitution. (It fired in a live run the same evening, twice: the end of "The measurement that
was not run".)

## The pool task

Everything above was measured on one task, and a healthy run of it never comes near the window:
`tuned` goes 643 → 2981 → 3911 → 3995 → 4528 → 4792 tokens of 8192 in six turns. Only runs stuck in
a loop reach the edge, so `context.budgetTokens` — 0 in every shipped harness — has never had
anything to do, and the three `backend_error`s under [Honest notes](honest-notes.md) that are plain
history growth had no task to be studied on. `pool` is that task.

    llm-harness-builder bench harnesses/tuned.json --task pool --size 7 --max-turns 36 --n 1 \
      --kind openai --base-url http://127.0.0.1:8080/v1 --model unsloth/Qwen3-8B-GGUF:Q4_K_M

`examples-pool/` holds ten small modules with one bug each — `clamp`, `words`, `titleCase`, `chunk`,
`paginate`, `parseDuration`, `dedupe`, `range`, `formatBytes`, `median` — and `--size N` is the first
N of them, in that order. `titleCase` imports `words` and `paginate` imports `chunk`, and their bugs
are misuses of what the imported module does. The prompt is the same for every N and names no
technique:

> The test suite of this project fails. Find and fix the bugs in the files under src/ until
> `node --test` passes. Do not edit the tests. Finally answer with a one-line summary.

The verdict is not the model's to reach. Before it is taken, `test/` in the workdir is deleted and
replaced with the pristine tests of the first N units, and `node --test` runs on exactly those
files: a test the model rewrote cannot pass a wrong fix, a test file it added cannot fail a right
one. A test in this repo applies the ten reference fixes leaving one out, ten times over, and
expects FAIL each time and PASS only with all ten. The review of the units still found two oracles
a wrong fix could pass (`dedupe` ignoring its flag, `range` guarded by `x !== end`); both are
closed. Every PASS below was also read by hand against the reference fixes.

**Pool numbers never share a table, a sentence or a reference row with anything above.** Different
task text, a different oracle, `maxTokens: 1024`, and `--max-turns` — an override like `--model`,
recorded in the JSON — because 15 turns are too few here.

### Calibration, 2026-09-19

llama-server, Qwen3-8B Q4_K_M, `tuned` as shipped, Node v24.18.0, one run per row. "Unbound" is the
server started with `-c 32768`, so the window is not what ends a run; `numCtx` is not sent on
`--kind openai`, so the JSON cannot say which window a file was measured in — the file name and the
table below do.

| file in `runs/` | N | window | result | turns | s | peak tokens |
|---|---|---|---|---|---|---|
| `bench-pool6-unbound-cal-r2` | 6 | 32768 | FAIL, `aborted` at 420 s | 13 | 420 | 31280 |
| `bench-pool7-unbound-cal-r2` | 7 | 32768 | **PASS** | 6 | 94 | 7594 |
| `bench-pool7-unbound-n2` #1 | 7 | 32768 | FAIL, `final` on a red suite | 8 | 235 | 18970 |
| `bench-pool7-unbound-n2` #2 | 7 | 32768 | **PASS** | 6 | 90 | 7602 |
| `bench-pool7-bound-n1` | 7 | 8192 | FAIL, `backend_error` | 8 | 159 | 8210 |

Two PASS, two full fixes: one is the reference fix in all seven units, the other differs by an
ignored third argument in `paginate`.

Five more runs came before these and are void as calibration: they are why two units were rewritten.
In both runs where `chunk` went wrong the model's first edit was byte for byte the same wrong one —
it rewrote `return out` and left the loop condition alone — and in two of the three runs that
contained `parseDuration` it never touched the lookup table that held the bug, cycling
`toLowerCase()` — and in one of them `/ 1000` and `* 1000` — on the line below it until the run
ended. The plan allowed one repair of a unit the model loops on, said in advance: both bugs kept
their kind and moved into the line the failure points at (commit `a1579a0`). `parseDuration` has
been fixed first try since. `chunk` has not: when it misses, the model goes for `return out`
wherever the bug is.
Every run on this page was measured on the units as of that commit; the final review then found that
a fix hardcoding the tests' piece size passed `chunk`, and a second size was added to its test
afterwards — a correct fix is unaffected.

What the calibration measured:

- **The pressure is real, and it is not where the design put it.** In these runs the model did not
  work unit by unit. It read all N files in one turn and edited all N in the next, so a healthy run is seven
  turns at N = 5 and six at N = 7, and what fills the window is `node --test` output, cut at 4000
  characters a run. Healthy peaks: 4943 tokens at N = 5 (measured before the rewrite), 7594 and
  7602 at N = 7. The estimate the budget trims by is 0.69–0.83 of the exact count here, median 0.76,
  over the 100 turns after the first of all ten runs (0.55–0.72, median 0.58, over 161 on the old
  task): it depends on what the history is made of.
- **Six of the ten runs were lost to a loop, and the window caused none of them.** It ended two:
  the last row, and one of the void runs, which grew into the 32768 window at turn 21. Two are the
  same period-2 flip-flop on `chunk` — `return out` ⇄ `return out.length > 0 ? out : []`, with
  `??` ⇄ `||` in `paginate`, a test run after each, for up to ten turns; a third flips
  `return out` against a longer expression while its `paginate` edits change nothing. Two cycled
  a suffix on one line of the old `parseDuration`; one alternated reading `chunk.js`, editing it
  and running the tests, and for its last five turns stopped editing altogether.
  `loop.maxRepeats` as built would not see the flip-flop: a successful edit clears the counts of
  every other call, so two edits that undo each other never accumulate. That is the fourth place
  this model repeats what just failed, and the first with a period. (Later the same day the
  counter was changed to see it — the end of "Noticing a repeated call". These runs were made
  without `maxRepeats`.)
- **Four runaways, none fatal.** After a batch of edits — seven in the two read closely — the model
  kept appending `{"name":"bash","args":{"command":"node --test"}}` to the same response — 37 and 42
  call objects in the two read closely; a healthy batch is 486 tokens. Each was cut at the
  1024-token cap, the marker went back instead of it, and the run went on: two of those runs are
  PASS. A fifth truncation is the other kind: 8149 tokens of prompt, 43 of completion, the window
  and not the cap — and the retry, 8210 tokens, is the `backend_error` of the last row.

### The measurement that was not run

The plan was `tuned` with `budgetTokens` fixed by rule from calibration — 4691, i.e.
0.9 × 0.731 × (8192 − 1024 − 37) — three runs inside 8192 against the unbound runs above, with the
reading written down in advance. Three gates stood before it. Two held: at N = 7 two of three
unbound runs are PASS, both full fixes, and the turn limit for the measurement was fixed at 12. The
third did not: the bound control has to die of the window and not of a loop. It died of
`exceed_context_size_error`, and its trace is the `chunk` flip-flop starting — turn 4 rewrites
`return out`, turn 5 puts it back, turn 6 rewrites it again. A healthy run at N = 7 peaks at 7594
and fits. The repair of the two units is part of why: with the old units the one healthy run at
N = 7 peaked at 8903 and would not have fitted. The rule that chose N = 7, "a healthy peak above
8192 − 1024", was too lenient for a gate that asks for a healthy run the window kills; with no
such run there is nothing for a budget to rescue, and a number measured anyway would be a number
about a loop. So there is no `tuned-budget.json` and no result. What is in the repo is the
instrument, its calibration, and one fix the preparation turned up: `applyBudget` used to be able
to stub a tool result before the model had seen it; it now leaves everything after the last
assistant message alone.

**A second attempt, the same evening, stopped one gate earlier.** Its rules were changed after the
data above was seen, and this is what changed. The window became the parameter instead of N: the
PASS runs above show that N hardly moves the peak — reading all seven files costs about 800 tokens,
one `node --test` output 1000 to 1900 — so what fills the window is the number of test cycles, and
by that arithmetic a lucky two-cycle run would fit 8192 at any N up to 10 (no size above 8 was run). The plan: N = 7, the server at `-c 5120`,
`tuned-repeat` as the base arm so that a loop ends as `repeat_loop` and a 400 means the window,
`budgetTokens` 2670 by the same rule, `--max-turns 18`, and the first gate unchanged — at least two
of three unbound runs PASS. They were not:

| `bench-v29-unbound-n3` | result | turns | s | peak tokens |
|---|---|---|---|---|
| #1 | FAIL, `repeat_loop` | 14 | 343 | 19379 |
| #2 | FAIL, `repeat_loop` | 10 | 266 | 13767 |
| #3 | **PASS** | 8 | 143 | 6546 |

So again there was no control run, no budget run and, at that point, no `tuned-budget.json`. Both failures are the
`chunk` flip-flop, and both were ended by the breaker of "Noticing a repeated call" on the fifth
identical successful edit — its first firing in a live run, twice. The notes before it, seven in
the first run and eight in the second, moved nothing. In neither run did the model ever edit the
line that holds the bug, `arr.slice(i, size)`; it rewrote `return out` and put it back. Both runs
had fixed `paginate` at turn 4, and its test stayed red because `paginate` imports the broken
`chunk`: the first run then sent a `paginate` edit with `old` equal to `new` on nine turns in a
row, each now an error, and the second flipped `??` and `||`. Replayed against 5120, all three
trajectories cross it — the two failures at turn 5, where 5016 and 5013 tokens of prompt leave no
room for the 178 and 235 of the reply, the PASS run at turn 6 with a prompt of 5207. And in both
loops what `applyBudget` may not touch — the system prompt, the task, the assistant's own messages
and the newest results — alone outgrew 2670 by turns 9 and 8: a budget could not have held those
runs in any window. Two attempts have now stopped at a gate for the same reason. What this task
measures in this model, before anything about context, is whether it finds the bug in `chunk`.

### The measurement, on `pool2`

`pool2` is the same ten units in another order — `clamp`, `words`, `titleCase`, `parseDuration`,
`dedupe`, `range`, `formatBytes`, `median`, `chunk`, `paginate` — so sizes 1 to 8 hold neither
`chunk` nor the `paginate` that imports it. It exists because this model, with this harness, lost
two runs in three to the bug in `chunk` — it does find it in the PASS runs above — and a task lost
to that so often measures nothing else. The order was changed
after the data above was seen. That selects for PASS, for shorter histories, for fewer loops and
fewer re-reads, so no `pool2` number is comparable with a `pool` number and the two never share a
table. `pool` did not move: a test pins a hash of its first eight units, the largest size ever
run. One oracle was repaired first — `formatBytes` fixed with `n >= 1000` instead of `n >= 1024`
used to pass — and `formatBytes` is the one unit of these seven the model had never met. Sizes 9
and 10 put `chunk` and `paginate` back; no `pool2` run was made at those sizes.

The rules are those of the second attempt, fixed before any `pool2` run: N = 7; the server at
`-c 5120`; `tuned-repeat` as the base arm; `tuned-budget` one key apart, `budgetTokens` 2670 =
floor(0.9 × 0.731 × (5120 − 1024 − 37)); `--max-turns 18`; one attempt, the budget not re-tuned;
no significance test, because runs of one arm are near-clones (temperature 0.2, no seed). 0.731 is
the lowest estimate-to-exact ratio of the first calibration, kept although it was taken from a
loop: the ten runs below have minima of 0.716 to 0.758, the lowest again in the one unbound loop,
the rest 0.748 and up. A smaller budget is safe for the window and lenient to the knob — it fires
sooner — so "the knob fired" below is not evidence that a fitted budget would have.

    llama serve -hf unsloth/Qwen3-8B-GGUF:Q4_K_M -c <32768|5120> --port 8080 --jinja
    llm-harness-builder bench harnesses/<tuned-repeat|tuned-budget>.json --n <3|1|3|3> --task pool2 --size 7 \
      --max-turns 18 --timeout 420 --kind openai --base-url http://127.0.0.1:8080/v1 --model unsloth/Qwen3-8B-GGUF:Q4_K_M

| arm, file in `runs/` | window | result | turns | s | peak tokens | prompt eval, ms/turn |
|---|---|---|---|---|---|---|
| `tuned-repeat`, `bench-v29-pool2-unbound-n3` #1 | 32768 | FAIL, `repeat_loop` | 14 | 248 | 14509 | 6785 |
| #2 | 32768 | **PASS** | 7 | 132 | 5855 | 4199 |
| #3 | 32768 | **PASS** | 7 | 133 | 5859 | 4198 |
| `tuned-repeat`, `bench-v29-pool2-control5120-n1` | 5120 | FAIL, `backend_error` | 6 | 115 | 5344 | 4533 |
| `tuned-budget`, `bench-v29-pool2-budget5120-n3` #1 | 5120 | FAIL, `repeat_loop` | 10 | 194 | 3358 | 6585 |
| #2 | 5120 | FAIL, `repeat_loop` | 10 | 189 | 3357 | 6147 |
| #3 | 5120 | **PASS** | 9 | 173 | 3338 | 6522 |
| `tuned-budget` with the low-water mark, `bench-v29-pool2-budget5120-mark-n3` #1 | 5120 | FAIL, `repeat_loop` | 9 | 168 | 3361 | 4554 |
| #2 | 5120 | FAIL, `repeat_loop` | 9 | 168 | 3364 | 4646 |
| #3 | 5120 | FAIL, `repeat_loop` | 9 | 168 | 3364 | 4651 |

Prompt eval is `timings.prompt_ms` summed over the requests that got an answer, divided by their
number; the control's turn 6 got none, so its cell is over five requests, not six.

The gates held. Two of three unbound runs are PASS and both are full fixes: six units carry the
reference fix to the letter, `range` the reference condition inside a pair of parentheses.
Replayed against 5120 all three unbound trajectories cross it at turn 6, with prompts of 5352,
5326 and 5332 tokens, and the live control died exactly there: `request (5344 tokens) exceeds the
available context size`. The control is reported, not read; it is how the window was chosen.

What the budget did. It fired at turn 5 in all six budgeted runs and on every turn after it (on
all but turn 6 with the mark); none of the six ever held more than 3364 tokens, where the control
died at 5344 and the two unbound PASS runs needed 5855 and 5859. No result was stubbed before the
model had seen it, and what `applyBudget` may not touch never outgrew the budget — 2278 at most in
these six, in `chars / 4` units. One budgeted run ended `final` and PASS inside 5120, a full fix by the same
audit. That is the existence proof, and it is one run.

What it cost. Every run of every arm sends, in its batch of edits at turn 4, a `formatBytes` edit
whose `old` equals its `new`, and gets the error for it. All four unbudgeted runs answer at turn 5
by reading `formatBytes.js` again, and the two that pass then fix the `while` line. None of the six
budgeted runs does that at turn 5, and turn 5 is the first request with a stub in it. Without the
mark the stub is the results of turn 1 — the directory listing and the first test output, 4213
characters in one message — and all three runs send the same no-op edit again. At turn 6 the next oldest message goes — 2244 characters, the seven files the model
read at turn 2, which in a prompted harness are one message, all the results of a turn, replaced by
`[dropped: 2244 chars]` with no word of what it was. One run reads `formatBytes.js` again at that
point and fixes the `while` line at turn 8; two rewrite the `return` line instead and repeat no-op
edits until the breaker ends them at turn 10, on the fifth `node --test` with no file change in
between. With the mark both messages go at once at turn 5 (6457 characters), all three runs
rewrite the `return` line blind, none reads the file again, and the breaker ends all three at
turn 9. Re-reads after the first stub: 0, 0, 1 without the mark and 0, 0, 0 with it, against one at
turn 5 in every unbudgeted run — and a zero here means the model was not told what it had lost,
not that it did not need it. `repeat_loop` after the first stub was written down in advance as
belonging to neither the knob nor the task, and the unbound arm lost one run of three to the same
`formatBytes` loop with nothing stubbed. But the change at turn 5 is six runs of six against none
of four, and the runs of an arm are near-clones — the three with the mark are the same run to the
call — so read it as two observations against one, not six against four.

What it cost in time, and the mark. Rewriting an old message makes llama-server evaluate the
prompt again from that message on. Summed `timings.prompt_ms` per turn: 4199 and 4198 ms in the two
unbound PASS runs, 6585, 6147 and 6522 ms with the budget — 12615, 11668 and 11181 prompt tokens
evaluated in a run against 5244 and 5248. The threshold written down for building a low-water
mark was 1.5 times the unbound median; 6522 against 6298 crossed it, narrowly. So `applyBudget`
now stubs down to three quarters of the budget once it is over it, and the third arm measured
that: 4554, 4646 and 4651 ms per turn, 7788, 7778 and 7795 tokens. The mark does what it is for,
and its arm has no PASS where the other has one; with three near-clones an arm that says nothing
in either direction. Rows 5 to 7 were measured on the commit before the mark and do not reproduce
on the one after it.

What this is a measurement of: `applyBudget` as implemented — oldest first, whole messages, tool
results only, a `chars / 4` estimate — on a friendly task, one model, one window chosen from the
data. What it shows is that the knob holds a run inside a window that otherwise kills it, and that
the first things it throws away included the thing the model needed next. The weak point it found
is not the threshold: it is that a stub takes a whole turn's results at once and does not say what
they were. (Corrected 2026-09-19, next paragraph: that was then built and measured, and it is not
the weak point either.)

**The stub that says what it was, 2026-09-19 — built, measured, not merged.** The change: every
result of a turn is stubbed on its own, oldest first, a result whose stub would not be shorter is
left alone, and the stub names the call — `[dropped: read_file {"path":"src/formatBytes.js"}, 309
chars]`. A replay over the three unbound traces said beforehand that on this task the granularity
could not matter: what `applyBudget` may not touch is about as large as the mark, so at turn 5
every result goes either way, all seven files with it. That left one variable, what the stub says,
and one expectation written down before the run: the model reads `formatBytes.js` again at turn 5.
Same commands, `tuned-budget` with the mark, three runs:

| file in `runs/` | window | result | turns | s | peak tokens | prompt eval, ms/turn |
|---|---|---|---|---|---|---|
| `bench-v210-pool2-budget5120-label-n3` #1 | 5120 | FAIL, `repeat_loop` | 9 | 173 | 3667 | 5553 |
| #2 | 5120 | FAIL, `repeat_loop` | 9 | 164 | 3662 | 4657 |
| #3 | 5120 | FAIL, `repeat_loop` | 9 | 164 | 3667 | 4655 |

It does not. Re-reads: 0, 0, 0. From turn 5 to the end all three send the same calls with the same
arguments as the three runs with the mark — six runs, one sequence. At turn 5 the history says in
so many words which file was dropped, and the model edits the `return` line from the `old` string
of its own earlier call, which is an assistant message and stays. (#1 was the first run on a fresh
server and evaluated more prompt; it is reported, not read.)

And it cost something. One stub for a whole message leaves about twenty characters; a stub per result
leaves every `<tool_result …>` wrapper, every label, and every result too short to stub — `edited
src/clamp.js`. At turn 9 the history is 2798 in `chars / 4` units against a budget of 2670, with
nothing left to stub — 592 above what `applyBudget` may not touch, where the arm with the mark
ends at 2238, 32 above it. In real tokens that is 3662–3667 against 2952–2953, growing by about 220 a turn
against about 145. Nothing died of it here; the breaker ended the runs first. But the knob's one
job is to hold the history down, and it did that worse, for no change in what this model did on
this task. So
the change is not in the repo, these three rows reproduce on no commit of it, and `applyBudget`
is as the paragraphs above describe. What that leaves standing is narrower than it looks: on this
task, telling this model what it lost did not help once the file was lost. Whether losing the file is the harm is
the next paragraph.

**A budget with room in it, 2026-09-19.** At 2670 the question of what to stub never comes up:
what `applyBudget` may not touch is about as large as three quarters of the budget, so everything
it may touch goes at once. A replay of both unbound PASS traces over a range of budgets picked
3300 before any run: it fires at turn 5 (3427 against 3300) and one stub — the results of turn 1,
4213 characters — lands at about 2380, under the mark of 2475, so the seven files stay in the
history.
3300 is not a budget for a 5120 window (unseen results on top of it could pass the edge), so the
window was 32768 and did not bind: this measures what is stubbed, not the window. Written down
first: the first stub is turn 5 and 4213 characters (it was, three of three); if the model reads
`formatBytes.js` again at turn 5 the cost above was in what was stubbed, if it loops blind again
it was not; three runs are one observation; one attempt. `tuned-budget.json` with `budgetTokens`
3300, the commands above:

| file in `runs/` | window | result | turns | s | peak tokens | prompt eval, ms/turn |
|---|---|---|---|---|---|---|
| `bench-v210-pool2-budget3300-current-n3` #1 | 32768 | **PASS** | 7 | 146 | 3837 | 5964 |
| #2 | 32768 | **PASS** | 7 | 134 | 3835 | 4069 |
| #3 | 32768 | FAIL, `repeat_loop` | 11 | 193 | 4218 | 5251 |

(#1 ran first on a fresh server and evaluated more prompt, as in the table before.) Neither outcome as written. No run reads the file again — and the two that pass do not need to:
at turn 6 they fix the `while` line, which is still in the history, and their applied edits are
those of the audited unbound PASS runs, call for call. The third had written its `words` fix
another way at turn 4 (`.filter(w => w.length > 0)`, as good a fix), repeats the no-op once more
at turn 6, then rewrites the `return` line and loops until the breaker. So these three are not
clones, and a difference in wording two turns earlier is all that separates the FAIL from the two
PASS. Two of three with the files kept, against none of three at 2670 with the
mark and one of three without it, points the way the first outcome would have; it is a direction,
not a rate. What does hold across every run made: at turn 5 all four runs with nothing stubbed
read `formatBytes.js` again, and none of the fifteen with a stub in the history does — not even
these, where the stub is only the directory listing and a test output the model has a newer copy
of. It repeats the no-op edit instead (nine runs) or rewrites the `return` line (six). On this
model and this task a stub anywhere in the history changed the move at turn 5; with the files kept
in, two runs of three recovered from it.

(An accident, reported and not read: the first three runs at 3300 —
`bench-v210-pool2-budget3300-unbound-n3` — were made by mistake on a stale build of the unmerged
change above, labelled stubs and all. Same budget, same two results stubbed at turn 5, all seven
files in the history: FAIL, `repeat_loop`, 10 turns, three of three, one sequence, the same calls
as #1 and #2 above through turn 5. Set beside the table above that is two arms that until turn 6
differ only in the text of two stubs; with three clones against
a split three it does not say the labelled stub is worse, only that it was not better here
either.)

What follows for the knob is arithmetic, not policy. A budget can work only when three quarters of it
clears what cannot be stubbed by a margin worth having. On this task that floor is 1800–2350 in
`chars / 4` units, and the budget that is safe for a 5120 window is 2670: there is no room, and
no order of stubbing would make any. The candidate this leaves — stub test output before files
read — cannot be measured on this task at this window for the same reason.

## Three ways out of a loop

Every measurement above loses runs to `repeat_loop`, and everything tried against it so far was
text added to a history that already holds the loop: the `identical call` note, the explained
edit miss, the stub that names the call. None moved this model on these tasks. Three knobs in `loop` change
something else. All three are absent, and so off, in every shipped harness; the first two need
`loop.maxRepeats`, because a repeat is what that detector counts, and a harness that sets one
without it is refused. The second and third ideas are taken from
[Archon](https://github.com/coleam00/Archon)'s `fresh_context` and `until_bash`, which do this
between the steps of a workflow; here they act inside one agent run. **They were built first and
checked after**, so read "The check" below before relying on any of them: one of the three did
nothing on this model, on the two loop turns it was tried on. A fourth knob,
`loop.repeatThinkTokens`, came later and was checked before it was built; it has its own part
below, and the section ends with three later live checks: `untilBash`, the same stand with
repeated checks counted, and that knob with a larger cap.

`loop.repeatTemperature` (0 to 2). The turn after a turn in which some call drew an `identical
call` note is sampled at this temperature instead of `backend.temperature`; a turn without a
note goes back. That is looser than "after a loop": the first note in a run is usually a second
`node --test` with no edit in between, in runs that pass as well (counted below). A reply that
does not parse is retried at the base temperature. The risk is the obvious one: in `hermes` and
`native` modes nothing constrains the shape of a reply, an `edit_file` needs its `old`
verbatim, and a hot turn can turn a `repeat_loop` row into a `parse_failed` or an edit-miss row.

`loop.freshContext: N` (1 to `maxRepeats`). When one call has been repeated N times, the
history is cleared back to the system prompt and the task, with one sentence appended to the
task: an earlier attempt was cleared, the files may already be changed, look before editing. It
does not name the call that looped. The rest of that response's calls do not run, the repeat
counts and the read-before-edit record go with the history, and the trace gets a
`context_reset` event. Once per run: a second loop is for `maxRepeats` to end — which needs
`maxRepeats` + 2 more identical calls, so after a late reset the same pathology often ends as
`max_turns` instead, and such a row is not "no loop".

`loop.untilBash: "<command>"`. When the model gives its final answer, the harness runs the
command in the workdir (the `bash` tool's runner: 30 s, no more) and the run ends `final` only
on exit 0. Otherwise the output goes back to the model as `not finished: …` and the run goes
on, to `max_turns` if it must; each check is a `final_check` event. The exit code is read
before the output is cut to `maxToolOutputChars`. The command comes from the harness file,
like an MCP server's, so it is asked about the same way — once, before any model time and
before any server is started; refused, the run ends `aborted` with an `error` that says why.
And because the check executes files the model has written, under `tools.approveBash` every
execution asks again: otherwise "write a file, say done" would be a way around that flag. It
runs whether or not `bash` is among the enabled tools. One thing it invites and nothing here
prevents: a model told "not finished" by tests it can reach may edit the tests.

With `loop.maxRepeats` set, a failed check is counted the way a call is: a check that fails
again with no file change through a tool since the last one carries
`note: check #2 with no file change since the last one`, more than `maxRepeats` of them end the
run `repeat_loop`, and `repeatTemperature` / `repeatThinkTokens` treat it as a repeat. What the
claim says is not compared — with the files as they were, the check had nothing new to find.
`freshContext` does not fire on it, and without `maxRepeats` nothing is counted and the run goes
on as before. This came from the live check of `untilBash` at the end of this section, and its
own live run follows that one.

### The check, 2026-09-20

Written down before any model time: what is counted, what would refute what, which words are
allowed. Same model as above (Qwen3-8B Q4_K_M); llama-server build `b10826`.

**Counted over recorded runs, no model time.** 28 runs in the bench files come from a harness
with `maxRepeats` (10 PASS, 18 FAIL; six of the FAIL are the runs of the unmerged labelled
stub). A turn that `repeatTemperature` would have made hot: 11 of 82 turns in the PASS runs
(8 of the 10 runs have one), 69 of 186 in the FAIL runs. `freshContext: 1` would have fired in
8 of 10 PASS runs and 18 of 18 FAIL; `2` in 2 of 10 and 17 of 18; `3` in 1 of 10 and 16 of 18.
So 2 is the value that tells the two apart on these tasks, and 1 resets nearly every run.
For `untilBash`: 5 of the 45 FAIL verdicts (96 runs) ended `done=final` — two on `slug`
(`guard-hint`, `bare`), three on `pool` at sizes 6, 7, 8 with `tuned`; none on `pool2`, none
from a harness with `maxRepeats`. That is a ceiling on claims it could have caught, not on
passes gained: what this model does with red tests in front of it is the loop. It was not run
live in this check: nothing on the stand used below ends that way. It was later, on the `pool`
stand — see "Two more live checks" at the end of this section. On `slug` the natural command is the
grader itself, which would be a different experiment.

**`repeatTemperature`: a replay, and it did nothing on these turns.** One recorded request, replayed ten
times at each temperature. Two loop turns: turn 6 of `2e9da379` (`pool`, the `chunk` flip-flop,
with the `identical call` notes written in as the detector would have — the run itself had none)
and turn 8 of `153d3718` (`pool2`, the first request after the no-op edit of `formatBytes.js`
drew its `#2`). One harmless turn: turn 6 of `411812a4`, a run that passed, right after a
second `node --test`.

| recorded turn | temperature | distinct replies of 10 | parse | first call is the recorded one |
|---|---|---|---|---|
| `pool` loop | 0.2 / 0.7 / 1.0 | 1 / 1 / 1 | 10 / 10 / 10 | 10 / 10 / 10 |
| `pool2` loop | 0.2 / 0.7 / 1.0 | 1 / 1 / 1 | 10 / 10 / 10 | 10 / 10 / 10 |
| harmless | 0.2 / 0.7 / 1.0 | 1 / 2 / 2 | 10 / 10 / 10 | 10 / 9 / 9 |

The hypothesis was: at 0.2 at least nine of ten repeat the looping call, at 1.0 fewer than nine.
Refuted on both loop turns: at 1.0 all ten are the same reply to the character, the looping call
first. No reply was cut off and every `old` matched the file, so no harm showed on the harmless
turn either (the one different reply there, at 0.7 and at 1.0, rewrites the `return` line of
`formatBytes.js` instead of fixing `while`). Why, looked at afterwards and so not pre-registered:
a free prompt at 1.0 gives three different sentences out of three, so the temperature reaches
the sampler; but on the `pool2` loop turn every one of the 123 reply tokens has p ≥ 0.999, and
2.0 gives the same reply five times out of five. llama-server applies `top_p` 0.95 and `min_p`
0.05 *before* temperature (`/props`: `… top_k, typ_p, top_p, min_p, xtc, temperature`), none of
which the harness sets: when one token holds 0.999, one candidate is left by the time
temperature is applied. **On these two turns the loop is not sampling noise; the model is sure.**
With this model and this server's sampler order `repeatTemperature` could not have moved either
of them at any value it accepts; a loop turn on which a model is less sure, or another model, is
a different measurement. One reply is not a trajectory, and live the knob would already have been
hot a turn or two earlier; neither changes the arithmetic for these two.

**Would other sampler settings do it? One more request per turn, arithmetic, and not on these turns.** The same
three turns once more at temperature 0 with `top_logprobs: 40`: the reply's path and the 40 raw
candidates at each position. (Checked that they are raw: with `post_sampling_probs` the server
reports one candidate, p = 1, at each of the 123 positions of the `pool2` reply — the chain
leaves nothing to sample.) From those, D, the probability that a sampled reply leaves that path
anywhere, for temperature 1 / 1.5 / 2 × `min_p` 0.05 / 0 × `top_p` 0.95 / 1, with the chain in
the server's order or with temperature moved to the front; `top_k` 40 kept throughout.

| D at temperature 1 / 1.5 / 2 | `pool` loop | `pool2` loop | harmless |
|---|---|---|---|
| server defaults | 0 / 0 / 0 | 0 / 0 / 0 | 0.07 / 0.15 / 0.22 |
| `top_p` 1, `min_p` 0 | 0.03 / 0.13 / 0.32 | 0.002 / 0.03 / 0.17 | 0.07 / 0.16 / 0.26 |
| temperature first, the rest default | 0 / 0.05 / 0.23 | 0 / 0 / 0 | 0.07 / 0.15 / 0.22 |

Written down beforehand: no cell reaches 0.30 on both loop turns at temperature 1.5 or below.
None does at 2 either, so the live step that was to follow was not run. And where a reply
would leave the path on a loop turn is `toFixed` → `toLocale` inside the `new` text, an `old`
cut short at `"return out"`, an empty `calls`: the tool, the file and the line being edited sit
at p ≈ 1, and the alternative is the same edit, damaged. The one position in the three turns
with a real second candidate is on the harmless turn — the first token of `old`, `while` 0.93
against `return` 0.07 — and the server's defaults leave it open. That is the different reply in
the table above (0.07 at temperature 1, 0.02 at 0.7, against 1 of 10 seen at each): the
`return` rewrite was not noise. Of these three turns temperature moves only the one on which the
model hesitates, and there the other candidate is the wrong edit. So the harness got no `top_p` /
`min_p` knobs — a decision taken on two loop turns of one model, to be reopened for a model that
loops less surely — and `repeatTemperature` stays as it is, off unless asked for, for such a model.
One rule was added after seeing the data: a chosen token that is not the raw argmax was forced
by the `json_schema` grammar and counts as fixed — one position, on the harmless turn, where
the model wanted `],` at 0.965 and the grammar allowed `},`. The loop turns have none, and a
grammar can only take candidates away, so D there is an upper bound. Two loop turns, one model;
D says where a reply leaves the path, not where it goes after.

**`freshContext: 2`: three live runs.** `tuned-budget` plus `"freshContext": 2`, `pool2` at
size 7, `-c 5120`, `--max-turns 20`, `--timeout 600` (the timeout was not in the pre-registration;
the earlier arms used 420 s with 18 turns). `bench-v211-pool2-budget5120-fresh2-n3`. On this
stand 8 of the 9 recorded runs without the knob end `repeat_loop` at turn 9 or 10.

| # | verdict | turns | s | reset at turn | peak exact tokens |
|---|---|---|---|---|---|
| 1 | PASS | 13 | 194 | 7 | 3360 |
| 2 | PASS | 13 | 185 | 7 | 3367 |
| 3 | FAIL `repeat_loop` | 12 | 171 | 6 | 3333 |

The reset fired in three of three, and in all three on the third `node --test` without a file
change between — not on the looping edit, which is a no-op, an error, and so clears no count.
The hypothesis was that after the reset the model reads `src/formatBytes.js` before it edits
it, in at least two runs: it did in three of three (after 0 of 15 runs that had a stub in the
history, above). What it did with what it read differs. #1 and #2 are one run twice — the same
calls turn for turn: before the reset they had put a wrong `(n / 1024)` into the `return` line;
after it they read the file, took that back, read again, fixed `while`, and passed. In #3 the
`return` line was still the original one when the history was cleared; the model read the
file, sent the same no-op edit of that line four times, to `repeat_loop` at turn
12: the loop re-formed from a clean history in three turns. So in these runs the loop lived in the
model's reading of this file, not only in its history; a clean history got out of it where the files
gave the model something of its own to undo. Two passes of three against one of nine is a
direction, not a rate, and two of the three are one observation. `budgetTokens` stubbed again
after the reset (turn 11 in #1 and #2, turn 12 in #3), so the confound named beforehand is
there. Nothing was written under `test/`.

### A fourth: thinking on the turn after a repeat, 2026-09-20

`loop.repeatThinkTokens: N` — the turn after a turn that drew an `identical call` note is sent
with the `/no_think` line of the system prompt turned into `/think`, and with N as its token cap
instead of `backend.maxTokens`. That request only: the history keeps `/no_think`, and thinking text
never enters it. A reply the cap cuts off is retried without thinking. It needs `loop.maxRepeats`
and a `/no_think` line to flip, so it is a knob for a model with that switch (the `qwen3` family
here); a harness without the line is refused rather than left silently unchanged. Off in every
shipped harness. The idea of spending more on one step comes from Archon's per-node `effort`;
tying it to a repeat is this tool's. This one was checked before it was built, then live.

**The replay, written down beforehand.** Three recorded turns of the `freshContext` runs above,
five samples each at the recorded 0.2, window 5120: turn 9 of `6e55ad44` (the no-op edit of the
correct `return` line, after the reset — a loop turn), turn 10 of `9694eb86` (the correct repair of
a broken `return` line — a turn with no loop in it), and turn 7 of `6e55ad44`. On this server
thinking and the `json_schema` grammar coexist: the thinking arrives as `reasoning_content`, the
content still parses.

| recorded turn | `/no_think`, as recorded | `/think`, cap 1024 | `/think`, cap 2048 |
|---|---|---|---|
| loop turn | the no-op edit 5 / 5 | edits the `while` line 5 / 5 | edits the `while` line 5 / 5 |
| no-loop turn | the recorded repair 5 / 5 | cut off inside the thinking 4 / 5 | the recorded repair 3 / 5, another edit 2 / 5 |
| first turn after the reset | `list_dir` + `node --test` 5 / 5 | `node --test` 5 / 5 | `node --test` 2 / 5, `list_dir` first 3 / 5 |
| tokens per reply | 49–115 | 240–1024 | 199–1316 |

The hypothesis — on the loop turn at least four of five thinking replies are not the no-op edit —
held, and in the stricter reading too: all ten edit the line the bug is on. It is the first of
four things tried against this loop that changed this model's reply on a loop turn. Temperature
and other sampler settings did not, above; nor did one harness-written line about the rejected
call, carried across the reset — a replay of these same three turns, not written up here, in
which 45 replies of 45 were the recorded ones. The no-harm hypothesis
failed at 1024 and held at 2048 by the rule written down (an edit whose `old` is in the file and
whose `new` differs). Looked at afterwards, so not pre-registered: the two "another edit" replies
replace the broken line with `${n} ${units[i]}`, which drops `toFixed(1)` and would fail the
`'1.0 KB'` test, and their thinking checks that case and gets it wrong. Without thinking the
repair on that turn was right five times of five.

**Live, three runs**, the `freshContext` stand without `freshContext`: `pool2:7`, 5120 window,
`budgetTokens` 2670, `maxRepeats` 3, `repeatThinkTokens: 1536`. The cap was chosen by arithmetic
before the runs — prompts on this stand reach 3364 tokens, and the longest thinking reply in the
replay was 1316 — and that arithmetic did not survive:

| run | verdict | thinking turns | of them cut off at 1536 | first thinking turn | s |
|---|---|---|---|---|---|
| `d8878248` | FAIL, bench timeout at 600 s | 4 | 3 | differs: repairs the `return` line it had broken | 600 |
| `a6c0d7a4` | PASS | 1 | 0 | differs: edits the `while` line, 414 tokens | 161 |
| `48672626` | FAIL `repeat_loop` | 3 | 3 | cut off | 487 |

Written down beforehand: a thinking turn in three runs of three (held); in at least two the first
thinking turn's first call is not the repeated one (held, two of three); at least two passes (did
not hold: one). Eight thinking turns in all: two produced a call, both a different and a correct
one, and six ran to the cap with 5160–5516 characters of thinking and no call. A cut-off turn is
retried without thinking, the retry repeats, the next turn thinks again and is cut again: that
cycle took the timeout in the first run (largest prompt plus reply 5080 of 5120) and ended the
third as `repeat_loop`. Five of the eight were drawn by a repeated `node --test` alone, the other
three by the no-op edit and the test run sent with it. In the first run the turn after the
repair, sent without thinking, was again the no-op edit of the line as it had been. The three
`freshContext` runs on this stand took 171–194 s each.

Read that as: on these turns of this model a thinking turn either fit and made the right edit or
did not fit at all, and live it mostly did not fit in what a 5120 window leaves. One pass of three
against one of nine without the knob and two of three with `freshContext` is three small numbers,
not a ranking. A larger window, a cap that large, or a model that thinks shorter is a different
measurement, and the knob is there for it. One such measurement follows.

### Two more live checks, 2026-09-20

Both written down before any model time; three runs each, same model, same server build.

**`untilBash: "node --test"`, live.** The stand is the one where recorded runs claimed on a red
suite: `pool --size 8`, `tuned` (which has no `maxRepeats`), `--max-turns 40`, server `-c 32768`
as in the pool calibration. `numCtx` is not sent on this backend, and a first attempt on an 8192
server overflowed the window at turn 8 before any claim was made; it was dropped, not counted.

| run | verdict | done | turns | s | `final_check` failed / all |
|---|---|---|---|---|---|
| `472f8fa8` | PASS | `final` | 8 | 139 | 0 / 1 |
| `60551a89` | PASS | `final` | 5 | 119 | 0 / 1 |
| `0333dab0` | FAIL | `backend_error` | 17 | 440 | 8 / 8 |

Written down beforehand: no run ends `final` with its last check failed (held, three of three).
What the model does after a refusal had no threshold, only classes — repair, loop of calls, edit
of the tests — and the one run that was refused fitted none of them. In turns 3–8 it had flipped
the last line of `chunk.js` back and forth six times; at turn 9 it claimed "Fixed all failing
tests." with five tests red, was refused, and sent the byte-identical claim on each of the next
seven turns, with no tool call in between. Every refusal put the cut test output, about 1450
tokens, into the history: the prompt went from 22626 to 34190 tokens and the run ended on the
32768 window, not on `max_turns`. `maxRepeats`, as it was then, would not have ended it either:
it counted calls, and a claim has none. (It counts a failed check now — see `untilBash` above;
that change came from this run, and its own live run follows.) That is one run of this model on this task in which a refusal did not move
it; it is not a reading of what the knob does anywhere else.

**The same stand with `maxRepeats: 3`, so that a repeated failed check counts.** Same model, task,
window and server build; three runs, written down before any model time. A "noted turn" is the
model's turn right after a refusal that carries `note: check #N`.

| run | verdict | done | turns | s | `final_check` failed / all | peak prompt, tokens |
|---|---|---|---|---|---|---|
| `8c2cef49` | PASS | `final` | 5 | 124 | 0 / 1 | 4357 |
| `55ee8917` | FAIL | `backend_error` | 15 | 454 | 5 / 5 | 33281, refused by the server |
| `8fba4a07` | FAIL | `repeat_loop` | 13 | 370 | 5 / 5 | 28356 |

Written down beforehand, in two halves: a run with more than three repeated checks ends
`repeat_loop` (held in the one run where it could: `8fba4a07`, on its fifth failed check), and no
run ends on the window after consecutive failed checks (did not hold). `55ee8917` was refused at
turn 9, made calls, and one edit applied, which set the count back to zero as designed; then it
sent the same claim on turns 11–14, each refusal adding about 1450 tokens, 27480 → 33281, and the
request of turn 15 overflowed the 32768 window one check before the detector would have ended the
run. The question with no threshold — a call or the claim again on a noted turn: five noted turns
got a reply, and on none of the five did the model make a call; each time it sent the
byte-identical claim. The only calls after a refusal came after a first refusal, which carries no
note. Both failed runs had already collected identical-call notes on tool calls earlier (9 and
8), and PASS counts are not compared with the three runs above. So in these three runs the count
ended one loop of claims and came one check too late for the other, and the note moved this
model on this task zero times out of five; neither is a reading of what they do anywhere else.

**`repeatThinkTokens: 3072` in an 8192 window.** The harness of the live check above with two
coupled changes: server `-c 8192` (was 5120) and the cap at 3072 (was 1536). `pool2:7`,
`budgetTokens` 2670, `maxRepeats` 3, `--max-turns 20`, `--timeout 900`.

| run | verdict | thinking turns | of them cut off at 3072 | s |
|---|---|---|---|---|
| `e263e451` | PASS | 1 | 0 | 158 |
| `7d7f5a8b` | FAIL `repeat_loop` | 3 | 1 | 618 |
| `3e80e6ce` | FAIL, bench timeout at 900 s | 5, and a sixth the timeout cut mid-reply | 1 | 900 |

Written down beforehand: the cut-off share counts as lower only below 6 of 8 and with at least
four thinking turns. Two of the nine completed thinking turns ran to the cap, so by that rule it
was lower; the largest prompt plus reply was 6640 of 8192. All seven turns that fit made a first
call different from the repeat the note named. Seven of the nine were drawn by a repeated
`node --test` alone. Looked at afterwards, so not pre-registered: different was not repaired. One
of the seven calls made the suite green — `>` to `>=` in the `while` line, the pass. Two, in the
second run, were the same edit with an `old` that is not in the file (`n /= 1000;`), and the
second of them drew the `identical call` note and ended the run. Four, in the third run, rewrote
`formatBytes` one after another, the failing tests going 1, 2, 1, 2, until the timeout. Thinking
replies took 364–3072 tokens. One pass of three is reported and compared to nothing: no run of
this stand in an 8192 window exists without the knob.

## A second model, 2026-10-09

Everything above is Qwen3-8B. This section is the one other model: prism-ml's
`Ternary-Bonsai-2-27B` at `PQ2_0`, on prism-ml's own llama.cpp build (b10754) — mainline llama.cpp
(b11429) refuses the file, `tensor 'output.weight' has invalid ggml type 142`. Server
`-c 8192 --parallel 1 --jinja`, about 8 tokens/s, 7.7 GB resident. Its chat template is a Qwen
one, laid out like Qwen3.5's: tool calls as `<tool_call><function=…>` XML, thinking on by
default, switched by `enable_thinking`. Every arm except `bare` is a shipped harness with `backend.think: false` added
(the `/no_think` line stays in the prompt, where this template does not look for it) and, where
the table says so, another `budgetTokens`; three runs per arm. Nothing was written down before
these runs, and each budget after the first was chosen after the traces before it were read.

**The old task.** `bench --n 3`, `bare` against `tuned` with thinking off:

| harness | PASS | 95% CI | done | median turns | median s |
|---|---|---|---|---|---|
| `bare` | **3/3** | 0.44–1.00 | `final×3` | 6 | 112 |
| `tuned` + `think: false` | **3/3** | 0.44–1.00 | `final×3` | 5 | 62 |

No parse errors; every run edited `src/slugify.js` and nothing else, and the test has asserted
the leading dash since 2026-09-18, so these are full fixes. On this model the task tells the two
harnesses apart by time only.

**`pool2`.** `--size 7 --max-turns 18 --timeout 1200`, the arms of "The measurement, on `pool2`",
with thinking off. The budget is in `chars / 4` units, as everywhere in this README; "first stub"
is the first turn whose request had results dropped.

| harness | `budgetTokens` | first stub | PASS | 95% CI | done | median turns | median s | peak prompt, tokens |
|---|---|---|---|---|---|---|---|---|
| `tuned-repeat` | 0 | — | **3/3** | 0.44–1.00 | `final×3` | 6 | 231 | 6216–6293 |
| `tuned-budget` | 2670 | turn 5 | **0/3** | 0.00–0.56 | `repeat_loop×3` | 11 | 480 | 5012–5024 |
| `tuned-budget` | 4691 | never | **3/3** | 0.44–1.00 | `final×3` | 6 | 235 | 6248–6278 |
| `tuned-budget` | 4000 | turn 6 | **3/3** | 0.44–1.00 | `final×3` | 6 | 282 | 4612–4618 |

The model reads in batches. Every run of every arm reads the seven source files in one turn
(turn 3) and the seven test files in the next (turn 4), and the estimate of the history then
grows the same way in every run: about 2536 at turn 4, 3458 at turn 5, 4620 at turn 6. Turn 5 is
the one the model answers with all seven rewrites in a single batch; turn 6 checks and ends. (In
two runs without a stub, a parse error and its retry put one turn in between.)

At 2670 the first stub lands on turn 5, before the rewrites, and takes the source files the model
has just read. In all three runs it reads them again; the next request stubs those, and it reads
the tests again; turns 5–10 alternate the two batches, no edit is ever made, and the detector ends
the run at turn 11. The history never shrank below one batch of reads: the newest results cannot
be stubbed, and one batch is larger than the budget. 4691 is the same formula as on `pool2`,
fitted to an 8192 window; no run reached it, so those three are runs without the knob. 4000 sits
between turn 5 and turn 6: the stub lands on the checking turn, after the rewrites — 6729–6733
characters dropped, the estimate going from about 4630 to 2940–2990 — and all three runs end
`final` without reading anything again. What it cost was time: the stub breaks the server's
prompt cache, so turn 6 evaluated 3719 prompt tokens in 63 s against 639 in 12.6 s without it.

So on this model, on this task, what decided the outcome was not the budget but the turn on which
it first fired: before the turn that used what had been read, three loops with no edit; after it,
three passes. That is one model, one task size and three near-clone runs per arm; it does not say
what a budget does elsewhere, and none of the Qwen3-8B tables above share a row with these.

**The same question over the Qwen3-8B traces, 2026-10-10, no model time.** `analyze` over the eight
`pool2 --size 7` bench files with a budget (24 runs, 2670 or 3300) and the two Bonsai ones above. In
all 24 Qwen runs the first stub came on turn 5 and the first edit on turn 4: seven edits in one
batch, then a stub of the turn-1 `list_dir` and `node --test` output. In 18 of them the stub is tied
to those results; in the six runs of the labelled-stub variants of v2.10, whose stub text this code
does not write, it is `unmatched` and only its size is known. So on that model the budget never
fired before the edit turn, and what it decided cannot be the turn. The runs lost on
`src/formatBytes.js`, the one unit new to the model, repeating an edit whose `old` and `new` were
identical until `repeat_loop`. What split them was whether the model read that file again after its
read had been stubbed: five of six such runs passed, two of the other eighteen did — and for the six
`unmatched` runs among those eighteen a reread cannot be counted at all. Bonsai 2 with 2670: stub on
turn 5, no edit, rereads from turn 5 on, fourteen paths; with 4000: stub on turn 6, after the edit
on turn 5. Near-clone runs, two models, one task: the reread goes with the pass, and nothing here
says it causes it.
