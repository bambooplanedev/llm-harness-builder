import { test, expect } from 'vitest'
import { skeleton, turnsOf, configDiff, lineDiff, requestDiff, isNoChange, nthRequest } from '../src/core/diff'
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

test('configDiff: a description is a label, not a knob', () => {
  expect(configDiff({ ...cfg(), description: 'a' }, { ...cfg(), description: 'b' })).toEqual([])
  expect(configDiff(cfg(), { ...cfg(), description: 'b' })).toEqual([])
})

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

test('a tool_result without flags (a proxy trace) marks nothing bad', () => {
  const t = skeleton([
    { seq: 0, turn: 1, ts: 0, type: 'tool_call', call: { callId: 'c1', name: 'read_file', args: {} } },
    { seq: 1, turn: 1, ts: 0, type: 'tool_result', callId: 'c1', name: 'read_file', output: 'x' },
  ] as any)
  expect(t[0].chips).toEqual([{ label: 'read_file', bad: false, truncated: false }])
})

// ---- requestDiff ----
const none = { system: { added: [], removed: [] }, tools: { added: [], removed: [], changed: [] }, params: [] }
const u = (text: string) => ({ role: 'user', content: text })
const as = (text: string) => ({ role: 'assistant', content: text })

test('requestDiff: only appended messages', () => {
  const a = { model: 'm', messages: [u('hi')] }
  const b = { model: 'm', messages: [u('hi'), as('yo'), u('more')] }
  expect(requestDiff(a, b)).toEqual({ ...none, messages: { appended: 2 } })
  expect(isNoChange(requestDiff(a, b)!)).toBe(true)
  expect(requestDiff(a, a)).toEqual({ ...none, messages: { appended: 0 } })
  expect(isNoChange(requestDiff(a, a)!)).toBe(true)
})

test('requestDiff: system lines added and removed; Anthropic blocks join with a newline', () => {
  const sys = (...t: string[]) => t.map(text => ({ type: 'text', text, cache_control: { type: 'ephemeral' } }))
  const a = { system: sys('You are X.', 'Be brief.'), messages: [u('hi')] }
  const b = { system: sys('You are X.', 'Be long.'), messages: [u('hi')] }
  const d = requestDiff(a, b)!
  expect(d.system).toEqual({ added: ['Be long.'], removed: ['Be brief.'] })
  expect(d.messages).toEqual({ appended: 0 })
  expect(requestDiff({ system: 'a\nb', messages: [] }, { system: sys('a', 'b'), messages: [] })!.system).toEqual({ added: [], removed: [] })
})

test('requestDiff: cache_control alone is no change', () => {
  const a = { system: [{ type: 'text', text: 's' }], tools: [{ name: 't', cache_control: { type: 'ephemeral' } }], messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }
  const b = { system: [{ type: 'text', text: 's', cache_control: { type: 'ephemeral' } }], tools: [{ name: 't' }], messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }] }] }
  expect(requestDiff(a, b)).toEqual({ ...none, messages: { appended: 0 } })
})

test('requestDiff: tool added, removed, changed (Anthropic and OpenAI names)', () => {
  const a = { messages: [], tools: [{ name: 'read', input_schema: { a: 1 } }, { type: 'function', function: { name: 'bash' } }, { name: 'old' }] }
  const b = { messages: [], tools: [{ name: 'read', input_schema: { a: 2 } }, { type: 'function', function: { name: 'bash' } }, { name: 'new' }] }
  expect(requestDiff(a, b)!.tools).toEqual({ added: ['new'], removed: ['old'], changed: ['read'] })
  // a nameless tool is keyed by its JSON
  expect(requestDiff({ messages: [] }, { messages: [], tools: [{ x: 1 }] })!.tools.added).toEqual(['{"x":1}'])
})

test('requestDiff: compaction reports history changed from #1 and the lost messages', () => {
  const a = { messages: [u('task'), as('a1'), u('r1'), as('a2')] }
  const b = { messages: [u('summary of work')] }
  const m = requestDiff(a, b)!.messages
  expect(m).toMatchObject({ from: 1, added: 0, removed: 3 })
  expect(m).toEqual({ from: 1, changed: [{ n: 1, added: ['summary of work'], removed: ['task'] }], added: 0, removed: 3 })
  expect(isNoChange(requestDiff(a, b)!)).toBe(false)
})

test('requestDiff: a reminder block added to message #1 changes only #1', () => {
  const a = { messages: [{ role: 'user', content: [{ type: 'text', text: 'task' }] }, as('a1')] }
  const b = { messages: [{ role: 'user', content: [{ type: 'text', text: 'task' }, { type: 'text', text: '<system-reminder>x</system-reminder>' }] }, as('a1'), u('next')] }
  expect(requestDiff(a, b)!.messages).toEqual({ from: 1, changed: [{ n: 1, added: ['<system-reminder>x</system-reminder>'], removed: [] }], added: 1, removed: 0 })
})

test('requestDiff: OpenAI system/developer messages are system, not history; content-part arrays are read', () => {
  const a = { messages: [{ role: 'system', content: 'be X' }, { role: 'developer', content: 'dev' }, { role: 'user', content: [{ type: 'text', text: 'hi' }] }] }
  const b = { messages: [{ role: 'system', content: 'be Y' }, { role: 'developer', content: 'dev' }, { role: 'user', content: [{ type: 'text', text: 'hi' }] }, as('ok')] }
  expect(requestDiff(a, b)).toEqual({ ...none, system: { added: ['be Y'], removed: ['be X'] }, messages: { appended: 1 } })
  const c = { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }
  const d = { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: {} }] }] }
  expect(requestDiff(c, d)!.messages).toEqual({ from: 1, changed: [{ n: 1, added: ['[image_url]'], removed: [] }], added: 0, removed: 0 })
})

test('requestDiff: same text, different call arguments is a changed message', () => {
  const tu = (input: unknown) => ({ role: 'assistant', content: [{ type: 'text', text: 'run' }, { type: 'tool_use', name: 'bash', input }] })
  const d = requestDiff({ messages: [u('x'), tu({ command: 'ls' })] }, { messages: [u('x'), tu({ command: 'pwd' })] })!
  expect(d.messages).toEqual({ from: 2, changed: [{ n: 2, added: ['call bash {"command":"pwd"}'], removed: ['call bash {"command":"ls"}'] }], added: 0, removed: 0 })
  const oc = (args: string) => ({ role: 'assistant', content: null, tool_calls: [{ id: '1', type: 'function', function: { name: 'bash', arguments: args } }] })
  expect(requestDiff({ messages: [oc('{"a":1}')] }, { messages: [oc('{"a":2}')] })!.messages).toMatchObject({ from: 1 })
  // tool_result text is read, key order of input does not matter
  const tr = (t: string) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: '1', content: [{ type: 'text', text: t }] }] })
  expect(requestDiff({ messages: [tr('a')] }, { messages: [tr('b')] })!.messages).toMatchObject({ changed: [{ n: 1, added: ['b'], removed: ['a'] }] })
  expect(requestDiff({ messages: [tu({ a: 1, b: 2 })] }, { messages: [tu({ b: 2, a: 1 })] })!.messages).toEqual({ appended: 0 })
})

test('requestDiff: params are real leaf changes only; a missing key is (none)', () => {
  const a = { model: 'm1', temperature: 0.2, stop: ['a'], extra: { x: 1, y: 2 }, messages: [u('hi')], max_tokens: 9 }
  const b = { max_tokens: 9, extra: { y: 2, x: 1 }, messages: [u('hi')], stop: ['a'], temperature: 0.7, model: 'm2', top_p: 0.9 }
  expect(requestDiff(a, b)!.params).toEqual([
    { path: 'model', a: 'm1', b: 'm2' },
    { path: 'temperature', a: '0.2', b: '0.7' },
    { path: 'top_p', a: '(none)', b: '0.9' },
  ])
  expect(requestDiff({ messages: [], seed: 1 }, { messages: [] })!.params).toEqual([{ path: 'seed', a: '1', b: '(none)' }])
  expect(isNoChange(requestDiff({ messages: [], seed: 1 }, { messages: [] })!)).toBe(false)
})

test('requestDiff: a body without a messages array is unreadable', () => {
  expect(requestDiff({ model: 'm' }, { messages: [] })).toBeUndefined()
  expect(requestDiff({ messages: [] }, 'x')).toBeUndefined()
  expect(requestDiff(null, undefined)).toBeUndefined()
})

test('requestDiff: junk parts, content and tool_calls never throw', () => {
  const a = { messages: [null, { role: 'user', content: [null, 5, { type: 'tool_result', content: 's' }, { type: 'text' }] }, { role: 'user', content: { a: 1 } }, { role: 'assistant', content: null, tool_calls: [null, { function: null }] }] }
  const b = { messages: [{ role: 'user', content: [null, 5, { type: 'tool_result', content: 't' }, { type: 'text' }] }, { role: 'user', content: { a: 1 } }, { role: 'assistant', content: null, tool_calls: [null, { function: null }] }] }
  expect(requestDiff(a, a)!.messages).toEqual({ appended: 0 })
  expect(requestDiff(a, b)!.messages).toEqual({ from: 1, changed: [{ n: 1, added: ['t'], removed: ['s'] }], added: 0, removed: 0 })
})

test('requestDiff: params that are arrays of objects show as JSON', () => {
  expect(requestDiff({ messages: [], mcp_servers: [{ a: 1 }] }, { messages: [], mcp_servers: [{ a: 2 }] })!.params).toEqual([{ path: 'mcp_servers', a: '[{"a":1}]', b: '[{"a":2}]' }])
})

test('requestDiff: a system message after the first user message stays in history', () => {
  const a = { messages: [u('hi')] }
  const b = { messages: [u('hi'), { role: 'system', content: 'late' }] }
  expect(requestDiff(a, b)).toEqual({ ...none, messages: { appended: 1 } })
})

test('requestDiff: b a strict prefix of a is history changed from n+1 with the rest removed', () => {
  const a = { messages: [u('x'), as('y'), u('z')] }
  const b = { messages: [u('x')] }
  expect(requestDiff(a, b)!.messages).toEqual({ from: 2, changed: [], added: 0, removed: 2 })
})

test('nthRequest: the payload of the k-th llm_request, 1-based, across turns', () => {
  const rq = (seq: number, turn: number, payload: unknown) => ({ seq, turn, ts: 0, type: 'llm_request', payload }) as HarnessEvent
  const evs = [rq(0, 1, 'a'), { seq: 1, turn: 1, ts: 0, type: 'done', reason: 'final' } as HarnessEvent, rq(2, 2, 'b')]
  expect(nthRequest(evs, 1)).toBe('a')
  expect(nthRequest(evs, 2)).toBe('b')
  expect(nthRequest(evs, 3)).toBeUndefined()
  expect(nthRequest(evs, 0)).toBeUndefined()
})
