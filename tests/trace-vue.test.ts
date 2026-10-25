import { test, expect, afterEach } from 'vitest'
import { createSSRApp } from 'vue'
import { renderToString } from 'vue/server-renderer'
// @ts-expect-error -- vue SFC, no .d.ts; typechecked separately by vue-tsc
import Trace from '../web/src/Trace.vue'
// @ts-expect-error -- vue SFC, no .d.ts; typechecked separately by vue-tsc
import Diff from '../web/src/Diff.vue'
import { setFilm } from '../web/src/film'
import { harness } from './helpers'
import type { HarnessEvent } from '../src/core/events.js'
import { readFileSync } from 'node:fs'
import { en } from '../web/src/i18n'
import { uk } from '../web/src/uk'
import { anatomy, anatomyLine } from '../src/core/anatomy.js'

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
const noBars = (evs: HarnessEvent[]) => renderToString(createSSRApp(Trace, { events: evs, task: 'x', approvable: false, bars: false }))

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

test('each request says its anatomy above the raw JSON, in either format; an empty body says nothing', async () => {
  const pa = { system: 'abcd', tools: [{ name: 't', description: '', input_schema: {} }], messages: [{ role: 'user', content: 'do' }] }
  const po = { messages: [{ role: 'system', content: 'ab' }, { role: 'user', content: 'do' }, { role: 'assistant', content: 'x' }] }
  const html = await noBars([
    { seq: 0, turn: 1, ts: 0, type: 'llm_request', payload: pa },
    { seq: 1, turn: 1, ts: 0, type: 'llm_response', raw: {}, content: '', latencyMs: 1, usage: { promptTokens: 40, completionTokens: 1 } },
    { seq: 2, turn: 2, ts: 0, type: 'llm_request', payload: po },
    { seq: 3, turn: 3, ts: 0, type: 'llm_request', payload: {} },
  ])
  const la = anatomyLine(anatomy(pa, { promptTokens: 40, completionTokens: 1 })!), lo = anatomyLine(anatomy(po)!)
  expect(html).toContain(la)
  expect(html).toContain(lo)
  expect(lo).toContain('≈')
  expect(html).toContain(en['trace.anatomyEstimate'])
  expect((html.match(new RegExp(en['trace.anatomyEstimate'], 'g')) ?? []).length).toBe(1) // not for the exact turn
  expect(html.indexOf(la)).toBeLessThan(html.indexOf('&quot;system&quot;'))
  expect(html.match(/ tok</g)?.length).toBe(2) // nothing for the empty body
})

test('the hints for prompted mode and for thinking blocks show up on their requests', async () => {
  const req = (payload: unknown): HarnessEvent[] => [{ seq: 0, turn: 1, ts: 0, type: 'llm_request', payload }]
  const th = await noBars(req({ messages: [{ role: 'user', content: 'do' }, { role: 'assistant', content: [{ type: 'thinking', thinking: 'hm' }, { type: 'text', text: 'ok' }] }] }))
  expect(th).toContain(en['trace.anatomyThinking'])
  const plain = await noBars(req({ messages: [{ role: 'user', content: 'do' }], tools: [{ type: 'function', function: { name: 't', parameters: {} } }] }))
  expect(plain).not.toContain(en['trace.anatomyToolsInSystem'])
  expect(plain).not.toContain(en['trace.anatomyThinking'])
  expect(await noBars(req({ messages: [{ role: 'user', content: 'do' }] }))).toContain(en['trace.anatomyToolsInSystem'])
})

test('the uk hints read the way the review asked', () => {
  expect(uk['trace.anatomySplit'].endsWith('\u043f\u0440\u0438\u0431\u043b\u0438\u0437\u043d\u043e \u0434\u043b\u044f \u043a\u043e\u0436\u043d\u043e\u0433\u043e \u0448\u0430\u0440\u0443, \u0442\u043e\u0447\u043d\u043e \u0432 \u0441\u0443\u043c\u0456.')).toBe(true)
  expect(uk['trace.anatomyToolsInSystem']).toContain('\u0440\u0435\u0436\u0438\u043c \u043f\u0440\u043e\u043c\u043f\u0442\u043e\u0432\u0438\u0445 \u0432\u0438\u043a\u043b\u0438\u043a\u0456\u0432')
})

const example = (id: string) => readFileSync(`example-runs/${id}.jsonl`, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(e => !('meta' in e))

test('the strip above the trace has one column per request, and comes before the first turn', async () => {
  const html = await replay(example('059867d3'))
  expect(html.match(/class="acol[ "]/g)?.length).toBe(5)
  expect(html.indexOf('class="anatomy"')).toBeLessThan(html.indexOf('class="turn"'))
  expect(html).toContain(en['trace.anatomyHow'])
})

test('no strip with bars off (Diff), and none for a trace without a readable request', async () => {
  expect(await noBars(example('059867d3'))).not.toContain('class="anatomy"')
  expect(await replay([{ seq: 0, turn: 1, ts: 0, type: 'llm_request', payload: {} }])).not.toContain('class="anatomy"')
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

afterEach(() => setFilm(false))

test('film mode: no model name or machine path anywhere in a rendered example trace', async () => {
  setFilm(true)
  const html = await renderToString(createSSRApp(Trace, { events: example('590eb245'), task: 'fix /tmp/lhb-example-590eb245/src', approvable: false }))
  expect(html).not.toMatch(/qwen3:8b|\/tmp\//)
  expect(html).toContain('class="acol') // the strip still shows
})

test('film mode: a live approval shows the command exactly as it will run', async () => {
  setFilm(true)
  const html = await render({ events: [{ seq: 0, turn: 1, ts: 0, type: 'approval_required', call: { callId: 'b1', name: 'bash', args: { command: 'cat /tmp/x/y' } } }] })
  expect(html).toContain('cat /tmp/x/y')
  expect(html).toContain('<button>Run</button>')
})

test('film mode: the Diff config table hides both models and servers', async () => {
  setFilm(true)
  const run = { round: 1, verdict: 'PASS', reason: 'final', turns: 1, toolCalls: 0, parseErrors: 0, ms: 1, workdir: 'w' }
  const side = (model: string, baseUrl: string) => ({ name: 'h', run, events: [], config: harness({ backend: { kind: 'openai', baseUrl, model } }) })
  const html = await renderToString(createSSRApp(Diff, { a: side('qwen3:8b', 'http://localhost:11434'), b: side('other-model', 'http://127.0.0.1:8080/v1'), task: 'x' }))
  expect(html).toContain('backend.model')
  expect(html).not.toMatch(/qwen3:8b|other-model|localhost:11434|127\.0\.0\.1:8080/)
})
