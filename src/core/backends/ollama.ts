import { BackendError, readJson, type Backend, type ChatRequest, type NormalizedResponse, type NormalizedToolCall } from './types.js'

export class OllamaBackend implements Backend {
  constructor(private baseUrl: string, private fetchFn: typeof fetch = fetch) { this.baseUrl = baseUrl.replace(/\/+$/, '') }

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
      model: req.model, messages, stream: false,
      options: { temperature: req.temperature, ...(req.numCtx ? { num_ctx: req.numCtx } : {}) },
      ...(req.tools ? { tools: req.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) } : {}),
      ...(req.responseSchema ? { format: req.responseSchema } : {}),
    }
  }

  async send(payload: unknown, signal?: AbortSignal): Promise<NormalizedResponse> {
    const r = await this.fetchFn(`${this.baseUrl}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal })
    if (!r.ok) throw new BackendError(`POST /api/chat: ${r.status}`, await r.text())
    const j = (await readJson(r, 'POST /api/chat')) as any
    const msg = j.message ?? {}
    const toolCalls: NormalizedToolCall[] = (msg.tool_calls ?? []).map((tc: any) => {
      const fn = tc.function ?? {}
      const args = fn.arguments
      if (typeof args === 'object' && args !== null) return { name: fn.name, args }
      return { name: fn.name, args: {}, argsError: `arguments is not an object: ${JSON.stringify(args)}` }
    })
    return {
      content: msg.content ?? '', reasoning: msg.thinking || undefined, toolCalls,
      usage: j.prompt_eval_count !== undefined ? { promptTokens: j.prompt_eval_count ?? 0, completionTokens: j.eval_count ?? 0 } : undefined,
      raw: j,
    }
  }
}
