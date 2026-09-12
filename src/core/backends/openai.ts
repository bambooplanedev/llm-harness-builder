import { BackendError, defaultFetch, readJson, jsonChunks, type Backend, type ChatRequest, type Delta, type FetchLike, type NormalizedResponse, type NormalizedToolCall } from './types.js'

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
      ...(req.tools ? { tools: req.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) } : {}),
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

  async send(payload: unknown, signal?: AbortSignal, onDelta?: (d: Delta) => void): Promise<NormalizedResponse> {
    const r = await this.fetchFn(`${this.baseUrl}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal })
    if (!r.ok) throw new BackendError(`POST /chat/completions: ${r.status}`, await r.text())
    let content = '', reasoning = '', finish: string | undefined, usage: any, last: any = {}
    const calls: { id?: string; name?: string; args: string }[] = []
    for await (const c of jsonChunks(r, 'POST /chat/completions', 'data:')) {
      last = c
      const ch = c.choices?.[0], d = ch?.delta ?? {}
      if (d.content) { content += d.content; onDelta?.({ content: d.content }) }
      const rz = d.reasoning_content ?? d.reasoning
      if (rz) { reasoning += rz; onDelta?.({ reasoning: rz }) }
      for (const tc of d.tool_calls ?? []) {
        const t = (calls[tc.index ?? 0] ??= { args: '' })
        if (tc.id) t.id = tc.id
        if (tc.function?.name) t.name = tc.function.name
        if (tc.function?.arguments) t.args += tc.function.arguments
      }
      if (ch?.finish_reason) finish = ch.finish_reason
      if (c.usage) usage = c.usage
    }
    const toolCalls: NormalizedToolCall[] = calls.map(t => {
      try {
        const args = JSON.parse(t.args)
        if (typeof args !== 'object' || args === null) throw new Error('arguments is not an object')
        return { backendId: t.id, name: t.name ?? '', args }
      } catch (e) { return { backendId: t.id, name: t.name ?? '', args: {}, argsError: `${(e as Error).message}: ${t.args}` } }
    })
    const message = { role: 'assistant', content, reasoning_content: reasoning || undefined, tool_calls: calls.map(t => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.args } })) }
    return {
      content, reasoning: reasoning || undefined, toolCalls,
      usage: usage ? { promptTokens: usage.prompt_tokens ?? 0, completionTokens: usage.completion_tokens ?? 0 } : undefined,
      truncated: finish === 'length' || undefined,
      raw: { ...last, choices: [{ index: 0, message, finish_reason: finish ?? null }], usage },
    }
  }
}
