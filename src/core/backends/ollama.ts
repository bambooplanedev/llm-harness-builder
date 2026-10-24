import { BackendError, defaultFetch, readJson, jsonChunks, toolsField, usageFrom, type Backend, type ChatRequest, type Delta, type FetchLike, type NormalizedResponse, type NormalizedToolCall, type ServerInfo } from './types.js'

export class OllamaBackend implements Backend {
  constructor(private baseUrl: string, private fetchFn: FetchLike = defaultFetch) { this.baseUrl = baseUrl.replace(/\/+$/, '') }

  async listModels(): Promise<string[]> {
    const r = await this.fetchFn(`${this.baseUrl}/api/tags`)
    if (!r.ok) throw new BackendError(`GET /api/tags: ${r.status}`, await r.text())
    const j = (await readJson(r, 'GET /api/tags')) as { models: { name: string }[] }
    return j.models.map(m => m.name)
  }

  /** What the model takes, from its `capabilities` in POST /api/show; no window (that is the num_ctx the harness sends). Never throws. */
  async serverInfo(model: string): Promise<ServerInfo | undefined> {
    try {
      const r = await this.fetchFn(`${this.baseUrl}/api/show`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model }) })
      if (!r.ok) return undefined
      const c = (await readJson(r, 'POST /api/show'))?.capabilities
      if (!Array.isArray(c)) return { router: false }
      const takes = { ...(c.includes('tools') ? {} : { tools: false as const }), ...(c.includes('thinking') ? {} : { think: false as const }) }
      return { takes, takesFrom: 'Ollama /api/show', router: false }
    } catch { return undefined }
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
      model: req.model, messages, stream: true, ...(req.think !== undefined ? { think: req.think } : {}),
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
      const piece = typeof m.content === 'string' ? m.content : ''
      if (piece) { content += piece; onDelta?.({ content: piece }) }
      const th = typeof m.thinking === 'string' ? m.thinking : ''
      if (th) { thinking += th; onDelta?.({ reasoning: th }) }
      if (Array.isArray(m.tool_calls)) rawCalls.push(...m.tool_calls)
    }
    const toolCalls: NormalizedToolCall[] = rawCalls.map((tc: any) => {
      const fn = tc?.function ?? {}
      const name = typeof fn.name === 'string' ? fn.name : String(fn.name ?? '')
      const args = fn.arguments
      if (typeof args === 'object' && args !== null) return { name, args }
      return { name, args: {}, argsError: `arguments is not an object: ${JSON.stringify(args)}` }
    })
    return {
      content, reasoning: thinking || undefined, toolCalls,
      usage: last.prompt_eval_count !== undefined ? usageFrom(last.prompt_eval_count, last.eval_count) : undefined,
      truncated: last.done_reason === 'length' || undefined,
      raw: { ...last, message: { role: 'assistant', content, thinking: thinking || undefined, tool_calls: rawCalls } },
    }
  }
}
