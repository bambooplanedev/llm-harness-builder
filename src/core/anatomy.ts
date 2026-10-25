import { normalizeRequest } from './normalize.js'
import type { Usage } from './backends/types.js'
import type { HarnessEvent } from './events.js'

/**
 * Where the prompt of one request went: four layers split by characters, scaled to the server's prompt count
 * when there is one. Pure and browser-safe (the trace view imports it): one value import, types otherwise.
 */
export type Layer = 'system' | 'tools' | 'history' | 'results'
export const LAYERS: readonly Layer[] = ['system', 'tools', 'history', 'results']
export type Anatomy = {
  format: 'openai' | 'anthropic'
  chars: Record<Layer, number>
  /** The total split by each layer's share of the chars. */
  tokens: Record<Layer, number>
  /** usage.promptTokens, or ceil(chars / 4) when the server gave none. */
  total: number
  exact: boolean
  /** No tools[] in the body: any tool text is inside system (prompted mode). */
  toolsInSystem: boolean
  /** thinking / redacted_thinking blocks in the raw body; their text is in no layer. */
  thinkingBlocks: number
}

const parts = (x: unknown): any[] => Array.isArray(x) ? x : []

export function anatomy(payload: unknown, usage?: Usage): Anatomy | undefined {
  const n = normalizeRequest(payload)
  if (!n) return undefined
  const raw: any[] = (payload as any).messages
  const chars: Record<Layer, number> = { system: 0, tools: n.tools.length ? JSON.stringify(n.tools).length : 0, history: 0, results: 0 }
  n.messages.forEach((m, i) => {
    // normalize reads an OpenAI content-part array as empty; the messages map 1:1 by index in that branch
    const content = n.format === 'openai' ? raw[i]?.content : undefined
    const str = Array.isArray(content) ? content.map(p => p?.type === 'text' && typeof p.text === 'string' ? p.text : '').join('') : m.text
    const text = str.length
    if (m.role === 'system' || m.role === 'developer') chars.system += text
    // prompted mode sends results back as user text wrapped in <tool_result …> (json) or <tool_response> (hermes)
    else if (m.role === 'tool' || (m.role === 'user' && /^\s*<tool_(result|response>)/.test(str))) chars.results += text
    else if (m.role === 'user' || m.role === 'assistant') {
      chars.history += text
      for (const c of m.toolCalls ?? []) chars.history += c.name.length + (JSON.stringify(c.args)?.length ?? 0)
    }
  })
  const sum = LAYERS.reduce((s, l) => s + chars[l], 0)
  const exact = (usage?.promptTokens ?? 0) > 0
  if (!exact && sum === 0) return undefined // nothing to estimate: no "≈0 tok"
  const total = exact ? usage!.promptTokens : Math.ceil(sum / 4)
  const tokens = Object.fromEntries(LAYERS.map(l => [l, sum ? Math.round(total * chars[l] / sum) : 0])) as Record<Layer, number>
  const thinkingBlocks = n.format === 'anthropic'
    ? raw.reduce((s, m) => s + parts(m?.content).filter(b => b?.type === 'thinking' || b?.type === 'redacted_thinking').length, 0) : 0
  return { format: n.format, chars, tokens, total, exact, toolsInSystem: n.tools.length === 0, thinkingBlocks }
}

export type TurnAnatomy = { seq: number; turn: number; a: Anatomy }

/** One entry per request with a readable body, with the usage of the first response of the same turn before the next request. */
export function anatomies(events: HarnessEvent[]): TurnAnatomy[] {
  const out: TurnAnatomy[] = []
  events.forEach((e, i) => {
    if (e.type !== 'llm_request') return
    let usage: Usage | undefined
    for (let j = i + 1; j < events.length; j++) {
      const f = events[j]
      if (f.type === 'llm_request') break
      if (f.type === 'llm_response' && f.turn === e.turn) { usage = f.usage; break }
    }
    const a = anatomy(e.payload, usage)
    if (a) out.push({ seq: e.seq, turn: e.turn, a })
  })
  return out
}

/** `system 22% · tools 18% · history 15% · tool results 45% · 1840 tok` (≈ before the count when it is an estimate). */
export function anatomyLine(a: Anatomy): string {
  const sum = LAYERS.reduce((s, l) => s + a.chars[l], 0) || 1
  const pct = (...ls: Layer[]) => Math.round(100 * ls.reduce((s, l) => s + a.chars[l], 0) / sum)
  const segs = a.toolsInSystem
    ? [`system + tools ${pct('system', 'tools')}%`]
    : [`system ${pct('system')}%`, `tools ${pct('tools')}%`]
  segs.push(`history ${pct('history')}%`, `tool results ${pct('results')}%`, `${a.exact ? '' : '≈'}${a.total} tok`)
  if (a.thinkingBlocks > 0) segs.push('thinking not counted')
  return segs.join(' · ')
}
