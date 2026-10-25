import { BackendError, jsonChunks, readJson, usageFrom, text, tokenCount, type Backend, type ChatRequest, type Delta, type FetchLike, type NormalizedResponse, type NormalizedToolCall, type ServerInfo } from './types.js'
import { parseCalls } from './openai.js'

/** A count for the prompt sum: absent is 0, anything but a non-negative number makes the sum NaN, which usageFrom refuses. */
const part = (x: unknown): number => tokenCount(x) ?? NaN

/** Folds the SSE events of one Messages reply into a NormalizedResponse; `native` is its `content` blocks in their order.
 *  Shared with the proxy, so the two cannot read a stream differently. */
export async function collectAnthropic(chunks: AsyncIterable<any>, onDelta?: (d: Delta) => void): Promise<NormalizedResponse> {
  let content = '', reasoning = '', message: any = {}, usage: any, stop: string | undefined, category: string | undefined, done = false
  // Indexed by the server's `index`, which only a small non-negative integer may be: nothing is keyed by server data.
  const blocks: any[] = [], json: string[] = []
  for await (const c of chunks) {
    const i = c?.index
    if (('index' in Object(c) || String(c?.type).startsWith('content_block')) && !(Number.isInteger(i) && i >= 0 && i < 128)) continue
    if (c?.type === 'message_start') {
      message = c.message ?? {}
      if (message.usage && typeof message.usage === 'object') usage = { ...message.usage }
    } else if (c?.type === 'content_block_start' && c.content_block && typeof c.content_block === 'object') {
      blocks[i] = { ...c.content_block }
      json[i] = ''
    } else if (c?.type === 'content_block_delta' && blocks[i]) {
      const d = c.delta ?? {}, b = blocks[i]
      if (d.type === 'text_delta' && text(d.text)) { b.text = (b.text ?? '') + d.text; content += d.text; onDelta?.({ content: d.text }) }
      else if (d.type === 'thinking_delta' && text(d.thinking)) { b.thinking = (b.thinking ?? '') + d.thinking; reasoning += d.thinking; onDelta?.({ reasoning: d.thinking }) }
      else if (d.type === 'signature_delta' && text(d.signature)) b.signature = (b.signature ?? '') + d.signature
      else if (d.type === 'input_json_delta' && text(d.partial_json)) json[i] += d.partial_json
    } else if (c?.type === 'message_delta') {
      if (text(c.delta?.stop_reason)) stop = c.delta.stop_reason
      category = text(c.delta?.stop_details?.category)?.slice(0, 100)
      if (c.usage && typeof c.usage === 'object') usage = { ...usage ?? {}, ...c.usage }
    } else if (c?.type === 'message_stop') done = true
  }
  if (!done) throw new BackendError('POST /v1/messages: stream ended before message_stop')
  if (stop === 'refusal') throw new BackendError(category ? `refused: ${category}` : 'refused')
  const toolCalls: NormalizedToolCall[] = []
  const native = blocks.flatMap((b, i) => {
    // An empty text block is a 400 when sent back; drop_block covers the signature it may have covered.
    if (!b || (b.type === 'text' && !b.text)) return []
    if (b.type !== 'tool_use') return [b]
    // A call with no arguments may send no input_json_delta at all: then it is {}.
    const [call] = parseCalls([{ id: text(b.id), name: text(b.name), args: json[i] || JSON.stringify(b.input ?? {}) }])
    toolCalls.push(call)
    return [{ ...b, input: call.args }]
  })
  const { id, model, role, input_transformations } = message
  return {
    content, reasoning: reasoning || undefined, toolCalls, native,
    // No usage object in either event is no usage: 0 would price a run at $0.
    usage: usage && usageFrom(part(usage.input_tokens) + part(usage.cache_read_input_tokens) + part(usage.cache_creation_input_tokens),
      usage.output_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens),
    truncated: stop === 'max_tokens' || undefined,
    raw: { id, model, role, content: native, stop_reason: stop ?? null, usage, ...(input_transformations !== undefined ? { input_transformations } : {}) },
  }
}

/** A non-streamed Messages reply, read by turning it into the events of a stream: one reader for both shapes, so they cannot drift. */
export function fromAnthropicJson(m: unknown): Promise<NormalizedResponse> {
  const j = m as any
  if (j?.type === 'error') throw new BackendError(`POST /v1/messages: ${[j.error?.type, j.error?.message].filter(Boolean).join(': ') || 'error'}`, JSON.stringify(m))
  const blocks: any[] = Array.isArray(j?.content) ? j.content : []
  const events = [
    { type: 'message_start', message: { ...j, content: [] } },
    ...blocks.flatMap((b, index) => {
      const delta = b?.type === 'text' ? { type: 'text_delta', text: b.text }
        : b?.type === 'thinking' ? { type: 'thinking_delta', thinking: b.thinking }
        : b?.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(b.input ?? {}) } : undefined
      const empty = b?.type === 'text' ? { ...b, text: '' } : b?.type === 'thinking' ? { ...b, thinking: '' } : b?.type === 'tool_use' ? { ...b, input: {} } : b
      return [{ type: 'content_block_start', index, content_block: empty }, ...delta ? [{ type: 'content_block_delta', index, delta }] : []]
    }),
    { type: 'message_delta', delta: { stop_reason: j?.stop_reason, stop_details: j?.stop_details } },
    { type: 'message_stop' },
  ]
  return collectAnthropic((async function* () { yield* events })())
}

/** A token count from the server: only a positive integer is one. */
const count = (x: unknown): number | undefined => Number.isInteger(x) && (x as number) > 0 ? x as number : undefined

export class AnthropicBackend implements Backend {
  partialList?: boolean

  /** `baseUrl`: the server root, under which the requests go to /v1/... `keyName`: the variable the key came from, for the words of a 401. */
  constructor(private baseUrl: string, private fetchFn: FetchLike, private key: string, private keyName: string) { this.baseUrl = baseUrl.replace(/\/+$/, '') }

  /** Every request here: the key goes as x-api-key, which undici keeps on a redirect to another origin (it strips only
   *  authorization), so no redirect is followed at all. Nothing about the API redirects. */
  private keyed(path: string, init: NonNullable<Parameters<FetchLike>[1]> = {}) {
    return this.fetchFn(`${this.baseUrl}${path}`, { ...init, headers: { ...init.headers, 'x-api-key': this.key, 'anthropic-version': '2026-10-21' }, redirect: 'manual' })
  }

  /** A non-2xx in words a person can act on, with the API's own error type and message when the body is its error shape. */
  private async failed(what: string, r: { status: number; text(): Promise<string> }): Promise<BackendError> {
    const body = await r.text().catch(() => '')
    if (r.status === 401) return new BackendError(`${what}: 401 (the key in ${this.keyName} was refused)`, body)
    if (r.status >= 300 && r.status < 400) return new BackendError(`${what}: ${r.status} (redirect not followed: with a key, requests go only to baseUrl)`, body)
    let e: any
    try { e = JSON.parse(body) } catch { /* not the API's error shape */ }
    const type = e?.type === 'error' ? text(e.error?.type) : undefined, message = type && text(e.error?.message)
    return new BackendError(`${what}: ${r.status}${type ? ` ${type}` : ''}${message ? `: ${message}` : ''}`, body)
  }

  /** One page of 1000: a longer list sets partialList, and preflight then gives no verdict. */
  async listModels(): Promise<string[]> {
    const r = await this.keyed('/v1/models?limit=1000')
    if (!r.ok) throw await this.failed('GET /v1/models', r)
    const j = await readJson(r, 'GET /v1/models')
    this.partialList = j?.has_more === true
    return (Array.isArray(j?.data) ? j.data : []).flatMap((m: any) => typeof m?.id === 'string' ? [m.id] : [])
  }

  async serverInfo(model: string): Promise<ServerInfo | undefined> {
    try {
      const r = await this.keyed(`/v1/models/${encodeURIComponent(model)}`)
      if (!r.ok) return undefined
      const m = await readJson(r, 'GET /v1/models/{id}'), nCtx = count(m?.max_input_tokens), maxOutput = count(m?.max_tokens)
      // No temperature: on this API version no model takes one, so capabilities do not list it.
      const takes = { temperature: false as const, ...(m?.capabilities?.structured_outputs?.supported === false ? { responseSchema: false as const } : {}) }
      return { ...(nCtx ? { nCtx } : {}), ...(maxOutput ? { maxOutput } : {}), takes, takesFrom: 'Anthropic API 2026-10-21', router: false }
    } catch { return undefined }
  }

  buildPayload(req: ChatRequest): unknown {
    const first = req.messages.findIndex(m => m.role === 'system'), system = req.messages[first]?.content
    const messages: any[] = []
    for (const [n, m] of req.messages.entries()) {
      if (n === first) continue
      if (m.role === 'tool') {
        // All results of one turn go in one user message: a run of tool messages is one turn's.
        const r = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content, ...(m.isError ? { is_error: true } : {}) }
        const last = messages.at(-1)
        if (last?.role === 'user' && Array.isArray(last.content) && last.content[0]?.type === 'tool_result') last.content.push(r)
        else messages.push({ role: 'user', content: [r] })
      } else if (m.role === 'assistant') {
        if (m.native?.length) { messages.push({ role: 'assistant', content: m.native }); continue }
        // A blank text block is a 400, and so is an assistant with no blocks: a reply with neither text nor calls gets a marker.
        const calls = (m.toolCalls ?? []).map(c => ({ type: 'tool_use', id: c.backendId ?? c.name, name: c.name, input: c.args }))
        const said = m.content.trim() ? [{ type: 'text', text: m.content }] : calls.length ? [] : [{ type: 'text', text: '(empty reply)' }]
        messages.push({ role: 'assistant', content: [...said, ...calls] })
      } else messages.push({ role: 'user', content: m.content })
    }
    return {
      model: req.model, max_tokens: req.maxTokens, ...(system !== undefined ? { system } : {}), messages, stream: true,
      // Always on: a harness resends the same prefix every turn.
      cache_control: { type: 'ephemeral' },
      // No temperature: on 2026-10-21 no model takes one. drop_block: budget stubs edit old tool_results, after which a
      // thinking block would be a 400; disabled with block_binding is a 400 too.
      thinking: req.think === false ? { type: 'disabled' } : { type: 'adaptive', display: 'summarized', block_binding: { prefix_mismatch_behavior: 'drop_block' } },
      ...(req.tools ? { tools: req.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters })) } : {}),
      ...(req.responseSchema ? { output_config: { format: { type: 'json_schema', schema: req.responseSchema } } } : {}),
    }
  }

  async send(payload: unknown, signal?: AbortSignal, onDelta?: (d: Delta) => void): Promise<NormalizedResponse> {
    // block_binding is a beta, and only adaptive thinking carries it.
    const beta: Record<string, string> = (payload as any)?.thinking?.type === 'adaptive' ? { 'anthropic-beta': 'thinking-binding-controls-2026-08-01' } : {}
    const r = await this.keyed('/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', ...beta }, body: JSON.stringify(payload), signal })
    if (!r.ok) throw await this.failed('POST /v1/messages', r)
    return collectAnthropic(jsonChunks(r, 'POST /v1/messages', 'data:'), onDelta)
  }
}
