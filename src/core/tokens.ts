import type { ChatMessage } from './backends/types.js'

export function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0
  for (const m of messages) {
    chars += m.content.length
    if (m.role === 'assistant' && m.toolCalls) for (const c of m.toolCalls) chars += JSON.stringify(c.args).length + c.name.length
  }
  return Math.ceil(chars / 4)
}

/** Replaces content of the oldest tool results with a stub until under budget. Returns chars dropped.
 *  Results after the last assistant message are left alone: the model has not seen them yet. */
export function applyBudget(messages: ChatMessage[], budgetTokens: number): number {
  if (budgetTokens <= 0) return 0
  let dropped = 0
  const seen = messages.slice(0, Math.max(messages.map(m => m.role).lastIndexOf('assistant'), 0))
  for (const m of seen) {
    if (estimateTokens(messages) <= budgetTokens) break
    if (!('isToolResult' in m) || !m.isToolResult || m.content.startsWith('[dropped: ')) continue
    dropped += m.content.length
    m.content = `[dropped: ${m.content.length} chars]`
  }
  return dropped
}
