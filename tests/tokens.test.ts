import { test, expect } from 'vitest'
import { estimateTokens, applyBudget } from '../src/core/tokens.js'
import type { ChatMessage } from '../src/core/backends/types.js'

test('estimate is chars/4 over content and tool call args', () => {
  const m: ChatMessage[] = [
    { role: 'user', content: 'x'.repeat(40) },
    { role: 'assistant', content: '', toolCalls: [{ name: 'bash', args: { command: 'y'.repeat(40) } }] },
  ]
  expect(estimateTokens(m)).toBeGreaterThanOrEqual(20)
  expect(estimateTokens(m)).toBeLessThan(40)
})

test('applyBudget replaces oldest tool results first, never removes messages', () => {
  const m: ChatMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'tool', content: 'a'.repeat(400), toolCallId: '1', name: 'read_file', isToolResult: true },
    { role: 'tool', content: 'b'.repeat(400), toolCallId: '2', name: 'read_file', isToolResult: true },
    { role: 'user', content: 'c'.repeat(400), isToolResult: true },
  ]
  const dropped = applyBudget(m, 150) // ~1200 chars = 300 tokens; need to get under 150
  expect(m.length).toBe(4)
  expect(m[1].content).toMatch(/^\[dropped: 400 chars\]$/)
  expect(m[2].content).toMatch(/^\[dropped: 400 chars\]$/)
  expect(m[3].content).toBe('c'.repeat(400))
  expect(dropped).toBe(800)
})

test('budget 0 means disabled', () => {
  const m: ChatMessage[] = [{ role: 'tool', content: 'a'.repeat(4000), toolCallId: '1', name: 'x', isToolResult: true }]
  expect(applyBudget(m, 0)).toBe(0)
  expect(m[0].content.length).toBe(4000)
})
