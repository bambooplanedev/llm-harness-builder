import { fetch as undiciFetch, Agent } from 'undici'
import type { ReasoningEffort } from '../config.js'

/** The subset of fetch the adapters use; lets tests pass a fake and keeps undici's types out of the public surface. */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal; redirect?: 'follow' | 'error' | 'manual' },
) => Promise<{ ok: boolean; status: number; text(): Promise<string>; body?: AsyncIterable<Uint8Array> | null; headers?: { get(name: string): string | null } }>
// `body` is typed as AsyncIterable, not ReadableStream: undici's stream is the stream/web one, the global type
// without `lib` is the DOM one, and the two do not unify; AsyncIterable covers both and `new Response` in tests.

// A local model can take minutes before the first byte (model load, prompt eval, a long <think>).
// undici's defaults kill any request without headers within 300 s; that is the "fetch failed" of v1.
const patient = new Agent({ headersTimeout: 0, bodyTimeout: 0 })
export const defaultFetch: FetchLike = (url, init) => undiciFetch(url, { ...init, dispatcher: patient })

/** promptTokens is the whole prompt; the cache counts are the parts of it served from or written to the cache. */
export type Usage = { promptTokens: number; completionTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }

/** A count as a server sent it: absent is 0, as it always was; anything but a finite non-negative number is not one. */
export const tokenCount = (x: unknown): number | undefined =>
  x === undefined || x === null ? 0 : typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : undefined

/** Usage from the two counts a server sent, or none at all: a server's text must never reach the terminal as a count,
 *  two lines above an approval question. */
export function usageFrom(prompt: unknown, completion: unknown, cacheRead?: unknown, cacheWrite?: unknown): Usage | undefined {
  const p = tokenCount(prompt), c = tokenCount(completion)
  if (p === undefined || c === undefined) return undefined
  // Unlike the two counts, an absent or bad cache count is no field at all: 0 would claim the server said "no hit".
  const count = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : undefined
  const r = count(cacheRead), w = count(cacheWrite)
  return { promptTokens: p, completionTokens: c, ...(r === undefined ? {} : { cacheReadTokens: r }), ...(w === undefined ? {} : { cacheWriteTokens: w }) }
}

/** Text a server sent, only when it is text: a number, an array or an object in its place is dropped, not printed. */
export const text = (x: unknown): string | undefined => typeof x === 'string' && x ? x : undefined

/** A 2xx body or chunk carrying only `error` is a failure, not an empty reply. */
export function errorOnly(what: string, c: any, raw: string): BackendError | undefined {
  if (c?.error !== undefined && c?.choices === undefined && c?.message === undefined)
    return new BackendError(`${what}: ${typeof c.error === 'string' ? c.error : c.error?.message ?? 'stream error'}`, raw, errorFields(c.error))
}

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
  /** `native`: the reply's own blocks (Anthropic), sent back verbatim, since a thinking signature covers all before it. */
  | { role: 'assistant'; content: string; toolCalls?: NormalizedToolCall[]; native?: unknown[] }
  | { role: 'tool'; content: string; toolCallId: string; name: string; isToolResult: true; isError?: boolean }

/** The `tools` field of a request body, empty when the harness sends no tools. Both adapters send the same OpenAI-style shape. */
export const toolsField = (tools?: ToolSchema[]) =>
  tools ? { tools: tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) } : {}

export type ChatRequest = {
  model: string
  messages: ChatMessage[]
  tools?: ToolSchema[]
  responseSchema?: Record<string, unknown>
  /** Absent = not sent (a model that takes none). */
  temperature?: number
  numCtx?: number
  /** Cap on generated tokens, thinking included; absent = the server's default, which is the rest of the window. */
  maxTokens?: number
  /** The chat template's thinking switch (llama-server `chat_template_kwargs.enable_thinking`, Ollama `think`); absent = not sent, the model's default. */
  think?: boolean
  /** Hosted reasoning effort (OpenAI `reasoning_effort`, OpenRouter `reasoning.effort`); absent = not sent. */
  reasoningEffort?: ReasoningEffort
}

export type NormalizedResponse = {
  content: string
  reasoning?: string
  toolCalls: NormalizedToolCall[]
  usage?: Usage
  /** Backend stopped at max tokens (finish_reason/done_reason "length"); the content is incomplete. */
  truncated?: boolean
  /** Anthropic: the reply's `content` blocks as they came, for ChatMessage.native. */
  native?: unknown[]
  raw: unknown
}

/** What a server says about itself. `nCtx`: the window a request gets there; `maxOutput`: the most a reply may generate
 *  (Anthropic); `router`: llama-server serving several models, one of which the request names. `takes`: a knob the
 *  server said the model does not take is `false`, no entry is unknown; `takesFrom` names where that was said. */
export type ServerInfo = { nCtx?: number; maxOutput?: number; build?: string; router?: boolean; takes?: Partial<Record<Knob, false>>; takesFrom?: string }

export type Knob = 'temperature' | 'maxTokens' | 'think' | 'reasoningEffort' | 'tools' | 'responseSchema'

export interface Backend {
  listModels(): Promise<string[]>
  /** Pure: turns a ChatRequest into the exact JSON body that will be sent. */
  buildPayload(req: ChatRequest): unknown
  /** Sends a payload produced by buildPayload. Throws BackendError on non-2xx / network failure. */
  send(payload: unknown, signal?: AbortSignal, onDelta?: (d: Delta) => void): Promise<NormalizedResponse>
  /** Exact prompt token count for a payload from buildPayload; undefined when the server cannot count. */
  countTokens?(payload: unknown, signal?: AbortSignal): Promise<number | undefined>
  /** The server's window and build for `model`; undefined when the server does not say. Never throws. */
  serverInfo?(model: string): Promise<ServerInfo | undefined>
  /** Set by listModels when the server said its list goes on past what it sent (OpenRouter's total_count): then a model
   *  missing from it may still be there, and preflight gives no verdict. */
  partialList?: boolean
}

export class BackendError extends Error {
  /** The HTTP status, or the numeric `error.code` of an in-stream / 2xx-body error; never read from message text. */
  status?: number
  /** The error carried `metadata.reasons` (OpenRouter moderation). */
  moderated?: boolean
  /** Seconds the server asked to wait (Retry-After). */
  retryAfter?: number
  /** Set by sendRetrying: the error came after part of the reply had streamed, so it was not tried again. */
  midReply?: boolean
  constructor(message: string, public body?: string, extra: { status?: number; moderated?: boolean; retryAfter?: number } = {}) {
    super(message)
    if (extra.status !== undefined) this.status = extra.status
    if (extra.moderated) this.moderated = true
    if (extra.retryAfter !== undefined) this.retryAfter = extra.retryAfter
  }
}

/** What an `error` object (a body's or a chunk's) says in structure: a numeric `code` is a status, `metadata.reasons` is moderation. */
export function errorFields(e: any): { status?: number; moderated?: boolean } {
  return {
    ...Number.isInteger(e?.code) ? { status: e.code } : {},
    ...e?.metadata?.reasons !== undefined ? { moderated: true } : {},
  }
}

/** The structured part of a non-2xx: its HTTP status, the moderation flag from the JSON body, and Retry-After in seconds. */
export function httpFields(r: { status: number; headers?: { get(name: string): string | null } }, body: string): { status: number; moderated?: boolean; retryAfter?: number } {
  let parsed: any
  try { parsed = JSON.parse(body) } catch { /* not JSON */ }
  const ra = Number(r.headers?.get('retry-after'))
  return {
    status: r.status,
    ...errorFields(parsed?.error).moderated ? { moderated: true } : {},
    ...r.headers?.get('retry-after') && Number.isFinite(ra) && ra >= 0 ? { retryAfter: ra } : {},
  }
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
    const failed = errorOnly(what, c, text)
    if (failed) throw failed
    any = true
    yield c
  }
  if (!any) throw new BackendError(`${what}: response is not an event stream`, head.slice(0, 2000))
}

/** A status that ends an evolve instead of becoming a FAIL: a refused key, no credits, a refusal that is not moderation,
 *  a rate limit that outlasted the retries. Decided from the numeric status only, never from message text. */
export const isStop = (e: { status?: number; moderated?: boolean }): boolean =>
  e.status === 401 || e.status === 402 || e.status === 429 || (e.status === 403 && !e.moderated)

/** false when the signal fired first. */
const pause = (ms: number, signal?: AbortSignal): Promise<boolean> => new Promise(res => {
  if (signal?.aborted) return res(false)
  const on = () => { clearTimeout(t); res(false) }
  const t = setTimeout(() => { signal?.removeEventListener('abort', on); res(true) }, ms)
  signal?.addEventListener('abort', on, { once: true })
})

/** backend.send, with a 429 tried again up to 3 times after Retry-After (at most 300 s; else 60 s; `waitMs` overrides both). Not after
 *  a delta: the caller has shown it. An abort during a wait throws the 429 itself, so the run ends as the stop. */
export async function sendRetrying(backend: Backend, payload: unknown, signal?: AbortSignal, onDelta?: (d: Delta) => void, waitMs?: number): Promise<NormalizedResponse> {
  for (let retries = 0; ; retries++) {
    let streamed = false
    try {
      return await backend.send(payload, signal, d => { streamed = true; onDelta?.(d) })
    } catch (e) {
      if (e instanceof BackendError && streamed) e.midReply = true
      if (!(e instanceof BackendError) || e.status !== 429 || streamed || retries === 3 || signal?.aborted) throw e
      if (!await pause(waitMs ?? Math.min(e.retryAfter ?? 60, 300) * 1000, signal)) throw e
    }
  }
}
