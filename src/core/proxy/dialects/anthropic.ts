// src/core/proxy/dialects/anthropic.ts — Anthropic messages, as the recording proxy reads them.
import { collectAnthropic, fromAnthropicJson } from '../../backends/anthropic.js'
import { jsonChunks } from '../../backends/types.js'
import { lastTurn, messagesOf, modelOf, stable, textOf, type Dialect, type ToolResultSeen } from './dialect.js'

/** The text, thinking and tool-argument deltas of a Messages SSE text, joined in order; lines that do not parse are skipped. */
const deltaText = (sse: string) => sse.split('\n').map(l => {
  if (!l.startsWith('data:')) return ''
  try { const d = JSON.parse(l.slice(5)).delta; return [d?.text, d?.thinking, d?.partial_json].find(x => typeof x === 'string') ?? '' } catch { return '' }
}).join('')

export const anthropic: Dialect = {
  id: 'anthropic',
  label: 'POST /v1/messages',
  /** /v1/messages/count_tokens is not a turn. */
  matches: (method, pathname) => method === 'POST' && pathname.endsWith('/v1/messages'),

  /**
   * Text only: the top-level system without its first block (Claude Code's attribution block changes) and the
   * first user text, since Claude Code moves cache_control markers between turns.
   */
  keyOf(payload) {
    const msgs = messagesOf(payload)
    const user = msgs.find(m => m?.role === 'user')
    const system = (payload as { system?: unknown }).system
    const userText = textOf(Array.isArray(user?.content) ? user.content.filter((b: any) => b?.type === 'text') : user?.content)
    return { key: stable([Array.isArray(system) ? textOf(system.slice(1)) : textOf(system), userText]), taskText: userText, len: msgs.length, model: modelOf(payload) }
  },

  /** The tool_result blocks of the user messages after the assistant message, matched to the calls by tool_use_id. */
  toolResults(payload, calls) {
    const out: ToolResultSeen[] = []
    for (const m of lastTurn(payload)?.after ?? []) {
      if (m?.role !== 'user' || !Array.isArray(m.content)) continue
      for (const b of m.content) {
        const call = b?.type === 'tool_result' && b.tool_use_id !== undefined ? calls.find(c => c.backendId === b.tool_use_id) : undefined
        if (call) out.push({ call, output: textOf(b.content), ...(b.is_error === true ? { error: true as const } : {}) })
      }
    }
    return out
  },

  async readReply(chunks, contentType) {
    if (/^application\/json/i.test(contentType)) return fromAnthropicJson(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    return collectAnthropic(jsonChunks({ body: (async function* () { yield* chunks })() }, anthropic.label, 'data:'))
  },

  /** A cut stream has no message_stop, which collectAnthropic refuses: the text its deltas carried, joined; nothing readable is undefined. */
  partial: async chunks => deltaText(Buffer.concat(chunks).toString('utf8')) || undefined,
}
