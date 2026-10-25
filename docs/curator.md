**English** · [Українська](curator.uk.md)

# The curator tasks

`sift`, `triage` and `judge` are the [llm-harness-builder](../README.md) tasks taken from a real
use: a news curator that reads a feed, picks the posts worth a closer look, and turns them into a
digest. Every number below is one model on one step: Gemma 12B (Q4_K_XL, `temperature: 0`) on one
llama-server, n=3 per row unless said. None of it is a property of a harness knob.

## The pipeline

The curator runs in steps: triage (which new posts are worth fetching), fetch, screen (one call
per post with a JSON schema: PASS with quotes, or DROP with a reason), sift (split the screener's
verdicts into what goes on and what is only reported), then the digest. Posts a person added by
hand skip triage: a person chose them.

A step moves to a local model only after it is measured on that step. Screen was moved first, as
one request with a schema in the curator's own code. Sift, triage and judge are the next three,
measured here as `bench` tasks.

## The three tasks

### sift

The workdir holds `screen.jsonl`, one screener verdict per line. The model writes `pass.jsonl` with
the PASS lines exactly as they are and `drops.txt` with `<id>: <reason>` per DROP. The check
compares every character of the content (key order and spacing aside) against the package's
fixture, not against the workdir's copy. Fixture: `examples-sift/screen.jsonl`, synthetic, in the
bytes the screener prints, with traps for a careless grep. `--size N` takes its first N lines (1–12).

### triage

The workdir holds `posts.txt`: per post a `--- <id> · <date> · <source>` line, the title, a
summary and the URL. The model writes `triage.jsonl`, one `{"id", "verdict", "reason"}` per post,
KEEP or DROP. Fixture: `examples-triage/posts.jsonl`, twelve synthetic posts (ids `8001`–`8012`)
with a key: KEEP, DROP, EITHER (left open), or DUP (of one pair with the same URL, exactly one is
kept). The key never reaches the workdir. The check wants every shown id once, numbers as ids, and
the key's verdict on every keyed post.

### judge

The same judgement as one request: the posts are in the task text, there is no tool, and the
final answer is one JSON object, an id per key and `{"reason", "verdict"}` per value. The task
carries a schema for that answer (`verdictSchema`): one required key per shown id and no other, so
an answer held to it cannot miss a post, repeat one or invent one. Same fixture, same key, same
rules sentence as `triage`.

### Running them

    llm-harness-builder bench harnesses/bare.json harnesses/curator.json --task sift --size 8 --n 3
    llm-harness-builder bench harnesses/bare.json harnesses/curator.json --task triage --size 12 --n 3
    llm-harness-builder bench harnesses/curator-judge.json --task judge --size 12 --n 3

`curator` is the file step: `list_dir`, `read_file`, `write_file`, `bash`, reasoning off,
`maxRepeats: 3`, and a system prompt that says to move text between files with shell tools
instead of retyping it. `curator-judge` has no tools, `enforceSchema: true` and `maxTurns: 2`, so
the schema goes with the request. A step of your own takes the same route through
`run --answer-schema <file.json>` (see "A schema for the final answer" under
[Harness file](../README.md#harness-file)).

## What was measured

- **sift, size 8.** `bare` 3 of 3, `tuned` 2 of 3 (its FAIL was a reply cut at its 1024-token cap,
  reasoning included), `curator` 3 of 3, repeated 3 of 3 after `maxRepeats` was added. Under
  `curator` every run went file to file with `jq` in one `bash` call, nothing retyped, reasoning on
  0 of 15 turns, about 20 s a run.
- **triage, size 12, synthetic.** Every run wrote the same twelve verdicts whatever the harness:
  8 of 9 keyed decisions right, no false DROP, one false KEEP (`8002`, a release announcement).
  The harness changed the time and the reasoning, not one verdict. After the rules sentences were
  edited, the same fixture went 10 of 10 and then 9 of 9.
- **triage on the real feed, a backtest.** 12 past days rebuilt into windows, 147 posts, 67 of them
  reached a digest. Five rounds, `curator` in the agent loop for the first four, prompt edited
  between them; topics lost went 8 (and 14 with no verdict, a window cut at `maxTokens`), 8, 4
  (and 2), then 2 (and 7). Along the way the model, at temperature 0: re-read a one-post file
  until the run ended; after the repeat stop, wrote a keyword script in place of the judgement;
  wrote ids nobody had shown it; wrote ids as strings, so the window counted as no verdict. Which
  of these happened flipped with a one-sentence edit of the prompt. Told to keep every hand-added
  post, it dropped 15 of 105; taking those posts out of triage made it 0 by construction.
- **judge on the same windows.** One request with the schema: 10 of 10 windows ended in one turn,
  every post got a verdict, no invented or missing id. 3 of 67 topics were still lost. The form got
  fixed; the judgement did not, it only became visible in full. On the synthetic fixture
  `curator-judge` was 0 of 3 by the check, 8 of 9 keyed in each run: a second article about one
  report dropped as a duplicate, against the sentence that says it is not one.
- **Verdict logprobs, a spike.** The judge requests replayed with `logprobs`: every DROP was at
  0.995 or more, the three wrong ones included. A cut at 0.90 fixed beforehand recovered 0 topics.
  The token probability did not tell a lost topic from the rest: a null for this model, this
  schema order (reason first) and this step.

## Lessons

- **An instruction is not a mechanism.** "Keep every hand-added post" lowered the drops and never
  made them zero; routing those posts past the model did. A stop on repeated calls ended the loop
  and gained no verdict; a schema per id made a missing or invented id impossible.
- **A false KEEP is cheap, a false DROP is a lost topic.** A KEEP costs one more fetch and one more
  screen call on a local model; a DROP is silent, and nothing downstream sees the post again. Count
  the DROPs of the posts that mattered, not the PASS rate.
- **A synthetic fixture checks form, not the real feed.** The prompt that was 10 of 10 on twelve
  synthetic posts lost 8 of 67 real topics the same day. The fixture is for the obvious cases and
  for the shape of the output; only a backtest says what a step loses.
- **A judgement step wants one request with a schema, not an agent loop.** With files and tools the
  model had ways to fail that had nothing to do with judging. `sift` is the opposite case: moving
  text file to file is work for tools, and there the loop was 3 of 3.

## Reading a run in the UI

Open the bench in `serve` and press a run. A `sift` or `triage` run shows the usual strip above the
trace, one column per request, its layers growing with the tool results. A `judge` run has one
column: one request, system prompt and task text only, no tool descriptions and no history. Its
`llm_request` payload carries the schema (`response_format` on an OpenAI-style server), and the
`done` event holds the answer. Where a step's columns grow turn by turn, there is a loop to read;
where there is one, the only thing left to read is the verdicts.
