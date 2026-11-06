// src/core/proxy/dialects/dialect.ts — what the recording proxy needs to know about one API format.
import type { ToolCall } from '../../events.js'
import type { NormalizedResponse } from '../../backends/types.js'

export type ToolResultSeen = { call: ToolCall; output: string; error?: true }
export type Dialect = {
  id: string
  /** The route as errors name it. */
  label: string
  /** Whether a request is recorded as this format; the rest pass through unrecorded. */
  matches(method: string | undefined, pathname: string): boolean
  /** Run key, raw first-user text, message count and model name ('' when absent) of a scrubbed request body. */
  keyOf(payload: object): { key: string; taskText: string; len: number; model: string }
  /** Results after the request's last assistant message, in order, matched to that turn's calls; [] without an assistant message. */
  toolResults(payload: object, calls: ToolCall[]): ToolResultSeen[]
  /** The reply as the backend itself would read it: a JSON body or an SSE stream, by content-type. */
  readReply(chunks: Buffer[], contentType: string): Promise<NormalizedResponse>
  /** Decoded text of a cut reply, never raw SSE. OpenAI: '' when nothing reads; Anthropic: undefined. */
  partial(chunks: Buffer[], contentType: string): Promise<string | undefined>
}

/** Text of an OpenAI message `content`: a string, an array of parts (the text ones count), or null. */
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(p => (p && typeof p.text === 'string' ? p.text : '')).filter(Boolean).join('\n')
  return ''
}

export { stable } from '../../diff.js'

/** The `messages` array of a request body, [] when absent. */
export function messagesOf(payload: object): any[] {
  const raw = (payload as { messages?: unknown }).messages
  return Array.isArray(raw) ? raw : []
}

/** The model name of a request body, '' when absent. */
export const modelOf = (payload: object): string => String((payload as { model?: unknown }).model ?? '')

/** The last assistant message of a request and the messages after it; undefined without one. */
export function lastTurn(payload: object): { assistant: any; after: any[] } | undefined {
  const msgs = messagesOf(payload)
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i]?.role === 'assistant') return { assistant: msgs[i], after: msgs.slice(i + 1) }
  return undefined
}
