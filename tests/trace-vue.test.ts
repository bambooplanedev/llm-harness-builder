import { test, expect, afterEach } from 'vitest'
import { createSSRApp, createRenderer, nextTick, type App as VueApp } from 'vue'
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

test('film mode: an error that echoes the server url hides it once the url is passed in', async () => {
  setFilm(true)
  const evs: HarnessEvent[] = [{ seq: 0, turn: 1, ts: 0, type: 'error', message: 'fetch failed: http://localhost:11434/api/chat', body: 'localhost:11434 refused' }]
  const html = await renderToString(createSSRApp(Trace, { events: evs, approvable: false, names: { models: [], urls: ['http://localhost:11434'] } }))
  expect(html).toContain('server/api/chat')
  expect(html).not.toMatch(/localhost|11434/)
})

test('film mode: a live knobs_off before the first request hides the model the page passes in', async () => {
  setFilm(true)
  const evs: HarnessEvent[] = [{ seq: 0, turn: 0, ts: 0, type: 'knobs_off', off: [{ knob: 'temperature', value: 0.2, reason: 'qwen3:8b takes no temperature (src)' }] }]
  const html = await renderToString(createSSRApp(Trace, { events: evs, names: { models: ['qwen3:8b'], urls: [] } }))
  expect(html).toContain('model takes no temperature')
  expect(html).not.toContain('qwen3')
})

test('notes_loaded and note_written render in the trace', async () => {
  const b = { turn: 0, ts: 0 }
  const html = await render({ events: [
    { ...b, seq: 0, type: 'notes_loaded', ids: ['a', 'b'], chars: 90 },
    { ...b, seq: 1, type: 'note_written', notes: [{ id: 'c', text: 'use npm test' }] },
    { ...b, seq: 2, type: 'note_written', notes: [], error: 'reply is not JSON' },
  ] })
  expect(html).toContain('notes: 2 loaded')
  expect(html).toContain('note: use npm test')
  expect(html).toContain('note not written: reply is not JSON')
})

const reqEv = (seq: number, turn: number, payload: unknown): HarnessEvent => ({ seq, turn, ts: seq, type: 'llm_request', payload })
const body = (system: string, model = 'm1') => ({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: 'go' }] })
const inspector = (html: string, turn: number) => html.split('<div class="turn"').filter(s => s.includes(`turn ${turn} —`))[0] ?? ''

test('request diff: shown from the second request, not the first', async () => {
  const html = await render({ approvable: false, events: [reqEv(0, 1, body('be brief')), reqEv(1, 2, body('be long'))] })
  expect(inspector(html, 2)).toContain('changes since the previous request')
  expect(inspector(html, 2)).toContain('+ system: be long')
  expect(inspector(html, 2)).toContain('− system: be brief')
  expect(inspector(html, 1)).not.toContain('changes since')
})

test('request diff: an unreadable body gives no block', async () => {
  const html = await render({ approvable: false, events: [reqEv(0, 1, body('a')), reqEv(1, 2, { model: 'm1' })] })
  expect(html).not.toContain('changes since')
})

test('request diff: only appended messages is one muted line', async () => {
  const b2 = { ...body('a'), messages: [...body('a').messages, { role: 'assistant', content: 'ok' }] }
  const html = await render({ approvable: false, events: [reqEv(0, 1, body('a')), reqEv(1, 2, b2)] })
  expect(html).toContain('no change besides +1 appended')
})

test('request diff: film mode hides the model name in the block', async () => {
  setFilm(true)
  const html = await render({ approvable: false, events: [reqEv(0, 1, body('x', 'qwen3:8b')), reqEv(1, 2, body('y', 'qwen3:8b-b'))] })
  expect(html).toContain('changes since the previous request')
  expect(html).not.toContain('qwen3')
})

test('request diff: film mode replaces a model name inside a changed system line', async () => {
  setFilm(true)
  const evs = [reqEv(0, 1, body('using qwen3:8b', 'qwen3:8b')), reqEv(1, 2, body('now using qwen3:8b', 'qwen3:8b'))]
  const html = await render({ approvable: false, events: evs })
  expect(inspector(html, 2)).toContain('+ system: now using')
  expect(html).not.toContain('qwen3')
})

test('request diff: tool, history and param lines have their exact formats', async () => {
  const a = { model: 'm1', temperature: 0.2, tools: [{ name: 'gone' }, { name: 'edit', v: 1 }], messages: [{ role: 'user', content: 'one' }, { role: 'assistant', content: 'two' }, { role: 'user', content: 'three' }] }
  const b = { model: 'm1', temperature: 0.7, tools: [{ name: 'edit', v: 2 }, { name: 'new' }], messages: [{ role: 'user', content: 'one' }, { role: 'assistant', content: 'TWO' }] }
  const html = await render({ approvable: false, events: [reqEv(0, 1, a), reqEv(1, 2, b)] })
  for (const s of ['+ tool new', '− tool gone', '~ tool edit', 'history changed from #2', '#2: + TWO', '#2: − two', '−1 removed', 'temperature: 0.2 → 0.7']) expect(html).toContain(s)
})

test('request diff: an unreadable request between valid ones gives no block for either', async () => {
  const html = await render({ approvable: false, events: [reqEv(0, 1, { model: 'm1' }), reqEv(1, 2, body('a'))] })
  expect(html).not.toContain('changes since')
})

test('compare: the k-th request against the other run, titled with its id', async () => {
  const html = await render({ approvable: false, compareId: 'abc', compareEvents: [reqEv(0, 1, body('other prompt'))], events: [reqEv(0, 1, body('be long'))] })
  expect(inspector(html, 1)).toContain('vs abc request 1')
  expect(inspector(html, 1)).toContain('+ system: be long')
  expect(inspector(html, 1)).toContain('− system: other prompt')
})

test('compare: no k-th request there is a muted line; an unreadable body gives no block', async () => {
  const evs = [reqEv(0, 1, body('a')), reqEv(1, 2, body('a'))]
  const html = await render({ approvable: false, compareId: 'abc', compareEvents: [reqEv(0, 1, body('b'))], events: evs })
  expect(inspector(html, 2)).toContain('no request 2 there')
  expect(inspector(html, 1)).toContain('vs abc request 1')
  const bad = await render({ approvable: false, compareId: 'abc', compareEvents: [reqEv(0, 1, { model: 'm' })], events: [reqEv(0, 1, body('a'))] })
  expect(bad).not.toContain('vs abc')
  expect(bad).not.toContain('no request')
})

test('compare: nothing without a compare run; film hides names in the block', async () => {
  expect(await render({ approvable: false, events: [reqEv(0, 1, body('a'))] })).not.toContain('vs ')
  setFilm(true)
  const html = await render({ approvable: false, compareId: 'abc', compareEvents: [reqEv(0, 1, body('x', 'qwen3:8b'))], events: [reqEv(0, 1, body('y', 'qwen3:8b-b'))] })
  expect(html).toContain('vs abc request 1')
  expect(html).not.toContain('qwen3')
})

test('request diff: a block draws at most 100 lines and counts the rest', async () => {
  const sys = (n: number) => ({ model: 'm1', messages: [{ role: 'system', content: Array.from({ length: n }, (_, i) => `line ${i}`).join('\n') }, { role: 'user', content: 'go' }] })
  const html = await render({ approvable: false, events: [reqEv(0, 1, sys(0)), reqEv(1, 2, sys(150))] })
  expect(html).toContain('+ system: line 99')
  expect(html).not.toContain('+ system: line 100')
  expect(html).toContain('… 50 more lines')
})

test('compare: the vs block carries the vs hint, the in-run block the in-run hint', async () => {
  const html = await render({ approvable: false, compareId: 'abc', compareEvents: [reqEv(0, 1, body('a')), reqEv(1, 2, body('a'))], events: [reqEv(0, 1, body('b')), reqEv(1, 2, body('c'))] })
  const vs = en['trace.reqDiffVs'], inRun = en['trace.reqDiff']
  expect(html).toMatch(new RegExp(`title="${vs.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}">vs abc request 2`))
  expect(html).toContain(`title="${inRun}">changes since`)
  expect(uk['trace.reqDiffVs']).toBeTruthy()
})

test('film: a filmed diff is built once per diff object, not per render', async () => {
  setFilm(true)
  const html = await render({ approvable: false, events: [reqEv(0, 1, body('x', 'qwen3:8b')), reqEv(1, 2, body('y', 'qwen3:8b'))] })
  expect(html).toContain('+ system: y')
  expect(html).not.toContain('qwen3')
})

// Sources need an open inspector, so these mount Trace on a DOM-less renderer (as app-vue.test.ts) and fire `toggle`.
type N = { tag: string; text: string; props: Record<string, any>; children: N[]; parent?: N; open?: boolean }
const node = (tag: string, text = ''): N => ({ tag, text, props: {}, children: [] })
const all = (n: N): N[] => [n, ...n.children.flatMap(all)]
const textOf = (n: N): string => n.tag === '#comment' ? '' : n.text + n.children.map(textOf).join('')
const { createApp } = createRenderer<N, N>({
  createElement: tag => node(tag), createText: t => node('#text', t), createComment: t => node('#comment', t),
  setText: (n, t) => { n.text = t }, setElementText: (n, t) => { n.children = [node('#text', t)] },
  insert: (c, p, anchor) => { c.parent?.children.splice(c.parent.children.indexOf(c), 1); c.parent = p; const i = anchor ? p.children.indexOf(anchor) : -1; i < 0 ? p.children.push(c) : p.children.splice(i, 0, c) },
  remove: c => { c.parent?.children.splice(c.parent.children.indexOf(c), 1); c.parent = undefined },
  parentNode: n => n.parent ?? null, nextSibling: n => n.parent?.children[n.parent.children.indexOf(n) + 1] ?? null,
  patchProp: (n, k, _, v) => { n.props[k] = v },
})
const apps: VueApp[] = []
afterEach(() => { apps.splice(0).forEach(a => a.unmount()) })
/** Mounts Trace and opens every inspector, as a click on its summary would. */
async function opened(evs: HarnessEvent[]) {
  const root = node('root'), app = createApp(Trace, { events: evs, task: 'x', approvable: false, bars: false }); apps.push(app); app.mount(root)
  for (const d of all(root).filter(n => n.tag === 'details')) { d.open = true; d.props.onToggle({ target: d }) }
  await nextTick()
  const sources = () => all(root).find(n => n.props.class === 'sources')
  const row = (label: string) => all(sources()!).find(n => n.tag === 'button' && textOf(n).includes(label))!
  const click = async (label: string) => { row(label).props.onClick({}); await nextTick() }
  return { text: () => textOf(root), sources, click, row }
}
const cc = JSON.parse(readFileSync('tests/fixtures/cc-request.json', 'utf8'))
/** A user message that carries project files the way Claude Code does, then the person's words. */
const files = (fs: [path: string, text: string][], model = 'm1') => ({ model, messages: [{ role: 'user', content: [
  { type: 'text', text: `<system-reminder>\n${fs.map(([p, t]) => `Contents of ${p} (project instructions):\n\n${t}\n`).join('')}</system-reminder>` },
  { type: 'text', text: 'go' },
] }] })

test('sources: an open inspector lists where each part of a readable request came from', async () => {
  const v = await opened([reqEv(0, 1, cc)])
  expect(v.sources()).toBeDefined()
  const s = textOf(v.sources()!)
  for (const x of ['sources', '.claude/CLAUDE.md', 'you', 'billing header']) expect(s).toContain(x)
  expect(s).not.toMatch(/you\s+you/) // a label equal to its kind is said once
  expect((await opened([reqEv(0, 1, { model: 'm1' })])).sources()).toBeUndefined()
  expect((await opened([reqEv(0, 1, { model: 'm1', messages: [] })])).sources()).toBeUndefined() // no parts, no block
})

test('sources: closed inspectors show no block', async () => {
  const root = node('root'), app = createApp(Trace, { events: [reqEv(0, 1, cc)], task: 'x', approvable: false, bars: false }); apps.push(app); app.mount(root)
  expect(all(root).find(n => n.props.class === 'sources')).toBeUndefined()
})

test('sources: a row opens to its text; a long one is cut and counted', async () => {
  const v = await opened([reqEv(0, 1, { model: 'm1', messages: [{ role: 'user', content: 'y'.repeat(30000) }] })])
  expect(textOf(v.sources()!)).not.toContain('yyy')
  expect(v.row('you').props['aria-expanded']).toBe(false)
  await v.click('you')
  expect(v.row('you').props['aria-expanded']).toBe(true)
  expect(textOf(v.sources()!)).toContain('y'.repeat(20000))
  expect(textOf(v.sources()!)).not.toContain('y'.repeat(20001))
  expect(textOf(v.sources()!)).toContain('… 10000 more chars')
})

test('request diff: a line added to CLAUDE.md is named by its file', async () => {
  const a = files([['/home/u/proj/CLAUDE.md', 'keep it short']]), b = files([['/home/u/proj/CLAUDE.md', 'keep it short\nuse tabs']])
  const t = (await opened([reqEv(0, 1, a), reqEv(1, 2, b)])).text()
  expect(t).toContain('#1: + CLAUDE.md: use tabs') // a labelled message line keeps its place
  expect(t).not.toContain('#1: + use tabs')
})

test('request diff: a line found in two differently labelled parts stays unlabelled', async () => {
  const a = files([['/home/u/proj/CLAUDE.md', 'one'], ['/home/u/proj/NOTES.md', 'two']])
  const b = files([['/home/u/proj/CLAUDE.md', 'one\n---'], ['/home/u/proj/NOTES.md', 'two\n---']])
  const t = (await opened([reqEv(0, 1, a), reqEv(1, 2, b)])).text()
  expect(t).toContain('#1: + ---')
  expect(t).not.toMatch(/\+ (CLAUDE|NOTES)\.md: ---/)
})

test('sources, film mode: a file is its name only, rows do not open, a model inside a labelled line is replaced', async () => {
  setFilm(true)
  const a = files([['/home/u/proj/CLAUDE.md', 'keep it short']], 'qwen3:8b'), b = files([['/home/u/proj/CLAUDE.md', 'keep it short\nuse qwen3:8b']], 'qwen3:8b')
  const v = await opened([reqEv(0, 1, a), reqEv(1, 2, b)])
  expect(textOf(v.sources()!)).toContain('CLAUDE.md')
  expect(v.text()).not.toContain('/home/u')
  await v.click('CLAUDE.md')
  expect(v.row('CLAUDE.md').props['aria-expanded']).toBe(false)
  expect(textOf(v.sources()!)).not.toContain('keep it short')
  expect(v.text()).toContain('#1: + CLAUDE.md: use model')
  expect(v.text()).not.toContain('qwen3')
})

test('request diff: a labelled system line stays `+ <label>: line`', async () => {
  const sys = (t: string) => ({ model: 'm1', messages: [{ role: 'system', content: `<system-reminder>\nContents of /home/u/proj/CLAUDE.md (project):\n\n${t}\n</system-reminder>` }, { role: 'user', content: 'go' }] })
  const t = (await opened([reqEv(0, 1, sys('one')), reqEv(1, 2, sys('one\nuse tabs'))])).text()
  expect(t).toContain('+ CLAUDE.md: use tabs')
  expect(t).not.toContain(': + CLAUDE.md: use tabs')
})
