// src/core/proxy/dialects/openai-chat.ts — OpenAI chat completions, as the recording proxy reads them.
import { collect, fromJson } from '../../backends/openai.js'
import { jsonChunks } from '../../backends/types.js'
import { lastTurn, messagesOf, modelOf, stable, textOf, type Dialect, type ToolResultSeen } from './dialect.js'

export const openaiChat: Dialect = {
  id: 'openai-chat',
  label: 'POST /chat/completions',
  matches: (method, pathname) => method === 'POST' && pathname.endsWith('/chat/completions'),

  /** The first system-like message and the first user message, whole. */
  keyOf(payload) {
    const msgs = messagesOf(payload)
    const user = msgs.find(m => m?.role === 'user')
    const sys = msgs.find(m => m?.role === 'system' || m?.role === 'developer')
    return { key: stable([sys ?? null, user ?? null]), taskText: textOf(user?.content), len: msgs.length, model: modelOf(payload) }
  },

  /**
   * One per tool message. The i-th call the assistant message echoes is the i-th call recorded on the replied
   * turn, so ids the agent invented (the server sent none) and ids reused across turns both match.
   */
  toolResults(payload, calls) {
    const last = lastTurn(payload)
    if (!last) return []
    const { assistant, after } = last
    const out: ToolResultSeen[] = []
    const echoed: unknown[] = Array.isArray(assistant.tool_calls) ? assistant.tool_calls.map((t: any) => t?.id) : []
    for (const m of after) {
      if (m?.role !== 'tool') continue
      const i = echoed.indexOf(m.tool_call_id)
      const call = i < 0 ? undefined : calls[i]
      if (call) out.push({ call, output: textOf(m.content) })
    }
    return out
  },

  async readReply(chunks, contentType) {
    if (/^application\/json/i.test(contentType)) return fromJson(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    return collect(jsonChunks({ body: (async function* () { yield* chunks })() }, openaiChat.label, 'data:'))
  },

  partial: async (chunks, contentType) => (await openaiChat.readReply(chunks, contentType).catch(() => undefined))?.content ?? '',
}
