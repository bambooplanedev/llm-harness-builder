export type ParsedPrompted =
  | { ok: true; calls: { name: string; args: Record<string, unknown> }[]; final: string | null }
  | { ok: false; message: string }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function tryParse(s: string): unknown | undefined {
  try { return JSON.parse(s) } catch { return undefined }
}

/** Finds a {calls, final} object in model text: bare JSON, ```json fence, or embedded in prose. */
export function parsePrompted(text: string): ParsedPrompted {
  text = text.replace(/<think>[\s\S]*?<\/think>/g, '')
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
