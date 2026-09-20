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
    { role: 'assistant', content: '' },
    { role: 'user', content: 'c'.repeat(400), isToolResult: true },
  ]
  const dropped = applyBudget(m, 150) // ~1200 chars = 300 tokens; need to get under 150
  expect(m.length).toBe(5)
  expect(m[1].content).toMatch(/^\[dropped: 400 chars\]$/)
  expect(m[2].content).toMatch(/^\[dropped: 400 chars\]$/)
  expect(m[4].content).toBe('c'.repeat(400))
  expect(dropped).toBe(800)
})

// run.ts trims at the top of a turn: whatever follows the last assistant message has not been shown to the model yet.
test('applyBudget never stubs a result the model has not seen, however far over budget', () => {
  const m: ChatMessage[] = [
    { role: 'system', content: 's'.repeat(4000) },
    { role: 'assistant', content: '', toolCalls: [{ name: 'read_file', args: { path: 'a' } }, { name: 'read_file', args: { path: 'b' } }] },
    { role: 'tool', content: 'a'.repeat(4000), toolCallId: '1', name: 'read_file', isToolResult: true },
    { role: 'tool', content: 'b'.repeat(4000), toolCallId: '2', name: 'read_file', isToolResult: true },
  ]
  expect(applyBudget(m, 100)).toBe(0)
  expect(m[2].content).toBe('a'.repeat(4000))
  expect(m[3].content).toBe('b'.repeat(4000))
})

// Without a low-water mark the history is rewritten a little on every turn once it is over budget,
// and every rewrite costs the server its prefix cache from that message on.
test('applyBudget: once over budget it stubs down to three quarters of it, and under budget it does nothing', () => {
  const res = (c: string, id: string): ChatMessage => ({ role: 'tool', content: c.repeat(400), toolCallId: id, name: 'read_file', isToolResult: true })
  const m: ChatMessage[] = [{ role: 'system', content: 'sys' }, res('a', '1'), res('b', '2'), res('c', '3'), res('d', '4'), { role: 'assistant', content: '' }, res('e', '5')]
  expect(estimateTokens(m)).toBe(501)
  expect(applyBudget(m, 450)).toBe(800)          // one stub would do for 450 (407); the mark is 337, so two
  expect(m.map(x => x.content.startsWith('[dropped: '))).toEqual([false, true, true, false, false, false, false])
  expect(estimateTokens(m)).toBeLessThanOrEqual(337)
  expect(applyBudget(m, 450)).toBe(0)
  const between: ChatMessage[] = [{ role: 'system', content: 'sys' }, res('a', '1'), res('b', '2'), res('c', '3'), res('d', '4'), { role: 'assistant', content: '' }]
  expect(estimateTokens(between)).toBe(401)      // over the mark, under the budget: left alone
  expect(applyBudget(between, 450)).toBe(0)
})

test('budget 0 means disabled', () => {
  const m: ChatMessage[] = [{ role: 'tool', content: 'a'.repeat(4000), toolCallId: '1', name: 'x', isToolResult: true }]
  expect(applyBudget(m, 0)).toBe(0)
  expect(m[0].content.length).toBe(4000)
})
