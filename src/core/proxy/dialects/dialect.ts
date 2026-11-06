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
  /** Run key and raw first-user text of a scrubbed request body. */
  keyOf(payload: object): { key: string; taskText: string }
  /** Results after the request's last assistant message, in order, matched to that turn's calls. */
  toolResults(assistant: any, after: any[], calls: ToolCall[]): ToolResultSeen[]
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

/** JSON with object keys sorted, so the same message serialized twice compares equal. */
export function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`
  return JSON.stringify(v) ?? 'null'
}
