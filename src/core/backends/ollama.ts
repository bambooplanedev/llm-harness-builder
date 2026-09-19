import { BackendError, defaultFetch, readJson, jsonChunks, toolsField, type Backend, type ChatRequest, type Delta, type FetchLike, type NormalizedResponse, type NormalizedToolCall } from './types.js'

export class OllamaBackend implements Backend {
  constructor(private baseUrl: string, private fetchFn: FetchLike = defaultFetch) { this.baseUrl = baseUrl.replace(/\/+$/, '') }

  async listModels(): Promise<string[]> {
    const r = await this.fetchFn(`${this.baseUrl}/api/tags`)
    if (!r.ok) throw new BackendError(`GET /api/tags: ${r.status}`, await r.text())
    const j = (await readJson(r, 'GET /api/tags')) as { models: { name: string }[] }
    return j.models.map(m => m.name)
  }

  buildPayload(req: ChatRequest): unknown {
    const messages = req.messages.map(m => {
      if (m.role === 'assistant') return {
        role: 'assistant', content: m.content,
        ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map(c => ({ function: { name: c.name, arguments: c.args } })) } : {}),
      }
      if (m.role === 'tool') return { role: 'tool', tool_name: m.name, content: m.content }
      return { role: m.role, content: m.content }
    })
    return {
      model: req.model, messages, stream: true,
      options: { temperature: req.temperature, ...(req.numCtx ? { num_ctx: req.numCtx } : {}), ...(req.maxTokens ? { num_predict: req.maxTokens } : {}) },
      ...toolsField(req.tools),
      ...(req.responseSchema ? { format: req.responseSchema } : {}),
    }
  }

  async send(payload: unknown, signal?: AbortSignal, onDelta?: (d: Delta) => void): Promise<NormalizedResponse> {
    const r = await this.fetchFn(`${this.baseUrl}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal })
    if (!r.ok) throw new BackendError(`POST /api/chat: ${r.status}`, await r.text())
    let content = '', thinking = '', last: any = {}
    const rawCalls: any[] = []
    for await (const c of jsonChunks(r, 'POST /api/chat', '')) {
      last = c
      const m = c.message ?? {}
      if (m.content) { content += m.content; onDelta?.({ content: m.content }) }
      if (m.thinking) { thinking += m.thinking; onDelta?.({ reasoning: m.thinking }) }
      if (m.tool_calls) rawCalls.push(...m.tool_calls)
    }
    const toolCalls: NormalizedToolCall[] = rawCalls.map((tc: any) => {
      const fn = tc.function ?? {}
      const args = fn.arguments
      if (typeof args === 'object' && args !== null) return { name: fn.name, args }
      return { name: fn.name, args: {}, argsError: `arguments is not an object: ${JSON.stringify(args)}` }
    })
    return {
      content, reasoning: thinking || undefined, toolCalls,
      usage: last.prompt_eval_count !== undefined ? { promptTokens: last.prompt_eval_count ?? 0, completionTokens: last.eval_count ?? 0 } : undefined,
      truncated: last.done_reason === 'length' || undefined,
      raw: { ...last, message: { role: 'assistant', content, thinking: thinking || undefined, tool_calls: rawCalls } },
    }
  }
}
