import { test, expect } from 'vitest'
import { skeleton, turnsOf } from '../src/core/diff'
import type { HarnessEvent } from '../src/core/events'

/** Events carry seq/ts that nothing here reads; this keeps the fixtures to what matters. */
const ev = (turn: number, e: Record<string, unknown>) => ({ seq: 0, ts: 0, turn, ...e }) as HarnessEvent
const call = (callId: string, name: string) => ev(1, { type: 'tool_call', call: { callId, name, args: {} } })

test('turnsOf groups by turn in the order the turns appear', () => {
  const evs = [ev(1, { type: 'llm_request', payload: {} }), ev(1, { type: 'parse_error', message: 'x', content: '' }), ev(2, { type: 'error', message: 'boom' })]
  expect(turnsOf(evs).map(g => g.length)).toEqual([2, 1])
  expect(turnsOf([])).toEqual([])
})

test('skeleton: a tool call plus its result is one chip, an error result makes it bad', () => {
  const t = skeleton([
    ev(1, { type: 'llm_response', raw: {}, content: '', latencyMs: 1200 }),
    call('c1', 'read_file'),
    call('c2', 'bash'),
    ev(1, { type: 'tool_result', callId: 'c1', name: 'read_file', output: 'no such file', truncated: false, error: true }),
    ev(1, { type: 'tool_result', callId: 'c2', name: 'bash', output: 'ok', truncated: false, error: false }),
  ])
  expect(t).toHaveLength(1)
  expect(t[0].chips).toEqual([
    { label: 'read_file', bad: true, truncated: false },
    { label: 'bash', bad: false, truncated: false },
  ])
  expect(t[0].sig).toBe('read_file! bash')
  expect(t[0].ms).toBe(1200)
})

test('skeleton: truncated shows on the chip but never in sig', () => {
  const t = skeleton([call('c1', 'bash'), ev(1, { type: 'tool_result', callId: 'c1', name: 'bash', output: 'x', truncated: true, error: false })])
  expect(t[0].chips[0]).toEqual({ label: 'bash', bad: false, truncated: true })
  expect(t[0].sig).toBe('bash')
})

test('skeleton: parse_error and error get their own bad chips', () => {
  const t = skeleton([
    ev(1, { type: 'parse_error', message: 'no calls', content: '' }),
    ev(2, { type: 'error', message: 'HTTP 500' }),
  ])
  expect(t.map(x => x.sig)).toEqual(['parse error!', 'error!'])
})

test('skeleton: done is bad unless it is final with at least one tool call', () => {
  const done = (reason: string, toolCallCount: number) => skeleton([ev(3, { type: 'done', reason, turns: 3, toolCallCount })])[0].chips[0]
  expect(done('final', 4)).toEqual({ label: 'done: final', bad: false, truncated: false })
  expect(done('final', 0)).toEqual({ label: 'done: final', bad: true, truncated: false })
  expect(done('max_turns', 9)).toEqual({ label: 'done: max_turns', bad: true, truncated: false })
})

test('skeleton: tokens prefer the exact count, and neither cost lands in sig', () => {
  const stats = (e: Record<string, unknown>) => skeleton([ev(1, { type: 'context_stats', budgetTokens: 0, droppedChars: 0, ...e }), call('c1', 'bash')])[0]
  expect(stats({ estimatedTokens: 900, exactTokens: 1024 }).tokens).toBe(1024)
  expect(stats({ estimatedTokens: 900 }).tokens).toBe(900)
  expect(stats({ estimatedTokens: 900 }).sig).toBe('bash')
})
