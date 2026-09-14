export type ParsedPrompted =
  | { ok: true; calls: { name: string; args: Record<string, unknown> }[]; final: string | null }
  | { ok: false; message: string }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function tryParse(s: string): unknown | undefined {
  try { return JSON.parse(s) } catch { return undefined }
}

/**
 * Drops reasoning: closed <think> blocks, and a closing tag the reply never opened. The Qwen3
 * template opens <think> in the prompt itself, so the model's text starts mid-block and comes
 * back with the close alone — everything before it is reasoning, not an answer.
 */
const stripThink = (t: string) => t.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^[\s\S]*?<\/think>/, '')

/** Finds a {calls, final} object in model text: bare JSON, ```json fence, or embedded in prose. */
export function parsePrompted(text: string): ParsedPrompted {
  text = stripThink(text)
  const candidates = [text.trim()]
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  if (fence) candidates.push(fence[1].trim())
  const first = text.indexOf('{'), last = text.lastIndexOf('}')
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1))

  for (const c of candidates) {
    const v = tryParse(c)
    if (!isObj(v) || !Array.isArray(v.calls)) continue
    if (v.final !== null && typeof v.final !== 'string') continue
    const calls: { name: string; args: Record<string, unknown> }[] = []
    let bad = false
    for (const call of v.calls) {
      if (!isObj(call) || typeof call.name !== 'string') { bad = true; break }
      calls.push({ name: call.name, args: isObj(call.args) ? call.args : {} })
    }
    if (bad) continue
    return { ok: true, calls, final: v.final }
  }
  return { ok: false, message: 'no {"calls": [...], "final": ...} object found in response' }
}

const TOOL_CALL_RE = /<tool_call>([\s\S]*?)<\/tool_call>/g

/**
 * Qwen/Hermes format: zero or more <tool_call>{"name","arguments"}</tool_call> blocks.
 * Plain text without blocks is the final answer (this is how these models were trained);
 * the trace shows such a "final after 0 tool calls" so the user can see the model quit early.
 */
export function parseHermes(text: string): ParsedPrompted {
  if (text.includes('<think>') && !text.includes('</think>')) return { ok: false, message: 'unclosed <think> block' }
  text = stripThink(text)
  const calls: { name: string; args: Record<string, unknown> }[] = []
  let n = 0
  for (const m of text.matchAll(TOOL_CALL_RE)) {
    n++
    const v = tryParse(m[1].trim())
    if (!isObj(v) || typeof v.name !== 'string') return { ok: false, message: `tool_call #${n} is not a JSON object with name/arguments` }
    const args = v.arguments ?? v.parameters
    calls.push({ name: v.name, args: isObj(args) ? args : {} })
  }
  const rest = text.replace(TOOL_CALL_RE, '')
  if (rest.includes('<tool_call>')) return { ok: false, message: 'unclosed <tool_call> block' }
  if (calls.length) return { ok: true, calls, final: null }
  const final = rest.trim()
  return final ? { ok: true, calls: [], final } : { ok: false, message: 'empty response' }
}
