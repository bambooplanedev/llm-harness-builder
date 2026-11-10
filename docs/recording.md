**English** · [Українська](recording.uk.md)

# Recording another agent

`proxy` sits between an agent you did not write and llama-server. It forwards every request as it
came and writes each conversation it sees to `runs/<id>.jsonl`, the file `run` writes. The Runs list
then shows that agent's requests and replies, and `replay` takes any of its turns.

    llm-harness-builder proxy --upstream http://127.0.0.1:8080 --port 8090 --name opencode

Your own API formats and agent connections can be added with files: see [Own dialects and connections](https://github.com/bambooplanedev/llm-harness-builder/blob/main/docs/dialects.md).

Start it in the directory `serve` runs in (both use `./runs`) and give the agent
`http://127.0.0.1:8090/v1` as its OpenAI base URL. `--upstream` is the server root, not its `/v1`.
Every path goes through; with the built-in dialects only `POST …/chat/completions` and `POST /v1/messages` are recorded. Ctrl-C (or `kill`) ends every
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
