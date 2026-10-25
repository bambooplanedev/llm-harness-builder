import { test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { Sessions, textOf, hintsOf } from '../src/core/proxy/sessions.js'
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

test('a failed reply is an error event; close() ends every open run with proxy_stopped, once', () => {
  const s = mk()
  s.onRequest({ messages: [S, U] }); s.onReply('run1', 1, ok(reply([{ id: 'a' }, { id: 'b' }])))
  s.onRequest({ messages: [S, U, asst(['a', 'b']), tool('a', '1'), tool('b', '2')] })
  expect(s.onReply('run1', 2, { ok: false, message: 'POST /chat/completions: 500', body: 'boom' })).toEqual([
    { seq: 7, turn: 2, ts: expect.any(Number), type: 'error', message: 'POST /chat/completions: 500', body: 'boom' }]) // 0 request, 1-3 reply, 4-5 results, 6 request
  s.onRequest({ messages: [{ role: 'system', content: 'other' }, U] })
  const closed = s.close()
  expect(closed.map(c => c.run)).toEqual(['run1', 'run2'])
  expect(closed[0].events).toEqual([{ seq: 8, turn: 2, ts: expect.any(Number), type: 'done', reason: 'proxy_stopped', turns: 2, toolCallCount: 2 }])
  expect(s.close()).toEqual([])
})

const A = (system: unknown, messages: object[]) => ({ model: 'm', system, messages })
const ublk = (...texts: string[]) => ({ role: 'user', content: texts.map(text => ({ type: 'text', text })) })
const tu = (id: string) => ({ role: 'assistant', content: [{ type: 'thinking', thinking: 'hm', signature: 's' }, { type: 'tool_use', id, name: 'Read', input: {} }] })
const res = (id: string, content: unknown, is_error?: boolean) => ({ type: 'tool_result', tool_use_id: id, content, ...(is_error ? { is_error } : {}) })
const tr = (...blocks: object[]) => ({ role: 'user', content: blocks })
const ar = (s: Sessions, p: object) => s.onRequest(p, 'anthropic')

test('anthropic without headers: key is system minus its first block plus the first user text; the task skips system-reminders', () => {
  const s = mk()
  const a = ar(s, A([{ type: 'text', text: 'attr v1' }, { type: 'text', text: 'sys' }], [ublk('<system-reminder>ctx</system-reminder>', 'fix the bug')]))
  expect(a.meta!.task).toBe('fix the bug')
  // the attribution block changes and cache_control moves: same run
  expect(ar(s, A([{ type: 'text', text: 'attr v2' }, { type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }], [ublk('<system-reminder>ctx</system-reminder>', 'fix the bug'), { role: 'assistant', content: 'ok' }, ublk('more')])).run).toBe('run1')
  expect(ar(s, A('other', [ublk('fix the bug')])).run).toBe('run2')
})

test('anthropic: tool_result blocks match calls by tool_use_id; is_error and block content carry over', () => {
  const s = mk()
  ar(s, A('sys', [ublk('t')]))
  s.onReply('run1', 1, ok(reply([{ id: 'toolu_a' }, { id: 'toolu_b' }])))
  const b = ar(s, A('sys', [ublk('t'), tu('toolu_a'), tr(res('toolu_b', [{ type: 'text', text: 'B' }], true), res('toolu_a', 'A'), res('nope', 'Z'))]))
  expect(b.events.filter(e => e.type === 'tool_result').map((e: any) => [e.callId, e.output, e.error])).toEqual([['c2', 'B', true], ['c1', 'A', undefined]])
})

test('anthropic: a mid-conversation system entry and thinking blocks in history neither split the run nor break matching', () => {
  const s = mk()
  ar(s, A('sys', [ublk('t')]))
  s.onReply('run1', 1, ok(reply([{ id: 'toolu_a' }])))
  const b = ar(s, A('sys', [ublk('t'), tu('toolu_a'), { role: 'system', content: 'note' }, tr(res('toolu_a', 'A'))]))
  expect(b).toMatchObject({ run: 'run1', turn: 2 })
  expect(b.events.filter(e => e.type === 'tool_result').map((e: any) => [e.callId, e.output])).toEqual([['c1', 'A']])
})

test('anthropic is told by the route: no system and a plain string task, then tool blocks, stay one run', () => {
  const s = mk(), U1 = { role: 'user', content: 'go' }
  expect(ar(s, { model: 'm', messages: [U1] }).meta!.task).toBe('go')
  s.onReply('run1', 1, ok(reply([{ id: 'toolu_a' }])))
  const b = ar(s, { model: 'm', messages: [U1, tu('toolu_a'), tr(res('toolu_a', 'A'))] })
  expect(b).toMatchObject({ run: 'run1', turn: 2 })
  expect(b.events.filter(e => e.type === 'tool_result').map((e: any) => [e.callId, e.output])).toEqual([['c1', 'A']])
})

test('an unclosed system-reminder leaks nothing into the task', () => {
  expect(ar(mk(), A('sys', [ublk('fix it', '<system-reminder>secret context')])).meta!.task).toBe('fix it')
})

const CC = '00000000-0000-4000-8000-000000000001'
const ccReq = (messages: object[], model = 'claude-opus-fixture') => ({ model, system: [{ type: 'text', text: 'attribution: fixture' }, { type: 'text', text: 'sys' }], messages })
const ccOk = (content: string, calls: { id: string; name: string }[] = []): NormalizedResponse =>
  ({ content, toolCalls: calls.map(c => ({ backendId: c.id, name: c.name, args: {} })), usage: { promptTokens: 7, completionTokens: 2 }, raw: {} })

test('a Claude Code session from the fixture: one main run, one subagent run with its parent, auxiliary and compaction as notes in main', () => {
  const steps: { headers: Record<string, string>; payload: any; reply: any }[] = JSON.parse(readFileSync('tests/fixtures/claude-code-session.json', 'utf8'))
  const s = mk(), metas: any[] = [], byRun: Record<string, any[]> = {}, runs: string[] = []
  for (const step of steps) {
    const out = s.onRequest(step.payload, 'anthropic', hintsOf(step.headers))
    if (out.meta) metas.push(out.meta)
    runs.push(out.run)
    ;(byRun[out.run] ??= []).push(...out.events, ...s.onReply(out.run, out.turn, ok({ ...step.reply, raw: {} }), out.side))
  }
  expect(metas).toHaveLength(2)
  const [main, sub] = metas
  expect(main).toMatchObject({ session: CC, agent: 'main', task: 'Find the parser' })
  expect(main.parent).toBeUndefined()
  expect(sub).toMatchObject({ session: CC, agent: 'agent-0001', parent: 'main', agentType: 'Explore', task: 'Find where the parser lives' })
  expect(runs).toEqual([main.id, main.id, sub.id, sub.id, main.id, main.id, main.id]) // turn 3 joins main with fewer messages
  const m = byRun[main.id]
  expect(m.filter(e => e.type === 'proxy_note')).toEqual([
    expect.objectContaining({ kind: 'auxiliary', model: 'claude-haiku-fixture', usage: { promptTokens: 20, completionTokens: 3 }, latencyMs: 5, turn: 1 }),
    expect.objectContaining({ kind: 'compaction', turn: 3 }),
  ])
  const reqs = m.flatMap((e, i) => e.type === 'llm_request' ? [i] : [])
  expect(reqs).toHaveLength(4)
  expect(m[reqs[2] - 1]).toMatchObject({ type: 'proxy_note', kind: 'compaction' })
  expect(m.filter(e => e.type === 'tool_result')).toEqual([expect.objectContaining({ callId: 'c1', name: 'Task', turn: 1, output: 'The parser is in src/parser.ts.' })])
  expect(byRun[sub.id].filter(e => e.type === 'tool_result')).toEqual([expect.objectContaining({ callId: 'c1', name: 'Read', turn: 1 })])
  expect(m.map(e => e.seq)).toEqual(m.map((_, i) => i))
})

test('auxiliary before main waits: the first main request writes the meta with its task, then the notes in order', () => {
  const s = mk(), h = (c: string) => hintsOf({ 'x-claude-code-session-id': CC, 'x-claude-code-request-class': c })
  const aux = s.onRequest(ccReq([{ role: 'user', content: 'title?' }], 'claude-haiku-fixture'), 'anthropic', h('auxiliary'))
  expect(aux).toMatchObject({ run: 'run1', turn: 0, events: [], side: { model: 'claude-haiku-fixture' } })
  expect(aux.meta).toBeUndefined()
  const aux2 = s.onRequest(ccReq([{ role: 'user', content: 'summary?' }], 'claude-haiku-other'), 'anthropic', h('auxiliary'))
  expect(aux2.run).toBe('run1')
  expect(s.onReply(aux.run, aux.turn, ok(ccOk('Title')), aux.side)).toEqual([])
  expect(s.onReply(aux2.run, aux2.turn, { ok: false, message: 'POST /v1/messages: 429' }, aux2.side)).toEqual([])
  const a = s.onRequest(ccReq([{ role: 'user', content: 'do it' }]), 'anthropic', h('main'))
  expect(a).toMatchObject({ run: 'run1', turn: 1 })
  expect(a.meta).toMatchObject({ id: 'run1', task: 'do it', session: CC, agent: 'main' })
  expect(a.events.map(e => [e.seq, e.turn, e.type, (e as { model?: string }).model])).toEqual([
    [0, 0, 'proxy_note', 'claude-haiku-fixture'], [1, 0, 'proxy_note', 'claude-haiku-other'], [2, 1, 'llm_request', undefined]])
  expect(a.events[1]).toMatchObject({ error: 'POST /v1/messages: 429' })
  // Started now: a later auxiliary reply is a note right away.
  const aux3 = s.onRequest(ccReq([{ role: 'user', content: 'title?' }], 'claude-haiku-fixture'), 'anthropic', h('auxiliary'))
  expect(s.onReply(aux3.run, aux3.turn, ok(ccOk('T')), aux3.side)).toEqual([expect.objectContaining({ type: 'proxy_note', turn: 1, seq: 3 })])
  expect(s.close()).toEqual([{ run: 'run1', events: [expect.objectContaining({ type: 'done', reason: 'proxy_stopped', turns: 1 })] }])
})

test('a session of auxiliary calls only: close() writes one main run, task empty, with its notes', () => {
  const s = mk()
  const aux = s.onRequest(ccReq([{ role: 'user', content: 'title?' }], 'claude-haiku-fixture'), 'anthropic', hintsOf({ 'x-claude-code-session-id': CC, 'x-claude-code-request-class': 'auxiliary' }))
  s.onReply(aux.run, aux.turn, ok(ccOk('Title')), aux.side)
  const closed = s.close()
  expect(closed).toHaveLength(1)
  expect(closed[0].meta).toMatchObject({ id: 'run1', task: '', session: CC, agent: 'main' })
  expect(closed[0].events.map(e => [e.seq, e.turn, e.type])).toEqual([[0, 0, 'proxy_note'], [1, 0, 'done']])
  expect(closed[0].events[1]).toMatchObject({ reason: 'proxy_stopped', turns: 0, toolCallCount: 0 })
})

test('an auxiliary reply between main turns keeps the main calls matched', () => {
  const s = mk(), h = (c: string) => hintsOf({ 'x-claude-code-session-id': CC, 'x-claude-code-request-class': c })
  const U1 = { role: 'user', content: 'do it' }
  s.onRequest(ccReq([U1]), 'anthropic', h('main'))
  s.onReply('run1', 1, ok(ccOk('', [{ id: 'toolu_a', name: 'Read' }])))
  const aux = s.onRequest(ccReq([{ role: 'user', content: 'title?' }], 'claude-haiku-fixture'), 'anthropic', h('auxiliary'))
  s.onReply(aux.run, aux.turn, ok(ccOk('', [{ id: 'toolu_x', name: 'Other' }])), aux.side)
  const b = s.onRequest(ccReq([U1, { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_a', name: 'Read', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: 'A' }] }]), 'anthropic', h('main'))
  expect(b).toMatchObject({ run: 'run1', turn: 2 })
  expect(b.events[0]).toMatchObject({ type: 'tool_result', callId: 'c1', name: 'Read', output: 'A', turn: 1 })
})

test('a failed auxiliary call is a note with its error, not an error event', () => {
  const s = mk()
  const aux = s.onRequest(ccReq([{ role: 'user', content: 'title?' }], 'claude-haiku-fixture'), 'anthropic', hintsOf({ 'x-claude-code-session-id': CC, 'x-claude-code-request-class': 'auxiliary' }))
  expect(s.onReply(aux.run, aux.turn, { ok: false, message: 'POST /v1/messages: 429', body: 'slow down' }, aux.side)).toEqual([])
  expect(s.close()[0].events[0]).toEqual({ seq: 0, turn: 0, ts: expect.any(Number), type: 'proxy_note', kind: 'auxiliary', model: 'claude-haiku-fixture', error: 'POST /v1/messages: 429' })
})

test('hintsOf takes only the whitelist, as single printable strings', () => {
  const bad = { 'x-claude-code-session-id': ['a', 'b'], 'x-claude-code-agent-id': 'x'.repeat(129), 'x-claude-code-agent-type': 'Ex\u0007', 'x-claude-code-request-class': 'main', 'x-api-key': 'k', authorization: 'Bearer t' }
  expect(hintsOf(bad)).toEqual({ requestClass: 'main' })
  expect(hintsOf({ 'x-claude-code-session-id': 'x'.repeat(128), 'x-claude-code-parent-agent-id': 'p', 'x-claude-code-agent-id': '' })).toEqual({ session: 'x'.repeat(128), parent: 'p' })
  const s = mk()
  s.onRequest(ccReq([{ role: 'user', content: 'do it' }]), 'anthropic', hintsOf(bad))
  const b = s.onRequest(ccReq([{ role: 'user', content: 'do it' }]), 'anthropic')
  expect(b).toMatchObject({ run: 'run1', turn: 2 })
})
