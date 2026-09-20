import { test, expect } from 'vitest'
import { skeleton, turnsOf, configDiff, lineDiff } from '../src/core/diff'
import type { HarnessEvent } from '../src/core/events'
import type { HarnessConfig } from '../src/core/config'

/** Events carry seq/ts that nothing here reads; this keeps the fixtures to what matters. */
const ev = (turn: number, e: Record<string, unknown>) => ({ seq: 0, ts: 0, turn, ...e }) as HarnessEvent
const call = (callId: string, name: string) => ev(1, { type: 'tool_call', call: { callId, name, args: {} } })

test('turnsOf groups by turn in the order the turns appear', () => {
  const evs = [ev(1, { type: 'llm_request', payload: {} }), ev(1, { type: 'parse_error', message: 'x', content: '' }), ev(2, { type: 'error', message: 'boom' })]
  expect(turnsOf(evs).map(g => g.length)).toEqual([2, 1])
  expect(turnsOf([])).toEqual([])
})

test('turnsOf ignores the pre-loop group so mcp setup does not shift every turn', () => {
  const evs = [
    ev(0, { type: 'mcp_server_start', server: 'fs', command: 'npx', args: [], offered: 14, tools: ['echo'], descriptionChars: 10, schemaChars: 20 }),
    ev(1, { type: 'llm_request', payload: {} }),
    ev(2, { type: 'error', message: 'boom' }),
  ]
  expect(turnsOf(evs).map(g => g.length)).toEqual([1, 1])
  expect(turnsOf(evs)[0][0].type).toBe('llm_request')
})

test('turnsOf keeps the turn-0 group when the run ended there (mcp startup failure, abort before turn 1)', () => {
  const evs = [
    ev(0, { type: 'error', message: 'mcp server "fs" failed to start: boom' }),
    ev(0, { type: 'done', reason: 'mcp_error', turns: 0, toolCallCount: 0 }),
  ]
  expect(turnsOf(evs).map(g => g.length)).toEqual([2])
  expect(turnsOf(evs)[0].map(e => e.type)).toEqual(['error', 'done'])
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

test('skeleton: llm_request and approval_required produce no chip either, same as llm_response', () => {
  const t = skeleton([
    ev(1, { type: 'llm_request', payload: {} }),
    ev(1, { type: 'approval_required', call: { callId: 'c1', name: 'bash', args: {} } }),
  ])
  expect(t[0].chips).toEqual([])
  expect(t[0].sig).toBe('')
})

const cfg = (over: Record<string, unknown> = {}): HarnessConfig => ({
  name: 'bare',
  backend: { kind: 'openai', baseUrl: 'http://127.0.0.1:8080/v1', model: 'qwen3', temperature: 0.2 },
  systemPrompt: 'be brief',
  tools: { enabled: ['bash', 'read_file'], approveBash: true },
  toolCalls: { mode: 'native', format: 'json', enforceSchema: false, promptedTemplate: '', parseErrorHint: '' },
  context: { maxToolOutputChars: 4000, budgetTokens: 0 },
  loop: { maxTurns: 15 },
  ...over,
} as HarnessConfig)

test('configDiff: identical configs differ in nothing, and the name never counts', () => {
  expect(configDiff(cfg(), cfg())).toEqual([])
  expect(configDiff(cfg(), cfg({ name: 'tuned' }))).toEqual([])
})

test('configDiff: dotted paths for the knobs no llm_request carries', () => {
  const d = configDiff(cfg(), cfg({ loop: { maxTurns: 30 }, context: { maxToolOutputChars: 0, budgetTokens: 0 } }))
  expect(d).toEqual([
    { path: 'context.maxToolOutputChars', a: '4000', b: '0' },
    { path: 'loop.maxTurns', a: '15', b: '30' },
  ])
})

test('configDiff: an array is one leaf, and a key missing on one side still shows', () => {
  expect(configDiff(cfg(), cfg({ tools: { enabled: ['bash'], approveBash: true } })))
    .toEqual([{ path: 'tools.enabled', a: '["bash","read_file"]', b: '["bash"]' }])
  const noFormat = cfg({ toolCalls: { mode: 'native', enforceSchema: false, promptedTemplate: '', parseErrorHint: '' } })
  expect(configDiff(cfg(), noFormat)).toEqual([{ path: 'toolCalls.format', a: '"json"', b: 'undefined' }])
  expect(configDiff(noFormat, cfg())).toEqual([{ path: 'toolCalls.format', a: 'undefined', b: '"json"' }])
})

test('lineDiff: only the lines one side does not have, in the order they appeared, blank lines dropped', () => {
  expect(lineDiff('be brief\n\n/no_think\nzebra', 'be brief\nrun the tests')).toEqual({
    onlyA: ['/no_think', 'zebra'],
    onlyB: ['run the tests'],
  })
})

test('lineDiff: a set difference, so reordering or duplicating lines shows no difference', () => {
  expect(lineDiff('a\nb', 'b\na')).toEqual({ onlyA: [], onlyB: [] })
  expect(lineDiff('a\na', 'a')).toEqual({ onlyA: [], onlyB: [] })
})

test('skeleton: a context reset and a final check are chips, and a failed check is a bad one', () => {
  const t = skeleton([
    ev(1, { type: 'context_reset', chars: 10 }),
    ev(2, { type: 'final_check', command: 'c', passed: false, output: '' }),
    ev(3, { type: 'final_check', command: 'c', passed: true, output: '' }),
  ])
  expect(t.map(x => x.sig)).toEqual(['context reset', 'check failed!', 'check passed'])
})
