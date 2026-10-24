import type { ToolSchema } from './backends/types.js'

/**
 * A recorded request body read the same way whatever API it was sent to. Pure and browser-safe (the trace
 * view imports it): type imports only. Messages map 1:1 onto the harness's ChatMessage list, so an index
 * means the same message in either format.
 */
export type NormMessage = { role: string; text: string; toolCalls?: { name: string; args: unknown }[] }
export type NormRequest = { format: 'openai' | 'anthropic'; system: string; tools: ToolSchema[]; messages: NormMessage[] }

const str = (x: unknown): string => typeof x === 'string' ? x : ''
const blocks = (x: unknown): any[] => Array.isArray(x) ? x : []
const texts = (x: unknown): string => typeof x === 'string' ? x : blocks(x).filter(b => b?.type === 'text').map(b => str(b.text)).join('')
const ANTHROPIC_BLOCKS = new Set(['tool_use', 'tool_result', 'thinking', 'redacted_thinking'])

/** Arguments as an OpenAI body carries them: a JSON string (OpenAI) or an object (Ollama). */
const args = (a: unknown): unknown => { if (typeof a !== 'string') return a; try { return JSON.parse(a) } catch { return a } }

export function normalizeRequest(payload: unknown): NormRequest | undefined {
  const p = payload as any
  if (!p || typeof p !== 'object' || !Array.isArray(p.messages)) return undefined
  const msgs: any[] = p.messages, tools = blocks(p.tools)
  const anthropic = 'system' in p || 'thinking' in p || tools.some(t => t?.input_schema !== undefined)
    || msgs.some(m => blocks(m?.content).some(b => ANTHROPIC_BLOCKS.has(b?.type)))
  if (!anthropic) {
    const messages = msgs.map((m): NormMessage => {
      const calls = blocks(m?.tool_calls).map(c => ({ name: str(c?.function?.name), args: args(c?.function?.arguments) }))
      return { role: str(m?.role), text: str(m?.content), ...(calls.length ? { toolCalls: calls } : {}) }
    })
    const ts = tools.map(t => t?.function ?? t).map((f): ToolSchema => ({ name: str(f?.name), description: str(f?.description), parameters: f?.parameters ?? {} }))
    return { format: 'openai', system: messages.find(m => m.role === 'system')?.text ?? '', tools: ts, messages }
  }
  const system = texts(p.system), messages: NormMessage[] = p.system !== undefined ? [{ role: 'system', text: system }] : []
  for (const m of msgs) {
    const role = str(m?.role)
    if (typeof m?.content === 'string') messages.push({ role, text: m.content })
    else if (role === 'assistant') {
      const calls = blocks(m.content).filter(b => b?.type === 'tool_use').map(b => ({ name: str(b.name), args: b.input }))
      messages.push({ role, text: texts(m.content), ...(calls.length ? { toolCalls: calls } : {}) })
    } else for (const b of blocks(m?.content)) {
      // One harness message per block: a turn's results travel in one user message here, one tool message each there.
      if (b?.type === 'tool_result') messages.push({ role: 'tool', text: texts(b.content) })
      else if (b?.type === 'text') messages.push({ role, text: str(b.text) })
    }
  }
  const ts = tools.map((t): ToolSchema => ({ name: str(t?.name), description: str(t?.description), parameters: t?.input_schema ?? {} }))
  return { format: 'anthropic', system, tools: ts, messages }
}
