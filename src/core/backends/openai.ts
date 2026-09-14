import { BackendError, defaultFetch, readJson, type Backend, type ChatRequest, type FetchLike, type NormalizedResponse, type NormalizedToolCall } from './types.js'

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
      model: req.model, messages, temperature: req.temperature, stream: false,
      ...(req.tools ? { tools: req.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) } : {}),
      ...(req.responseSchema ? { response_format: { type: 'json_schema', json_schema: { name: 'harness', schema: req.responseSchema } } } : {}),
    }
  }

  async send(payload: unknown, signal?: AbortSignal): Promise<NormalizedResponse> {
    const r = await this.fetchFn(`${this.baseUrl}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal })
    if (!r.ok) throw new BackendError(`POST /chat/completions: ${r.status}`, await r.text())
    const j = (await readJson(r, 'POST /chat/completions')) as any
    const msg = j.choices?.[0]?.message ?? {}
    const toolCalls: NormalizedToolCall[] = (msg.tool_calls ?? []).map((tc: any) => {
      const fn = tc.function ?? {}
      try {
        const args = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : fn.arguments
        if (typeof args !== 'object' || args === null) throw new Error('arguments is not an object')
        return { backendId: tc.id, name: fn.name, args }
      } catch (e) { return { backendId: tc.id, name: fn.name, args: {}, argsError: `${(e as Error).message}: ${fn.arguments}` } }
    })
    return {
      content: msg.content ?? '', reasoning: msg.reasoning_content ?? msg.reasoning ?? undefined, toolCalls,
      usage: j.usage ? { promptTokens: j.usage.prompt_tokens ?? 0, completionTokens: j.usage.completion_tokens ?? 0 } : undefined,
      truncated: j.choices?.[0]?.finish_reason === 'length' || undefined,
      raw: j,
    }
  }
}
