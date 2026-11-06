// An own dialect for the recording proxy: Ollama's native POST /api/chat.
// Self-contained on purpose: it imports nothing from this package, so it keeps working when the package moves.
// Run it with:  llm-harness-builder proxy --upstream=http://127.0.0.1:11434 --dialect=/abs/path/ollama-chat.mjs
//
// Ollama's format differs from OpenAI's where it matters here:
//  - the reply is NDJSON (application/x-ndjson) when streaming, one JSON object (application/json) when `stream:false`;
//  - tool calls arrive as `message.tool_calls[].function.{name, arguments}`, `arguments` an object, and have no ids;
//  - a tool result is `{ role: 'tool', tool_name, content }`, again without an id, so results match calls by order.

/** @typedef {{ callId: string, name: string, args: Record<string, unknown>, backendId?: string }} ToolCall */
/** @typedef {{ call: ToolCall, output: string, error?: true }} ToolResultSeen */
/** @typedef {{ name: string, args: Record<string, unknown>, backendId?: string }} NormalizedToolCall */
/** @typedef {{ content: string, reasoning?: string, toolCalls: NormalizedToolCall[], usage?: { promptTokens: number, completionTokens: number }, truncated?: boolean, raw: unknown }} NormalizedResponse */

/** The request's `messages`, [] when absent. */
const messagesOf = (/** @type {any} */ payload) => (Array.isArray(payload?.messages) ? payload.messages : [])

/** The pieces of a reply body, one object each: the NDJSON lines, or the one JSON object. Bad lines are skipped. */
function pieces(/** @type {Buffer[]} */ chunks, /** @type {string} */ contentType) {
  const text = Buffer.concat(chunks).toString('utf8')
  if (/^application\/json/i.test(contentType)) return [JSON.parse(text)]
  const out = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch { /* a cut last line */ }
  }
  return out
}

export default {
  id: 'ollama-chat',
  label: 'POST /api/chat',

  matches: (method, pathname) => method === 'POST' && pathname === '/api/chat',

  /** The run is keyed by the first system message and the first user message, whole. */
  keyOf(payload) {
    const msgs = messagesOf(payload)
    const sys = msgs.find(/** @param {any} m */ m => m?.role === 'system')
    const user = msgs.find(/** @param {any} m */ m => m?.role === 'user')
    return {
      key: JSON.stringify([sys ?? null, user ?? null]),
      taskText: typeof user?.content === 'string' ? user.content : '',
      len: msgs.length,
      model: String(payload?.model ?? ''),
    }
  },

  /** The tool messages after the last assistant message; the i-th one answers the i-th call of that turn. */
  toolResults(payload, /** @type {ToolCall[]} */ calls) {
    const msgs = messagesOf(payload)
    const last = msgs.map(/** @param {any} m */ m => m?.role).lastIndexOf('assistant')
    if (last < 0) return []
    /** @type {ToolResultSeen[]} */
    const out = []
    let i = 0
    for (const m of msgs.slice(last + 1)) {
      if (m?.role !== 'tool') continue
      const call = calls[i++]
      if (call) out.push({ call, output: typeof m.content === 'string' ? m.content : '' })
    }
    return out
  },

  /** @returns {Promise<NormalizedResponse>} */
  async readReply(chunks, contentType) {
    const parts = pieces(chunks, contentType)
    let content = '', reasoning = ''
    /** @type {NormalizedToolCall[]} */
    const toolCalls = []
    let usage, truncated
    for (const p of parts) {
      content += p?.message?.content ?? ''
      reasoning += p?.message?.thinking ?? ''
      for (const t of p?.message?.tool_calls ?? []) {
        let args = t?.function?.arguments ?? {}
        if (typeof args === 'string') { try { args = JSON.parse(args) } catch { args = {} } }
        toolCalls.push({ name: String(t?.function?.name ?? ''), args: args && typeof args === 'object' ? args : {} })
      }
      if (p?.done) {
        if (Number.isFinite(p.prompt_eval_count) && Number.isFinite(p.eval_count)) usage = { promptTokens: p.prompt_eval_count, completionTokens: p.eval_count }
        truncated = p.done_reason === 'length'
      }
    }
    return { content, ...(reasoning ? { reasoning } : {}), toolCalls, ...(usage ? { usage } : {}), ...(truncated ? { truncated } : {}), raw: parts }
  },

  /** The text of a cut reply: whatever whole lines said. */
  async partial(chunks, contentType) {
    try { return pieces(chunks, contentType).map(p => p?.message?.content ?? '').join('') } catch { return undefined }
  },
}
