# Your own dialects and connections for `proxy`

The recording proxy reads an agent's requests in one of a few API formats (its *dialects*) and tells agents apart
by a few headers (its *connections*). Both can be replaced or extended with files of your own.

**An own dialect is code, and it runs with full trust.** A `.mjs` file you pass with `--dialect` is imported into
the proxy's process: it sees `process.env`, the network and your files, as any program you run does. The checks
here catch mistakes, not a hostile author. Only load files you wrote or read, and keep them outside any repository
an agent you are recording can edit: an agent that rewrites the file gets its code run at the next start. A
connection is plain JSON and runs nothing.

## Passing the files

    llm-harness-builder proxy --upstream=http://127.0.0.1:11434 --port=8090 --name=ollama \
      --dialect=/abs/path/ollama-chat.mjs --connection=/abs/path/my-harness.json

Both flags can be repeated. Paths must be absolute; a relative path, a missing file, a directory, or a file
without the `.mjs` (dialect) or `.json` (connection) extension is refused at start, naming the flag's file. The
extension is checked on the real file, after symlinks. After the usual start lines the proxy prints one line per
own file, in flag order:

    dialect ollama-chat from /abs/path/ollama-chat.mjs
    connection my-harness from /abs/path/my-harness.json (replaces built-in)

The suffix appears when the file replaced a built-in of the same id or name. The path is never written to
`runs/`.

The package ships a working pair in `examples-dialects/` (`ollama-chat.mjs`, for Ollama's native `/api/chat`, and
`my-harness.json`). Copy them out of the package folder and edit the copies.

## Proxy tab

`serve` has a Proxy tab that starts the same proxy for you: fill in the upstream, a port (0 means any free port) and
a name, add the absolute paths of your own dialect and connection files (one field each, `+ more` for another), and
press Start. The rules are those of the CLI above, and the same trust applies: an own dialect runs with full trust.
Each running proxy gets a card with its start lines, its recorded sessions (click one to open it in Workbench), the
tail of its stderr, and Stop. A bad file shows its error under the form and starts nothing. The tab needs a `serve`
started from the command line, as Bench does.

## Where each part of a request came from

The "sources" block in a turn's inspector, and the A/B group comparison, label each part of a recorded request. The
labels come from the request text alone: nothing reads files on your disk. So what gets a label depends on what the
harness writes into the request.

| What the harness sends | Label |
|---|---|
| A top-level `system`, or leading `system`/`developer` messages | `harness` · `system prompt` |
| `tools` | `harness` · `N tools` |
| A user text block that does not start with `<`, in a message without tool results | `you` |
| A text block that starts with any other `<tag>` | `harness` · `reminder` |
| A block that starts with `<system-reminder>` and has lines of the form `Contents of /abs/path (what it is):` | each section: `file` · its file name |
| Tool calls, the model's replies, and user text next to tool results | `history` |
| Tool results | `history` · `result of <tool>` |
| Claude Code's SessionStart hook, `# Environment`, skills list, `Skill` tool | `hook`, `skill <name>`, `environment`, … |

The last row is specific to Claude Code. For another harness, the text it adds from your files (its rules file,
memory, skills) is labelled `harness` or `you`, not with a file name. Two things to do about that:

- **A harness you wrote yourself:** wrap each file it adds in the same markers Claude Code uses, and the file gets
  its own label:

  ```text
  <system-reminder>
  Contents of /path/to/project/RULES.md (project rules):
  …the file's text…
  </system-reminder>
  ```

  The header must be on a line of its own, start with an absolute or `~` path, and end in `):`. A section runs to
  the next such header or to `</system-reminder>`. The label is the file name, or `.folder/name` when the file sits
  in a folder whose name starts with a dot.
- **A harness you can't change:** find what a file contributes with the group comparison. Record a few runs
  without the file (or with its old text) and mark them A, then a few with it and mark them B. "compare groups"
  shows only the lines that every run of one side has and no run of the other, so the file's lines show up there,
  labelled with the chunk they sit in (for another harness usually `reminder` or `you`, not the file name). It
  compares whole lines: a one-word edit shows as the whole changed line, and a line the other side also has is
  not shown.

## The dialect file

A `.mjs` file whose `export default` is an object:

```js
export default {
  id: 'my-format',                 // /^[a-z0-9][a-z0-9-]{0,63}$/; the id of a built-in replaces it
  label: 'POST /my/route',         // how errors name the route
  matches(method, pathname) {},    // boolean, synchronously
  keyOf(payload) {},               // { key, taskText, len, model }, synchronously
  toolResults(payload, calls) {},  // an array, synchronously
  async readReply(chunks, contentType) {},  // NormalizedResponse
  async partial(chunks, contentType) {},    // string or undefined
}
```

- `id`: also the dialect's name in log lines. Two own files with one id are refused. Built-in ids are
  `openai-chat` and `anthropic`.
- `matches(method, pathname)`: whether a request is recorded as this format. `method` may be `undefined`;
  `pathname` has no query. Requests no dialect matches pass through unrecorded. Own dialects are asked first, in
  flag order, then the built-ins.
- `keyOf(payload)`: `payload` is the parsed request body with keys already scrubbed. Return:
  - `key`: a string; requests with the same `key` belong to one run. Use what stays fixed across a conversation,
    such as the system prompt and the first user message.
  - `taskText`: the first user text, as the agent typed it.
  - `len`: an integer >= 0, how long the conversation is so far (usually the message count). A request
    with fewer messages than the last one the run saw starts a new run (a connection's `session` hint replaces this
    rule: the run is then that connection, session and agent).
  - `model`: the model name, `''` when the body has none.
- `toolResults(payload, calls)`: the results this request carries for the calls of the previous reply. `calls` are
  the `ToolCall`s recorded on that reply. Return `[]` when the request has no earlier assistant message. Each item is
  a `ToolResultSeen`.
- `readReply(chunks, contentType)`: `chunks` are the reply body's bytes, `contentType` the reply header (`''` if
  absent). Parse a JSON body or a stream by it, and return a `NormalizedResponse`.
- `partial(chunks, contentType)`: called when the reply was cut. Return the text decoded so far, never raw stream
  syntax, or `undefined` when nothing reads.

The shapes, in TypeScript:

```ts
type ToolCall = { callId: string; name: string; args: Record<string, unknown>; backendId?: string }
type ToolResultSeen = { call: ToolCall; output: string; error?: true }
type NormalizedResponse = {
  content: string                 // required; '' for a reply with only tool calls
  toolCalls: { name: string; args: Record<string, unknown>; backendId?: string; argsError?: string }[]  // required
  reasoning?: string
  usage?: { promptTokens: number; completionTokens: number }
  truncated?: boolean             // the server stopped at its token limit
  raw: unknown                    // the reply as parsed, kept for the record
}
```

`callId` is assigned by the proxy. `backendId` is the id the server gave the call, if it gave one; a format
without ids (like Ollama's) leaves it out and `toolResults` matches results to `calls` by order.

The shapes of an own dialect's answers are checked on every call. A wrong shape, such as a Promise from `keyOf`,
`len: NaN`, or a `readReply` without `toolCalls`, counts as a throw. Whatever a dialect throws, the request is
forwarded unchanged and the agent gets the upstream's reply. The proxy logs a line naming the dialect and method:
`matches` throwing means "not this format"; `keyOf` or `toolResults` throwing records nothing and leaves the
sessions as they were; `readReply` throwing leaves an `error` event in the turn; `partial` throwing counts as
`undefined`.

Until 1.0 this contract may change; a change is announced in the README.

## The connection file

A `.json` object that says how to recognise one agent and clean its task text:

```json
{
  "name": "my-harness",
  "hints": { "session": "x-my-harness-session" },
  "taskStrip": [["<context>", "</context>"]],
  "hint": "for my harness: send x-my-harness-session with every request"
}
```

- `name` (required): the same pattern as a dialect `id`.
- `hints` (required): which request header carries which fact. Allowed keys: `session`, `agent`, `parent`,
  `agentType`, `requestClass`. Values are lowercase header names that carry no key: `authorization`,
  `proxy-authorization`, `x-api-key`, `api-key`, `x-goog-api-key` and `cookie` are refused. A header value counts
  when it is 1 to 128 printable ASCII characters. A request with none of a connection's headers falls through to
  the next connection.
- `taskStrip` (required, may be `[]`): pairs `[open, close]` of non-empty literal strings. Each span between them,
  tags included, is cut from the task text (an unclosed one runs to the end).
- `auxiliary`, `compaction` (optional strings): the values of the `requestClass` header that mark a side request
  (a title, a summary: a note in the session's main run, no turn) and a context compaction (a turn marked by a
  note). `auxiliary` needs `hints.requestClass` and `hints.session`; `compaction` needs only `hints.requestClass`.
- `hint` (optional string): a line printed at start for people; `{port}` is replaced with the proxy's port.

Any other key is refused, naming it.

## Replacement and order

- An own file with the id or name of a built-in replaces it; the start line says so. Two own files with one id or
  name are refused.
- Dialects are tried in this order: own, in flag order; then the built-ins that were not replaced.
- Connections are tried with hints first: own hinted ones (flag order), then built-in hinted ones, then exactly one
  connection with empty `hints`, the fallback. The built-in fallback is `generic`. An own connection with empty
  `hints` is refused unless it is named `generic` and so replaces it; after merging there must be exactly one
  fallback.

## Checking your file

1. Start the proxy with the file and an `--upstream` you can reach. A refused file stops the start with a one-line
   reason and a non-zero exit code. Check that the `dialect ... from ...` line appears.
2. Send one request by hand (`curl`) or from the agent, with a tool round if the format has one.
3. Read `runs/<id>.jsonl`: the first line's `task`, the `tool_call` and `tool_result` events, and the turn count
   should be what the agent did. A line in the proxy's log that starts with `not recorded:` names the dialect, the
   method and the reason a request was passed through.

The repository's `tests/own-files.test.ts` does this for the Ollama example against a fake upstream; its pattern is
a good template for a test of your own.
