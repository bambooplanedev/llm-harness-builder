import type { ChatMessage } from './backends/types.js'

export function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0
  for (const m of messages) {
    chars += m.content.length
    if (m.role === 'assistant' && m.toolCalls) for (const c of m.toolCalls) chars += JSON.stringify(c.args).length + c.name.length
  }
  return Math.ceil(chars / 4)
}

/** Once over budget, replaces content of the oldest tool results with a stub until at three quarters of it:
 *  stopping at the budget itself would rewrite the history, and cost the server its prefix cache, on every turn after.
 *  Returns chars dropped. Results after the last assistant message are left alone: the model has not seen them yet. */
export function applyBudget(messages: ChatMessage[], budgetTokens: number): number {
  if (budgetTokens <= 0 || estimateTokens(messages) <= budgetTokens) return 0
  const mark = Math.floor(budgetTokens * 0.75)
  let dropped = 0
  const seen = messages.slice(0, Math.max(messages.map(m => m.role).lastIndexOf('assistant'), 0))
  for (const m of seen) {
    if (estimateTokens(messages) <= mark) break
    if (!('isToolResult' in m) || !m.isToolResult || m.content.startsWith('[dropped: ')) continue
    dropped += m.content.length
    m.content = `[dropped: ${m.content.length} chars]`
  }
  return dropped
}
