import { test, expect } from 'vitest'
import { Sessions, textOf } from '../src/core/proxy/sessions.js'
import type { NormalizedResponse } from '../src/core/backends/types.js'

const S = { role: 'system', content: 'sys' }, U = { role: 'user', content: 'task one' }
const asst = (ids: (string | undefined)[]) => ({ role: 'assistant', content: '', tool_calls: ids.map(id => ({ id, type: 'function', function: { name: 'read_file', arguments: '{}' } })) })
const tool = (id: string | undefined, content: unknown) => ({ role: 'tool', tool_call_id: id, content })
const reply = (calls: { id?: string; name?: string; args?: Record<string, unknown>; argsError?: string }[] = [], content = ''): NormalizedResponse =>
  ({ content, toolCalls: calls.map(c => ({ backendId: c.id, name: c.name ?? 'read_file', args: c.args ?? {}, ...(c.argsError ? { argsError: c.argsError } : {}) })), raw: {} })
const ok = (res: NormalizedResponse) => ({ ok: true as const, res, latencyMs: 5 })
const mk = () => { let t = 1000, n = 0; return new Sessions({ now: () => t++, newId: () => `run${++n}`, harness: 'oc', upstream: 'http://u', pid: 42 }) }

test('a first request opens a run with its meta; the reply and the next request continue it', () => {
  const s = mk()
  const a = s.onRequest({ messages: [S, U] })
  expect(a).toMatchObject({ run: 'run1', turn: 1 })
  expect(a.meta).toEqual({ id: 'run1', harness: 'oc', task: 'task one', workdir: '', started: 1000, proxy: { upstream: 'http://u', pid: 42 } })
  expect(a.events).toEqual([{ seq: 0, turn: 1, ts: expect.any(Number), type: 'llm_request', payload: { messages: [S, U] } }])
  const r = s.onReply('run1', 1, ok(reply([{ id: 'x1', args: { path: 'a' } }])))
  expect(r.map(e => e.type)).toEqual(['llm_response', 'tool_call'])
  expect(r[1]).toMatchObject({ seq: 2, turn: 1, call: { callId: 'c1', name: 'read_file', args: { path: 'a' }, backendId: 'x1' } })
  const b = s.onRequest({ messages: [S, U, asst(['x1']), tool('x1', 'AAA')] })
  expect(b).toMatchObject({ run: 'run1', turn: 2 }); expect(b.meta).toBeUndefined()
  expect(b.events[0]).toEqual({ seq: 3, turn: 1, ts: expect.any(Number), type: 'tool_result', callId: 'c1', name: 'read_file', output: 'AAA' })
  expect(b.events[1]).toMatchObject({ seq: 4, turn: 2, type: 'llm_request' })
})

test('run key: a new round, another system prompt and a compaction open runs; a retry stays', () => {
  const s = mk()
  s.onRequest({ messages: [S, U] }); s.onReply('run1', 1, ok(reply([{ id: 'a' }])))
  s.onRequest({ messages: [S, U, asst(['a']), tool('a', 'x')] })
  expect(s.onRequest({ messages: [S, U, asst(['a']), tool('a', 'x')] }).run).toBe('run1')          // retry, same length
  expect(s.onRequest({ messages: [S, U] }).run).toBe('run2')                                         // new round: shorter
  expect(s.onRequest({ messages: [{ role: 'system', content: 'title' }, U] }).run).toBe('run3')     // side request
  expect(s.onRequest({ messages: [S, { role: 'user', content: 'summary of the above' }] }).run).toBe('run4') // compaction
})

test('a turn with another system prompt (our repeatThinkTokens) is a one-turn run; the next turn rejoins', () => {
  const s = mk()
  s.onRequest({ messages: [S, U] }); s.onReply('run1', 1, ok(reply([{ id: 'a' }])))
  const h = [U, asst(['a']), tool('a', 'x')]
  expect(s.onRequest({ messages: [{ role: 'system', content: 'sys /think' }, ...h] }).run).toBe('run2')
  expect(s.onRequest({ messages: [S, ...h, { role: 'assistant', content: 'r' }, { role: 'user', content: 'go on' }] })).toMatchObject({ run: 'run1', turn: 2 })
})

test('two sequential sessions of one task share the run of their identical side request (a known hole)', () => {
  const s = mk(), side = { messages: [{ role: 'system', content: 'title' }, U] }
  expect(s.onRequest(side).run).toBe('run1'); expect(s.onRequest(side).run).toBe('run1')
})

test('a developer message counts as system; array content is read as text', () => {
  const s = mk()
  const a = s.onRequest({ messages: [{ role: 'developer', content: 'd' }, { role: 'user', content: [{ type: 'text', text: 'part one' }, { type: 'image_url', image_url: {} }, { type: 'text', text: 'part two' }] }] })
  expect(a.meta!.task).toBe('part one\npart two')
  expect(s.onRequest({ messages: [{ role: 'developer', content: 'other' }, { role: 'user', content: 'x' }] }).run).toBe('run2')
  expect(textOf(null)).toBe(''); expect(textOf('s')).toBe('s')
})

test('tool results match through the ids the agent echoed, not the server ids', () => {
  const s = mk()
  s.onRequest({ messages: [S, U] })
  s.onReply('run1', 1, ok(reply([{ args: { path: 'a' } }, { args: { path: 'b' } }]))) // the server sent no ids
  const b = s.onRequest({ messages: [S, U, asst(['inv_1', 'inv_2']), tool('inv_2', 'B'), tool('inv_1', 'A'), tool('nope', 'Z')] })
  expect(b.events.filter(e => e.type === 'tool_result').map((e: any) => [e.callId, e.output, e.turn])).toEqual([['c2', 'B', 1], ['c1', 'A', 1]])
})

test('the same id on two turns maps to the latest call; a retried request does not repeat results', () => {
  const s = mk()
  s.onRequest({ messages: [S, U] }); s.onReply('run1', 1, ok(reply([{ id: 'a' }])))
  const h2 = [S, U, asst(['a']), tool('a', 'one')]
  s.onRequest({ messages: h2 })
  expect(s.onRequest({ messages: h2 }).events.map(e => e.type)).toEqual(['llm_request']) // retry: no second result
  s.onReply('run1', 3, ok(reply([{ id: 'a' }])))
  const c = s.onRequest({ messages: [...h2, asst(['a']), tool('a', 'two')] })
  expect(c.events[0]).toMatchObject({ type: 'tool_result', callId: 'c2', output: 'two', turn: 3 })
})

test('bad arguments give a tool_call with {} and nothing else; a length reply adds nothing', () => {
  const s = mk()
  s.onRequest({ messages: [S, U] })
  const r = s.onReply('run1', 1, ok({ ...reply([{ args: {}, argsError: 'Unexpected token: {bad' }]), truncated: true }))
  expect(r.map(e => e.type)).toEqual(['llm_response', 'tool_call'])
  expect((r[1] as any).call.args).toEqual({})
})

test('a failed reply is an error event; close() ends every open run with aborted, once', () => {
  const s = mk()
  s.onRequest({ messages: [S, U] }); s.onReply('run1', 1, ok(reply([{ id: 'a' }, { id: 'b' }])))
  s.onRequest({ messages: [S, U, asst(['a', 'b']), tool('a', '1'), tool('b', '2')] })
  expect(s.onReply('run1', 2, { ok: false, message: 'POST /chat/completions: 500', body: 'boom' })).toEqual([
    { seq: 7, turn: 2, ts: expect.any(Number), type: 'error', message: 'POST /chat/completions: 500', body: 'boom' }]) // 0 request, 1-3 reply, 4-5 results, 6 request
  s.onRequest({ messages: [{ role: 'system', content: 'other' }, U] })
  const closed = s.close()
  expect(closed.map(c => c.run)).toEqual(['run1', 'run2'])
  expect(closed[0].events).toEqual([{ seq: 8, turn: 2, ts: expect.any(Number), type: 'done', reason: 'aborted', turns: 2, toolCallCount: 2 }])
  expect(s.close()).toEqual([])
})
