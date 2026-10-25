import { test, expect } from 'vitest'
import { createSSRApp } from 'vue'
import { renderToString } from 'vue/server-renderer'
// @ts-expect-error -- vue SFC, no .d.ts; typechecked separately by vue-tsc
import Trace from '../web/src/Trace.vue'
import type { HarnessEvent } from '../src/core/events.js'
import { en } from '../web/src/i18n'

const events: HarnessEvent[] = [
  { seq: 0, turn: 0, ts: 0, type: 'approval_required', call: { callId: 'mcp1', name: 'mcp:fs', args: { command: 'npx server' } } },
]
const render = (props: Record<string, unknown>) =>
  renderToString(createSSRApp(Trace, { events, live: {}, task: 'x', ...props }))

// App.vue's live Workbench never passes :approvable at all (only Bench.vue/Diff.vue pass
// :approvable="false" for a finished, replayed trace). A plain `approvable?: boolean` prop
// is a Boolean-typed prop to Vue, and Vue casts an ABSENT Boolean-typed prop to `false` --
// so omitting the prop must behave like "live and approvable", not like Bench's `false`.
test('omitting approvable renders live Run/Deny buttons, not the bench auto-approved text', async () => {
  const html = await render({})
  expect(html).toContain('<button>Run</button>')
  expect(html).not.toContain('auto-approved')
})

test('approvable=false (Bench/Diff replay) still renders the auto-approved text', async () => {
  const html = await render({ approvable: false })
  expect(html).toContain('auto-approved')
  expect(html).not.toContain('<button>Run</button>')
})

// Bench.vue and Diff.vue replay a trace and pass no :live at all. An absent object prop is `undefined`,
// and an open turn (llm_request with no llm_response yet) makes the template read live.reasoning and
// live.content -- which is where a missing default throws instead of rendering.
test('omitting live renders an open turn instead of throwing', async () => {
  const openTurn: HarnessEvent[] = [{ seq: 0, turn: 1, ts: 0, type: 'llm_request', payload: {} }]
  const html = await renderToString(createSSRApp(Trace, { events: openTurn, task: 'x', approvable: false }))
  expect(html).toContain('thinking')
})

// README promises the trace shows exactly what went to the model; a clipped retry has to say so.
test('a parse error whose text was kept out of the history says how much', async () => {
  const pe = (droppedChars?: number): HarnessEvent[] => [{ seq: 0, turn: 1, ts: 0, type: 'parse_error', message: 'truncated', content: 'x', droppedChars }]
  expect(await render({ events: pe(7765) })).toContain('7765 chars kept out of the history')
  expect(await render({ events: pe() })).not.toContain('kept out of the history')
})

const stubbed: HarnessEvent[] = [
  { seq: 0, turn: 1, ts: 0, type: 'llm_request', payload: { messages: [{ role: 'user', content: 'do' }] } },
  { seq: 1, turn: 1, ts: 0, type: 'tool_call', call: { callId: 'c1', name: 'read_file', args: { path: 'a.txt' } } },
  { seq: 2, turn: 1, ts: 0, type: 'tool_result', callId: 'c1', name: 'read_file', output: 'AAAA' },
  { seq: 3, turn: 2, ts: 0, type: 'llm_request', payload: { messages: [{ role: 'user', content: 'do' }, { role: 'assistant', content: '' }, { role: 'tool', content: 'AAAA' }] } },
  { seq: 4, turn: 3, ts: 0, type: 'context_stats', estimatedTokens: 9, budgetTokens: 5, droppedChars: 4 },
  { seq: 5, turn: 3, ts: 0, type: 'llm_request', payload: { messages: [{ role: 'user', content: 'do' }, { role: 'assistant', content: '' }, { role: 'tool', content: '[dropped: 4 chars]' }] } },
]

test('the trace says what the stub removed: a summary line, and a mark on the result', async () => {
  const html = await renderToString(createSSRApp(Trace, { events: stubbed, task: 'x', approvable: false }))
  expect(html).toContain('first stub t3 (ate: read_file a.txt)')
  expect(html).toContain('stubbed at t3')
})

test('an empty trace shows no summary line', async () => {
  const html = await renderToString(createSSRApp(Trace, { events: [], task: 'x', approvable: false }))
  expect(html).not.toContain('no stub')
})

const replay = (evs: HarnessEvent[]) => renderToString(createSSRApp(Trace, { events: evs, task: 'x', approvable: false }))

test('knobs the model does not take are said above the trace', async () => {
  const html = await replay([{ seq: 0, turn: 0, ts: 0, type: 'knobs_off', off: [{ knob: 'temperature', value: 0.2, reason: 'm takes no temperature (src)' }] }])
  expect(html).toContain('temperature 0.2 not sent: m takes no temperature (src)')
  expect(html.indexOf('not sent')).toBeLessThan(html.indexOf('class="ev user"'))
})

test('a reply with a cost shows it in dollars; without one there is no $', async () => {
  const reply = (costUsd?: number): HarnessEvent[] => [{ seq: 0, turn: 1, ts: 0, type: 'llm_response', raw: {}, content: 'hi', latencyMs: 5, ...costUsd === undefined ? {} : { costUsd } }]
  expect(await replay(reply(0.0012))).toContain('$0.0012')
  expect(await replay(reply())).not.toContain('$')
})

test('each turn says its request layers above the raw JSON, in either format', async () => {
  const html = await replay([
    { seq: 0, turn: 1, ts: 0, type: 'llm_request', payload: { system: 'abcd', tools: [{ name: 't', description: '', input_schema: {} }], messages: [{ role: 'user', content: 'do' }] } },
    { seq: 1, turn: 2, ts: 0, type: 'llm_request', payload: { messages: [{ role: 'system', content: 'ab' }, { role: 'user', content: 'do' }, { role: 'assistant', content: 'x' }] } },
  ])
  expect(html).toContain('system 4 chars · tools 1 · messages 1 · anthropic')
  expect(html).toContain('system 2 chars · tools 0 · messages 2 · openai')
  expect(html.indexOf('· anthropic')).toBeLessThan(html.indexOf('&quot;system&quot;'))
})

test('an mcp approval keeps the server and the command as <code> inside the question', async () => {
  const html = (await render({})).replace(/<!--[\s\S]*?-->/g, '')
  expect(html).toContain('start mcp server <code>fs</code>: <code>npx server</code>?')
})

test('proxy notes render: auxiliary with model, tokens and time; compaction with its explanation', async () => {
  const html = await renderToString(createSSRApp(Trace, { live: {}, task: 'x', events: [
    { seq: 0, turn: 0, ts: 0, type: 'proxy_note', kind: 'auxiliary', model: 'claude-haiku-fixture', usage: { promptTokens: 12, completionTokens: 3 }, latencyMs: 40 },
    { seq: 1, turn: 1, ts: 1, type: 'proxy_note', kind: 'compaction' },
  ] as HarnessEvent[] }))
  for (const s of ['auxiliary', 'claude-haiku-fixture', '12+3 tok', '40ms', 'compaction', en['trace.compaction']]) expect(html).toContain(s)
})
