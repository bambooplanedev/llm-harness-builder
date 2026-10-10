import { test, expect } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runAgent } from '../src/core/run.js'
import { analyzeTrace, type Stub } from '../src/core/analyze.js'
import type { HarnessConfig, RunParams } from '../src/core/config.js'
import type { HarnessEvent } from '../src/core/events.js'
import { fakeBackend, harness, tmp, type FakeResponse } from './helpers.js'

// Each event is frozen as it is yielded, the way TraceWriter serialises it: the fake backend hands
// the live messages array to llm_request, and the budget stubs those objects in place on a later turn.
async function trace(config: HarnessConfig, queue: FakeResponse[], opts = {}) {
  const d = await tmp('lhb-an-'); await writeFile(join(d, 'a.txt'), 'A'.repeat(120)); await writeFile(join(d, 'b.txt'), 'B'.repeat(120))
  const ev: HarnessEvent[] = []
  for await (const e of runAgent({ config, task: 'do', workdir: d } as RunParams, { backend: fakeBackend(queue), approve: async () => true, ...opts })) ev.push(JSON.parse(JSON.stringify(e)))
  return ev
}
const stubTurn = (ev: HarnessEvent[]) => (ev.find(e => e.type === 'context_stats' && e.droppedChars > 0) as any).turn
const tools = { enabled: ['read_file', 'edit_file', 'bash'] as HarnessConfig['tools']['enabled'], approveBash: false }
const ctx = (budgetTokens: number) => ({ maxToolOutputChars: 1000, budgetTokens })
const read = (path: string) => ({ name: 'read_file', args: { path } })

test('native: the stub is tied to the read it removed, and a later read of that path is a reread', async () => {
  const cfg = harness({ tools, context: ctx(60), loop: { maxTurns: 6 } })
  const ev = await trace(cfg, [{ toolCalls: [read('a.txt')] }, { toolCalls: [read('b.txt')] }, { toolCalls: [read('a.txt')] }, { content: 'fin' }])
  const a = analyzeTrace(ev)
  const stubs = a.stubs as Stub[]
  expect(stubs[0]).toMatchObject({ turn: stubTurn(ev), status: 'matched', chars: 120, items: [{ callId: 'c1', what: 'read_file a.txt' }] })
  // the stub fires on the request of the turn that reads a.txt again, so the reread is at or after it
  expect(a.rereads.map(r => r.path)).toEqual(['a.txt'])
  expect(a.rereads[0].turn).toBeGreaterThanOrEqual(stubTurn(ev))
})

test('prompted json: one message holds a turn of results; every call in it is listed', async () => {
  const cfg = harness({ tools, context: ctx(90), loop: { maxTurns: 5 },
    toolCalls: { mode: 'prompted', enforceSchema: false, promptedTemplate: 'T:{{tools}}', parseErrorHint: 'HINT' } })
  const j = (calls: unknown[]) => ({ content: JSON.stringify({ calls, final: null }) })
  const ev = await trace(cfg, [j([read('a.txt'), read('b.txt')]), j([read('a.txt')]), j([read('b.txt')]), { content: JSON.stringify({ calls: [], final: 'fin' }) }])
  const s = (analyzeTrace(ev).stubs as Stub[])[0]
  expect(s).toMatchObject({ turn: stubTurn(ev), status: 'matched' })
  expect(s.items.map(i => i.what)).toEqual(['read_file a.txt', 'read_file b.txt'])
})

test('hermes: results inside <tool_response> are matched the same way', async () => {
  const cfg = harness({ tools, context: ctx(60), loop: { maxTurns: 5 },
    toolCalls: { mode: 'prompted', format: 'hermes', enforceSchema: false, promptedTemplate: 'T:{{tools}}', parseErrorHint: 'HINT' } })
  const b = (path: string) => ({ content: `<tool_call>\n${JSON.stringify({ name: 'read_file', arguments: { path } })}\n</tool_call>` })
  const ev = await trace(cfg, [b('a.txt'), b('b.txt'), b('a.txt'), { content: 'fin' }])
  expect((analyzeTrace(ev).stubs as Stub[])[0]).toMatchObject({ status: 'matched', items: [{ what: 'read_file a.txt' }] })
})

test('untilBash: the "not finished" message a stub removes is a final check', async () => {
  const cfg = harness({ tools, context: ctx(80), loop: { maxTurns: 5, untilBash: "printf '%0200d' 0; exit 1" } })
  const ev = await trace(cfg, [{ content: 'a' }, { content: 'b' }, { content: 'c' }, { content: 'd' }, { content: 'e' }])
  const items = (analyzeTrace(ev).stubs as Stub[]).flatMap(s => s.items)
  expect(items[0]).toEqual({ what: 'final check' })
})

test('two identical outputs in one stubbed message are two items; nothing else is pulled in', async () => {
  const cfg = harness({ tools, context: ctx(70), loop: { maxTurns: 5 },
    toolCalls: { mode: 'prompted', enforceSchema: false, promptedTemplate: 'T:{{tools}}', parseErrorHint: 'HINT' } })
  const j = (calls: unknown[]) => ({ content: JSON.stringify({ calls, final: null }) })
  const bash = (command: string) => ({ name: 'bash', args: { command } })
  const ev = await trace(cfg, [j([bash("printf '%0100d' 0"), bash("printf '%0100d' 0")]), j([read('a.txt')]), j([read('b.txt')]), { content: JSON.stringify({ calls: [], final: 'f' }) }])
  const s = (analyzeTrace(ev).stubs as Stub[])[0]
  expect(s.items.map(i => i.callId)).toEqual(['c1', 'c2'])
})

test('a context reset is not a stub', async () => {
  const cfg = harness({ tools, context: ctx(0), loop: { maxTurns: 6, maxRepeats: 3, freshContext: 1 } })
  const ev = await trace(cfg, [{ toolCalls: [read('a.txt')] }, { toolCalls: [read('a.txt')] }, { toolCalls: [read('a.txt')] }, { content: 'fin' }])
  expect(ev.some(e => e.type === 'context_reset')).toBe(true)
  expect(analyzeTrace(ev).stubs).toEqual([])
})

test('a [dropped: K] whose K does not match the previous content is unmatched, never guessed', () => {
  const req = (turn: number, contents: string[]) => ({ seq: turn * 10, turn, ts: 0, type: 'llm_request', payload: { messages: contents.map(content => ({ role: 'user', content })) } }) as HarnessEvent
  const ev: HarnessEvent[] = [req(1, ['s', 't']), req(2, ['s', 't', 'xxxx']), req(3, ['s', 't', '[dropped: 9 chars]'])]
  expect(analyzeTrace(ev).stubs).toEqual([{ turn: 3, chars: 9, status: 'unmatched', items: [] }])
})

test('a proxy-style trace (content not a string, no context_stats) does not throw and has no stubs', () => {
  const ev = [{ seq: 0, turn: 1, ts: 0, type: 'llm_request', payload: { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] } }] as HarnessEvent[]
  expect(analyzeTrace(ev).stubs).toEqual([])
})

test('a stub in a format this code does not write (the v2.10 labelled one) is still a stub: unmatched, with context_stats chars', () => {
  const req = (turn: number, contents: string[]) => ({ seq: turn * 10, turn, ts: 0, type: 'llm_request', payload: { messages: contents.map(content => ({ role: 'user', content })) } }) as HarnessEvent
  const ev: HarnessEvent[] = [
    req(1, ['s', 't']), req(2, ['s', 't', 'xxxx']),
    { seq: 25, turn: 3, ts: 0, type: 'context_stats', estimatedTokens: 9, budgetTokens: 5, droppedChars: 4 },
    req(3, ['s', 't', '[dropped: read_file {"path":"a"}, 4 chars]']),
  ]
  expect(analyzeTrace(ev).stubs).toEqual([{ turn: 3, chars: 4, status: 'unmatched', items: [] }])
})
