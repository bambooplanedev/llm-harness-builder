**English** · [Українська](README.uk.md)

# Exercise 2: make bare pass

Needs a model, local or cloud. Read [Safety](../README.md#safety-before-any-exercise-with-a-model)
first. About 20–40 minutes.

Start from `bare` under its own name, `lab-start`, and change it until `bench` passes with it.

## The starter

In a folder where `serve` already ran, `harnesses/bare.json` is there:

    cp harnesses/bare.json start.json

Otherwise download it:

    curl -fLO https://raw.githubusercontent.com/bambooplanedev/llm-harness-builder/main/docs/lab/02-make-bare-pass/start.json

The two files differ only in `name` and `description`.

## The rule

Change only `start.json`. No other file, no extra flags to `bench` besides the ones below.

## The check

    npx llm-harness-builder bench start.json --task slug --n 3 --timeout 600

In a container with Ollama on the host, add `--base-url http://host.docker.internal:11434`.

On the cloud ([Setup](../README.md#cloud)), start the container with `-e OPENROUTER_API_KEY` so the
key is in it, and add the four flags:

    npx llm-harness-builder bench start.json --task slug --n 3 --timeout 600 \
      --kind openai --base-url https://openrouter.ai/api/v1 \
      --api-key-env OPENROUTER_API_KEY --model nvidia/nemotron-3-super-120b-a12b:free

A hosted API refuses `backend.think`, so a file that sets it does not run there. Three runs of up to
15 turns each are up to 45 model requests, near the free tier's 50 a day.

The exercise is passed at 2 or more PASS out of 3. Three runs are noisy: 2 of 3 has a 95% Wilson
interval of 0.21–0.94, so a pass says your file can work, not how often.

**Time.** At most 30 minutes: three runs of at most 600 s each. A run that reaches 600 s is stopped
and counts as a FAIL (`aborted`). Why 600 and not the default 1800: the only passing `bare` run in
the example bench took 252 s (qwen3:8b on Ollama, RTX 4070 laptop, n = 2: this model on this task),
so 600 leaves room for a slow pass and keeps the worst case at half an hour instead of an hour and a
half.

## Hints

<details>
<summary>Hint 1</summary>

How did the run in exercise 1 end? Was the trouble an edit that failed, or a reply that never came?

</details>

<details>
<summary>Hint 2</summary>

Compare `start.json` with [`tuned-nothink.json`](../../../harnesses/tuned-nothink.json), or press `⇄`
in the example bench. Which of the knobs that differ are about one reply of the model rather than
about the tools?

</details>

<details>
<summary>Hint 3</summary>

One key of `backend` caps the length of one reply. Find it in the README's
[Harness file](https://github.com/bambooplanedev/llm-harness-builder#harness-file) table. Does
`start.json` set it?

</details>

Solution: `solution.md` (not written yet: it waits for a measurement).
