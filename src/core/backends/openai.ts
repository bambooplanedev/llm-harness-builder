import { BackendError, defaultFetch, readJson, jsonChunks, toolsField, usageFrom, type Backend, type ChatRequest, type Delta, type FetchLike, type NormalizedResponse, type NormalizedToolCall, type ServerInfo } from './types.js'

type AccCall = { id?: string; name?: string; args: string }

function parseCalls(calls: AccCall[]): NormalizedToolCall[] {
  return calls.map(t => {
    try {
      const args = JSON.parse(t.args)
      if (typeof args !== 'object' || args === null) throw new Error('arguments is not an object')
      return { backendId: t.id, name: t.name ?? '', args }
    } catch (e) { return { backendId: t.id, name: t.name ?? '', args: {}, argsError: `${(e as Error).message}: ${t.args}` } }
  })
}

const usageOf = (u: any) => u && typeof u === 'object' ? usageFrom(u.prompt_tokens, u.completion_tokens) : undefined
/** Text a server sent, only when it is text: a number, an array or an object in its place is dropped, not printed. */
const text = (x: unknown): string | undefined => typeof x === 'string' && x ? x : undefined

/** A stream that failed after its 200, OpenRouter's way: a chunk whose finish_reason is "error", the error beside the
 *  choices. jsonChunks' rule (an error and no choices) does not see it, and the reply would read as an empty one. */
function streamFailed(c: any): BackendError {
  const e = c?.error
  const said = typeof e === 'string' && e ? e : typeof e?.message === 'string' && e.message ? e.message : 'stream ended with finish_reason "error"'
  return new BackendError(`POST /chat/completions: ${said}`, JSON.stringify(c))
}

/** Folds the chunks of one streamed reply into a NormalizedResponse; `raw` is the reply as one non-streamed message would carry it. The proxy reads replies with this too, so the two cannot read a stream differently. */
export async function collect(chunks: AsyncIterable<any>, onDelta?: (d: Delta) => void): Promise<NormalizedResponse> {
  let content = '', reasoning = '', finish: string | undefined, usage: any, last: any = {}
  const calls: AccCall[] = []
  for await (const c of chunks) {
    last = c
    const ch = c.choices?.[0], d = ch?.delta ?? {}
    if (ch?.finish_reason === 'error') throw streamFailed(c)
    const piece = text(d.content)
    if (piece) { content += piece; onDelta?.({ content: piece }) }
    const rz = text(d.reasoning_content) ?? text(d.reasoning)
    if (rz) { reasoning += rz; onDelta?.({ reasoning: rz }) }
    for (const tc of Array.isArray(d.tool_calls) ? d.tool_calls : []) {
      const t = (calls[tc?.index ?? 0] ??= { args: '' })
      if (tc?.id) t.id = String(tc.id)
      if (tc?.function?.name) t.name = String(tc.function.name)
      const a = tc?.function?.arguments
      if (typeof a === 'string') t.args += a
      else if (a && typeof a === 'object') t.args += JSON.stringify(a)
    }
    if (ch?.finish_reason) finish = ch.finish_reason
    if (c.usage) usage = c.usage
  }
  const message = { role: 'assistant', content, reasoning_content: reasoning || undefined, tool_calls: calls.map(t => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.args } })) }
  return {
    content, reasoning: reasoning || undefined, toolCalls: parseCalls(calls), usage: usageOf(usage),
    truncated: finish === 'length' || undefined,
    raw: { ...last, choices: [{ index: 0, message, finish_reason: finish ?? null }], usage },
  }
}

/** A non-streamed reply (`stream: false`) as the same NormalizedResponse; `raw` is the body as it came. */
export function fromJson(body: any): NormalizedResponse {
  // Mirrors jsonChunks' rule: a 2xx body carrying only `error` is a failure, not an empty reply.
  if (body?.error !== undefined && body?.choices === undefined && body?.message === undefined)
    throw new BackendError(`POST /chat/completions: ${typeof body.error === 'string' ? body.error : body.error?.message ?? 'stream error'}`, JSON.stringify(body))
  if (body?.choices?.[0]?.finish_reason === 'error') throw streamFailed(body)
  const ch = body?.choices?.[0], m = ch?.message ?? {}
  const calls: AccCall[] = (Array.isArray(m.tool_calls) ? m.tool_calls : []).map((t: any) => ({
    id: t?.id ? String(t.id) : undefined, name: t?.function?.name ? String(t.function.name) : undefined,
    args: typeof t?.function?.arguments === 'string' ? t.function.arguments : JSON.stringify(t?.function?.arguments ?? {}),
  }))
  return {
    content: typeof m.content === 'string' ? m.content : '', reasoning: text(m.reasoning_content) ?? text(m.reasoning),
    toolCalls: parseCalls(calls), usage: usageOf(body?.usage), truncated: ch?.finish_reason === 'length' || undefined, raw: body,
  }
}

export class OpenAIBackend implements Backend {
  constructor(private baseUrl: string, private fetchFn: FetchLike = defaultFetch) { this.baseUrl = baseUrl.replace(/\/+$/, '') }

  async listModels(): Promise<string[]> {
    const r = await this.fetchFn(`${this.baseUrl}/models`)
    if (!r.ok) throw new BackendError(`GET /models: ${r.status}`, await r.text())
    const j = (await readJson(r, 'GET /models')) as { data: { id: string }[] }
    return j.data.map(m => m.id)
  }

  buildPayload(req: ChatRequest): unknown {
    const messages = req.messages.map(m => {
      if (m.role === 'assistant') return {
        role: 'assistant', content: m.content,
        ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map(c => ({ id: c.backendId ?? c.name, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) } : {}),
      }
      if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content }
      return { role: m.role, content: m.content }
    })
    return {
      model: req.model, messages, temperature: req.temperature, stream: true, stream_options: { include_usage: true },
      ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
      ...(req.think !== undefined ? { chat_template_kwargs: { enable_thinking: req.think } } : {}),
      ...toolsField(req.tools),
      ...(req.responseSchema ? { response_format: { type: 'json_schema', json_schema: { name: 'harness', schema: req.responseSchema } } } : {}),
    }
  }

  /** llama-server only: /apply-template renders the chat template (tools included), /tokenize counts it. Both live at the server root, not under /v1. */
  async countTokens(payload: unknown, signal?: AbortSignal): Promise<number | undefined> {
    const root = this.baseUrl.replace(/\/v1$/, '')
    const post = async (path: string, body: unknown) => {
      const r = await this.fetchFn(`${root}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal })
      if (!r.ok) throw new BackendError(`POST ${path}: ${r.status}`, await r.text())
      return readJson(r, `POST ${path}`)
    }
    try {
      const { prompt } = await post('/apply-template', payload)
      if (typeof prompt !== 'string') return undefined
      const { tokens } = await post('/tokenize', { content: prompt, add_special: true, model: (payload as { model?: string }).model })
      return Array.isArray(tokens) ? tokens.length : undefined
    } catch { return undefined }
  }

  /**
   * llama-server only: GET /props at the server root. A router answers it for itself, with n_ctx 0, and
   * for one of its models at /props?model= — which loads that model if it is not loaded yet.
   */
  async serverInfo(model: string): Promise<ServerInfo | undefined> {
    const root = this.baseUrl.replace(/\/v1$/, '')
    const props = async (q = '') => {
      const r = await this.fetchFn(`${root}/props${q}`)
      return r.ok ? readJson(r, 'GET /props') : undefined
    }
    const info = (p: any): ServerInfo => ({
      ...(p?.default_generation_settings?.n_ctx > 0 ? { nCtx: p.default_generation_settings.n_ctx } : {}),
      ...(typeof p?.build_info === 'string' ? { build: p.build_info } : {}),
    })
    try {
      const top = await props()
      if (!top) return undefined
      if (top.role !== 'router') return { ...info(top), router: false }
      const one = await props(`?model=${encodeURIComponent(model)}`).catch(() => undefined)
      return { ...info(top), ...info(one), router: true }
    } catch { return undefined }
  }

  async send(payload: unknown, signal?: AbortSignal, onDelta?: (d: Delta) => void): Promise<NormalizedResponse> {
    const r = await this.fetchFn(`${this.baseUrl}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal })
    if (!r.ok) throw new BackendError(`POST /chat/completions: ${r.status}`, await r.text())
    // A recorded `stream: false` turn (a proxy trace) comes back as one JSON body; everything else is read as a stream.
    if (/^application\/json/i.test(r.headers?.get('content-type') ?? '')) return fromJson(await readJson(r, 'POST /chat/completions'))
    return collect(jsonChunks(r, 'POST /chat/completions', 'data:'), onDelta)
  }
}
