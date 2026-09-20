import { fetch as undiciFetch, Agent } from 'undici'

/** The subset of fetch the adapters use; lets tests pass a fake and keeps undici's types out of the public surface. */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string>; body?: AsyncIterable<Uint8Array> | null }>
// `body` is typed as AsyncIterable, not ReadableStream: undici's stream is the stream/web one, the global type
// without `lib` is the DOM one, and the two do not unify; AsyncIterable covers both and `new Response` in tests.

// A local model can take minutes before the first byte (model load, prompt eval, a long <think>).
// undici's defaults kill any request without headers within 300 s; that is the "fetch failed" of v1.
const patient = new Agent({ headersTimeout: 0, bodyTimeout: 0 })
export const defaultFetch: FetchLike = (url, init) => undiciFetch(url, { ...init, dispatcher: patient })

export type Usage = { promptTokens: number; completionTokens: number }

/** One streamed piece of the assistant turn; either field may be absent. */
export type Delta = { content?: string; reasoning?: string }

export type ToolSchema = { name: string; description: string; parameters: Record<string, unknown> }

export type NormalizedToolCall = {
  backendId?: string
  name: string
  args: Record<string, unknown>
  /** Set when the backend returned arguments that are not a JSON object; args is {} then. */
  argsError?: string
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string; isToolResult?: boolean }
  | { role: 'assistant'; content: string; toolCalls?: NormalizedToolCall[] }
  | { role: 'tool'; content: string; toolCallId: string; name: string; isToolResult: true }

/** The `tools` field of a request body, empty when the harness sends no tools. Both adapters send the same OpenAI-style shape. */
export const toolsField = (tools?: ToolSchema[]) =>
  tools ? { tools: tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) } : {}

export type ChatRequest = {
  model: string
  messages: ChatMessage[]
  tools?: ToolSchema[]
  responseSchema?: Record<string, unknown>
  temperature: number
  numCtx?: number
  /** Cap on generated tokens, thinking included; absent = the server's default, which is the rest of the window. */
  maxTokens?: number
}

export type NormalizedResponse = {
  content: string
  reasoning?: string
  toolCalls: NormalizedToolCall[]
  usage?: Usage
  /** Backend stopped at max tokens (finish_reason/done_reason "length"); the content is incomplete. */
  truncated?: boolean
  raw: unknown
}

export interface Backend {
  listModels(): Promise<string[]>
  /** Pure: turns a ChatRequest into the exact JSON body that will be sent. */
  buildPayload(req: ChatRequest): unknown
  /** Sends a payload produced by buildPayload. Throws BackendError on non-2xx / network failure. */
  send(payload: unknown, signal?: AbortSignal, onDelta?: (d: Delta) => void): Promise<NormalizedResponse>
  /** Exact prompt token count for a payload from buildPayload; undefined when the server cannot count. */
  countTokens?(payload: unknown, signal?: AbortSignal): Promise<number | undefined>
}

export class BackendError extends Error {
  constructor(message: string, public body?: string) { super(message) }
}

/** Reads a JSON body; a non-JSON body becomes a BackendError carrying the raw text. */
export async function readJson(r: { text(): Promise<string> }, what: string): Promise<any> {
  const text = await r.text()
  try { return JSON.parse(text) } catch { throw new BackendError(`${what}: response is not JSON`, text.slice(0, 2000)) }
}

/**
 * JSON chunks of a streamed 2xx body, one per line, with `prefix` ("data:" for SSE, "" for NDJSON) stripped.
 * `[DONE]`, blank, comment (`:`) and unparsable lines are skipped. A chunk carrying `error` and no payload
 * throws BackendError with it. A body that yields no chunk at all throws "response is not an event stream".
 */
export async function* jsonChunks(r: { body?: AsyncIterable<Uint8Array> | null }, what: string, prefix: string): AsyncGenerator<any> {
  const dec = new TextDecoder()
  let buf = '', head = '', any = false
  const lines = async function* () {
    for await (const chunk of r.body ?? []) {
      const text = dec.decode(chunk, { stream: true })
      buf += text
      if (head.length < 2000) head += text.slice(0, 2000 - head.length)
      let i
      while ((i = buf.indexOf('\n')) !== -1) { yield buf.slice(0, i); buf = buf.slice(i + 1) }
    }
    buf += dec.decode()
    if (buf) yield buf
  }
  for await (const raw of lines()) {
    const line = raw.trimEnd()
    if (!line || line.startsWith(':') || !line.startsWith(prefix)) continue
    const text = line.slice(prefix.length).trim() // SSE allows "data:" with or without the space
    if (text === '[DONE]') break
    let c: any
    try { c = JSON.parse(text) } catch { continue }
    if (c.error !== undefined && c.choices === undefined && c.message === undefined)
      throw new BackendError(`${what}: ${typeof c.error === 'string' ? c.error : c.error?.message ?? 'stream error'}`, text)
    any = true
    yield c
  }
  if (!any) throw new BackendError(`${what}: response is not an event stream`, head.slice(0, 2000))
}
