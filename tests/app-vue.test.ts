import { test, expect, afterEach } from 'vitest'
import { createRenderer, nextTick, type App as VueApp } from 'vue'
// @ts-expect-error -- vue SFC, no .d.ts; typechecked separately by vue-tsc
import App from '../web/src/App.vue'
import { lang } from '../web/src/i18n'
import { uk } from '../web/src/uk'
import { harness } from './helpers.js'

// Runs in the `dom` project (vitest.config.ts): .vue files compiled for the browser, so App mounts on the renderer below.
const anthropic = harness({ backend: { kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-x', temperature: 0.2, maxTokens: 1024, apiKeyEnv: 'ANTHROPIC_API_KEY' } })
const llama = harness({ backend: { kind: 'openai', baseUrl: 'http://127.0.0.1:8080/v1', model: 'qwen', temperature: 0.2 } })

/** A DOM-less renderer, enough to mount App, press its buttons and type into v-model boxes: no component-testing dependency. */
type N = { tag: string; text: string; value?: unknown; props: Record<string, any>; on: Record<string, ((e: object) => void)[]>; children: N[]; parent?: N; options: N[]
  addEventListener(type: string, fn: (e: object) => void): void; removeEventListener(): void; getRootNode(): object; showModal(): void; close(): void; open?: boolean }
const node = (tag: string, text = ''): N => ({ tag, text, props: {}, on: {}, children: [], options: [],
  addEventListener(type, fn) { (this.on[type] ??= []).push(fn) }, removeEventListener() {}, getRootNode: () => ({}),
  showModal() { this.open = true }, close() { this.open = false } })
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

const saved = globalThis.fetch, savedConfirm = globalThis.confirm
const apps: VueApp[] = []
// Unmounted, so a poll App keeps while evolve runs never outlives its test.
afterEach(() => { apps.splice(0).forEach(a => a.unmount()); globalThis.fetch = saved; globalThis.confirm = savedConfirm; lang.value = 'en' })
const settle = async () => { for (let i = 0; i < 5; i++) { await new Promise(r => setTimeout(r, 0)); await nextTick() } }
/** Mounts App against a fetch that answers by URL (a function answer gets the body and may return a Response); `infos` counts what the form asked of /api/model-info. */
async function mount(answers: Record<string, unknown>) {
  const calls: { url: string; body?: any }[] = []
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ url, body })
    const a = typeof answers[url] === 'function' ? (answers[url] as (b: any) => unknown)(body) : answers[url]
    return a instanceof Response ? a : new Response(JSON.stringify(a ?? {}))
  }) as typeof fetch
  const root = node('root')
  const app = createApp(App); apps.push(app); app.mount(root)
  await settle()
  const find = (f: (n: N) => boolean) => all(root).find(f)!
  return {
    root, calls, infos: () => calls.filter(c => c.url === '/api/model-info'),
    load: async (name: string) => { find(n => n.tag === 'select').props.onChange({ target: { value: name } }); await settle() },
    refresh: async () => { find(n => n.tag === 'button' && textOf(n) === '↻').props.onClick(); await settle() },
    /** Keystrokes into the model box, then (if `commit`) the change a blur or Enter sends. */
    type: async (text: string, commit: boolean) => {
      const box = find(n => n.props.placeholder === 'or type a model id')
      for (let i = 1; i <= text.length; i++) { box.value = text.slice(0, i); box.on.input?.forEach(f => f({ target: box })); await settle() }
      if (commit) { box.on.change?.forEach(f => f({ target: box })); await settle() }
    },
  }
}

test('with a key the app asks what the model takes only on the refresh button, never by itself', async () => {
  const answers: Record<string, unknown> = { '/api/harnesses': [{ name: 'k' }], '/api/harnesses/k': anthropic, '/api/runs': [], '/api/models': [], '/api/model-info': { takes: { temperature: false }, takesFrom: 'src' } }
  const app = await mount(answers)
  await app.load('k')
  expect(app.calls.at(-1)?.url).toBe('/api/harnesses/k')
  await app.type('claude-y', true)
  expect(app.infos()).toEqual([])
  await app.refresh()
  expect(app.infos().map(c => c.body)).toEqual([{ kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-y', apiKeyEnv: 'ANTHROPIC_API_KEY' }])
  expect(textOf(app.root)).toContain('this knob is not available for this model')
  expect(textOf(app.root)).not.toContain('takes no tools')
  // A structural knob is not a box to lock: the run would be refused, so the warning stands above Run.
  answers['/api/model-info'] = { takes: { tools: false }, takesFrom: 'src' }
  await app.refresh()
  expect(textOf(app.root)).toMatch(/takes no tools \(src\): set toolCalls.mode: "prompted"Run/)
})

test('a keyless openai-compatible server (llama-server) is never asked what the model takes: its answer has no takes, and a router would load the model', async () => {
  const answers: Record<string, unknown> = { '/api/harnesses': [{ name: 'l' }], '/api/harnesses/l': llama, '/api/runs': [], '/api/models': [] }
  const app = await mount(answers) // the default backend is Ollama with no model; an empty list keeps it so, and the harness's backend loads
  await app.load('l')
  answers['/api/models'] = ['qwen']
  await app.refresh()
  await app.type('qwen2', true)
  expect(app.calls.filter(c => c.url === '/api/models').at(-1)?.body).toEqual({ kind: 'openai', baseUrl: 'http://127.0.0.1:8080/v1' })
  expect(app.infos()).toEqual([])
})

test('ollama without a key: model info once per committed model, not per keystroke', async () => {
  const app = await mount({ '/api/harnesses': [], '/api/runs': [], '/api/models': ['qwen3:8b'], '/api/model-info': { takes: { think: false }, takesFrom: 'Ollama /api/show' } })
  expect(app.infos().map(c => c.body.model)).toEqual(['qwen3:8b']) // the model the form picked from the list
  await app.type('gemma', false)
  expect(app.infos()).toHaveLength(1)
  await app.type('gemma', true)
  expect(app.infos().map(c => c.body.model)).toEqual(['qwen3:8b', 'gemma'])
})

test('emptying a context box leaves the knob out of the saved harness, an emptied context goes too, and a number puts it back', async () => {
  const answers: Record<string, unknown> = { '/api/harnesses': [{ name: 'c' }], '/api/harnesses/c': harness({ context: { maxToolOutputChars: 50, budgetTokens: 60 } }), '/api/runs': [], '/api/models': [] }
  const app = await mount(answers)
  await app.load('c')
  const box = (label: string) => { const span = all(app.root).find(n => n.tag === 'span' && textOf(n).startsWith(label))!; return span.parent!.children[span.parent!.children.indexOf(span) + 1] }
  const put = async (label: string, value: string) => { box(label).props.onChange({ target: { value } }); await settle() }
  const saved = async () => {
    all(app.root).find(n => n.tag === 'button' && textOf(n) === 'Save as')!.props.onClick(); await settle()
    return app.calls.filter(c => c.url.startsWith('/api/harnesses/') && c.body).at(-1)!.body
  }
  await put('max tool output chars', '')
  expect((await saved()).context).toEqual({ budgetTokens: 60 })
  await put('budget tokens', '')
  expect('context' in await saved()).toBe(false)
  await put('budget tokens', '0')
  expect((await saved()).context).toEqual({ budgetTokens: 0 })
  await put('max tool output chars', '99')
  expect((await saved()).context).toEqual({ maxToolOutputChars: 99, budgetTokens: 0 })
})

test('emptying a tools limit box leaves the key out of the saved harness, and a number puts it in', async () => {
  const answers: Record<string, unknown> = { '/api/harnesses': [{ name: 'c' }], '/api/harnesses/c': harness({ tools: { enabled: ['bash'], approveBash: false, readMaxBytes: 50, bashTimeoutS: 5 } }), '/api/runs': [], '/api/models': [] }
  const app = await mount(answers)
  await app.load('c')
  const box = (label: string) => { const span = all(app.root).find(n => n.tag === 'span' && textOf(n).startsWith(label))!; return span.parent!.children[span.parent!.children.indexOf(span) + 1] }
  const put = async (label: string, value: string) => { box(label).props.onChange({ target: { value } }); await settle() }
  const saved = async () => {
    all(app.root).find(n => n.tag === 'button' && textOf(n) === 'Save as')!.props.onClick(); await settle()
    return app.calls.filter(c => c.url.startsWith('/api/harnesses/') && c.body).at(-1)!.body.tools
  }
  await put('read_file max bytes', '')
  expect(await saved()).toEqual({ enabled: ['bash'], approveBash: false, bashTimeoutS: 5 })
  await put('bash max bytes', '99')
  await put('bash timeout', '')
  expect(await saved()).toEqual({ enabled: ['bash'], approveBash: false, bashMaxBytes: 99 })
})

test('a decimal comma in the temp box is a decimal point; text that is no number leaves it alone', async () => {
  const app = await mount({ '/api/harnesses': [{ name: 'c' }], '/api/harnesses/c': harness({ backend: { kind: 'ollama', baseUrl: 'http://localhost:11434', model: 'm', temperature: 0.7 } }), '/api/runs': [], '/api/models': [] })
  await app.load('c')
  const span = all(app.root).find(n => n.tag === 'span' && textOf(n) === 'temp')!
  const box = span.parent!.children[span.parent!.children.indexOf(span) + 1]
  const put = async (value: string) => { box.props.onChange({ target: { value } }); await settle() }
  const temp = () => {
    all(app.root).find(n => n.tag === 'button' && textOf(n) === 'Save as')!.props.onClick()
    return settle().then(() => app.calls.filter(c => c.url.startsWith('/api/harnesses/') && c.body).at(-1)!.body.backend.temperature)
  }
  await put('0,2')
  expect(await temp()).toBe(0.2)
  await put('abc')
  expect(await temp()).toBe(0.2)
})

test('Run without a model says to pick one, not the server\'s field name', async () => {
  const app = await mount({ '/api/harnesses': [], '/api/runs': [], '/api/models': [] })
  globalThis.fetch = (async () => new Response(JSON.stringify({ errors: ['backend.model is required'] }), { status: 400 })) as typeof fetch
  all(app.root).find(n => n.tag === 'button' && textOf(n) === 'Run')!.props.onClick(); await settle()
  expect(textOf(app.root)).toContain('pick or type a model first')
})

test('Create demo project fills Workdir; once the run is done, Check shows its verdict as a chip', async () => {
  const answers: Record<string, unknown> = { '/api/harnesses': [], '/api/runs': [], '/api/models': [], '/api/demo': { workdir: '/tmp/lhb-demo-x' }, '/api/demo/check': { verdict: 'FAIL' } }
  const app = await mount(answers)
  let es: { onmessage?: (m: { data: string }) => void } = {}
  const savedES = globalThis.EventSource
  globalThis.EventSource = class { static CLOSED = 2; constructor() { es = this } addEventListener() {} close() {} } as unknown as typeof EventSource
  try {
    const button = (t: string) => all(app.root).find(n => n.tag === 'button' && textOf(n) === t)
    button('Create demo project')!.props.onClick(); await settle()
    expect(all(app.root).find(n => n.props.placeholder === '/path/to/project')!.value).toBe('/tmp/lhb-demo-x')
    answers['/api/runs'] = { runId: 'r1' }
    button('Run')!.props.onClick(); await settle()
    answers['/api/runs'] = []
    expect(button('Check')).toBeUndefined() // not before the run is done
    es.onmessage!({ data: JSON.stringify({ seq: 0, turn: 0, ts: 0, type: 'done', reason: 'final' }) }); await settle()
    expect(textOf(app.root)).toContain('runs node --test on the code the model wrote')
    button('Check')!.props.onClick(); await settle()
    expect(app.calls.find(c => c.url === '/api/demo/check')?.body.workdir).toBe('/tmp/lhb-demo-x')
    expect(all(app.root).find(n => n.tag === 'span' && n.props.class?.includes?.('chip') && textOf(n) === 'FAIL')).toBeDefined()
  } finally { globalThis.EventSource = savedES }
})

test('the family note says what the button changed, and follows a language switch', async () => {
  const app = await mount({ '/api/harnesses': [], '/api/runs': [], '/api/models': [] })
  all(app.root).find(n => n.tag === 'button' && textOf(n) === 'qwen3')!.props.onClick(); await settle()
  expect(textOf(app.root)).toContain('qwen3: tool calls native → prompted; format json → hermes')
  lang.value = 'uk'; await settle()
  expect(textOf(app.root)).toContain(uk['family.mode'].replace('{a}', 'native').replace('{b}', 'prompted'))
})

test('a Claude Code session is one group: main first, subagents indented under it; a group without main still groups', async () => {
  const run = (id: string, started: number, task: string, extra: object = {}) => ({ id, harness: 'oc', task, workdir: '', started, active: false, ...extra })
  const A = 'aaaa1111-0000', B = 'bbbb2222-0000'
  const app = await mount({ '/api/harnesses': [], '/api/models': [], '/api/runs': [
    run('p1', 9, 'plain task'),
    run('s1', 8, 'sub gp', { session: A, agent: 'agent-1', parent: 'main', agentType: 'general-purpose' }),
    run('s2', 7, 'sub ex', { session: A, agent: 'agent-2', parent: 'main', agentType: 'Explore' }),
    run('m1', 6, 'main two', { session: A, agent: 'main' }),
    run('m0', 5, 'main one', { session: A, agent: 'main' }),
    run('s3', 4, 'sub plan', { session: B, agent: 'agent-3', parent: 'main', agentType: 'Plan' }),
    run('c1', 3, 'main alone', { session: 'cccc3333-0000', agent: 'main' }),
  ] })
  const cards = all(app.root).filter(n => n.tag === 'div' && n.props.class?.includes?.('runs')).flatMap(n => n.children)
  const text = textOf(app.root)
  const order = ['plain task', 'session aaaa…', 'main one', 'main two', '↳ subagent Explore', '↳ subagent general-purpose', 'session bbbb…', '↳ subagent Plan'].map(s => text.indexOf(s))
  expect(order.every(i => i >= 0)).toBe(true)
  expect(order).toEqual([...order].sort((a, b) => a - b))
  expect(textOf(cards.find(c => textOf(c).includes('session aaaa…'))!)).toContain('2 subagents')
  expect(textOf(cards.find(c => textOf(c).includes('session bbbb…'))!)).toContain('1 subagent · ')
  expect(textOf(cards.find(c => textOf(c).includes('session cccc…'))!)).not.toContain('subagent')
  const cls = (s: string) => String(cards.find(c => textOf(c).includes(s))!.props.class)
  expect(cls('sub ex')).toContain('sub'); expect(cls('main one')).toContain('session'); expect(cls('sub plan')).toMatch(/session/); expect(cls('plain task')).not.toContain('session')
  expect(cards.filter(c => /session/.test(String(c.props.class)))).toHaveLength(6)
})

// The Self-improvement window. Its dialog is in the tree while closed, so what it says is readable without opening it.
const button = (root: N, label: string) => all(root).find(n => n.tag === 'button' && textOf(n) === label)
const dialogOf = (root: N) => all(root).find(n => n.tag === 'dialog' && n.props['aria-labelledby'] === 'evolve-title')!
async function openWindow(app: Awaited<ReturnType<typeof mount>>, workdir = '/tmp/repo') {
  const box = all(app.root).find(n => n.props.placeholder === '/path/to/project')!
  box.value = workdir; box.on.input?.forEach(f => f({ target: box })); await settle()
  all(app.root).find(n => n.tag === 'button' && textOf(n).startsWith('Self-improvement…'))!.props.onClick(); await settle()
  expect(dialogOf(app.root).open).toBe(true)
}
const base = { '/api/runs': [], '/api/models': [], '/api/notes': { notes: [] } }

test('evolve running on another harness than the form: the button names its round', async () => {
  const app = await mount({ ...base, '/api/harnesses': [{ name: 'bare' }, { name: 'tuned' }], '/api/harnesses/bare': harness({ name: 'bare' }),
    '/api/evolve': { running: { harness: 'tuned', round: [2, 3], err: '--- round 2/3\nproposing' }, last: { harness: 'old', code: 0, signal: null, err: '', out: 'STALE REPORT' } } })
  await app.load('bare')
  const open = all(app.root).find(n => n.tag === 'button' && textOf(n).startsWith('Self-improvement…'))!
  expect(textOf(open)).toContain('Evolve: round 2/3')
  expect(textOf(open)).toContain('Notes off')
  const d = textOf(dialogOf(app.root))
  expect(d).toContain('round 2 of 3'); expect(d).toContain('tuned'); expect(d).toContain('proposing')
  expect(d).not.toContain('STALE REPORT') // the previous job's result, while a new one runs
  expect(button(app.root, 'Start')!.props.disabled).toBe(true)
})

test('Start without consent shows the sets and the commands; Start waits for the checkbox and then sends the hash', async () => {
  const consent = { consent: { text: 'CONSENT TEXT', hash: 'h1' }, sets: { train: 5, gate: 4, test: 3 }, declarable: true, needed: 6, uncommitted: true }
  const app = await mount({ ...base, '/api/harnesses': [{ name: 'tuned' }],
    '/api/evolve/start': (b: any) => b.accept ? new Response('{}', { status: 201 }) : new Response(JSON.stringify(consent), { status: 409 }) })
  await openWindow(app)
  button(app.root, 'Start')!.props.onClick(); await settle()
  const d = textOf(dialogOf(app.root))
  for (const s of ['5 tasks it learns from', '4 check tasks Evolve never sees', '3 final test', 'CONSENT TEXT', 'at least 6 tasks go FAIL → PASS', 'uncommitted changes are not in the clones', 'for hours without asking'])
    expect(d).toContain(s)
  expect(app.calls.find(c => c.url === '/api/evolve/start')!.body).toEqual({ harness: 'tuned', repo: '/tmp/repo', mode: 'hours' })
  expect(button(app.root, 'Start')!.props.disabled).toBe(true)
  const box = all(dialogOf(app.root)).find(n => n.tag === 'input' && n.props.type === 'checkbox')!
  box.props.onChange({ target: { checked: true } }); await settle()
  expect(button(app.root, 'Start')!.props.disabled).toBe(false)
  button(app.root, 'Start')!.props.onClick(); await settle()
  expect(app.calls.filter(c => c.url === '/api/evolve/start').at(-1)!.body).toEqual({ harness: 'tuned', repo: '/tmp/repo', mode: 'hours', accept: 'h1' })
  expect(app.calls.at(-1)!.url).toBe('/api/evolve') // the status, asked again once the start went through
})

test('a non-strict consent shows the reference line as a warning', async () => {
  const consent = { consent: { text: 'C', hash: 'h' }, sets: { train: 1, gate: 1, test: 1 }, declarable: false, reference: 'too few tasks (3 of 24)', uncommitted: false }
  const app = await mount({ ...base, '/api/harnesses': [{ name: 'tuned' }], '/api/evolve/start': () => new Response(JSON.stringify(consent), { status: 409 }) })
  await openWindow(app)
  button(app.root, 'Start')!.props.onClick(); await settle()
  expect(all(dialogOf(app.root)).find(n => String(n.props.class).includes('warn') && textOf(n) === 'too few tasks (3 of 24)')).toBeDefined()
  expect(textOf(dialogOf(app.root))).not.toContain('uncommitted changes')
})

test('a finished evolve shows its report; one that failed shows why', async () => {
  const ok = await mount({ ...base, '/api/harnesses': [], '/api/evolve': { last: { harness: 'tuned', code: 0, signal: null, err: '', out: 'REPORT' } } })
  expect(textOf(dialogOf(ok.root))).toContain('REPORT')
  expect(textOf(all(ok.root).find(n => n.tag === 'button' && textOf(n).startsWith('Self-improvement…'))!)).toContain('Evolve: idle')
  await openWindow(ok)
  button(ok.root, 'Keep original')!.props.onClick(); await settle()
  expect(dialogOf(ok.root).open).toBe(false)
  const bad = await mount({ ...base, '/api/harnesses': [], '/api/evolve': { last: { harness: 'tuned', code: 2, signal: null, err: 'error: cannot reach', out: '' } } })
  expect(textOf(dialogOf(bad.root))).toContain('cannot reach')
  expect(textOf(dialogOf(bad.root))).toContain('code 2')
})

test('notes: × deletes one, Clear notes asks first and posts nothing on no', async () => {
  const app = await mount({ ...base, '/api/harnesses': [], '/api/notes': { notes: [{ id: 'n1', ts: 0, run: 'r9', author: 'model', text: 'hello note' }] } })
  await openWindow(app)
  expect(app.calls.filter(c => c.url === '/api/notes').map(c => c.body)).toEqual([{ repo: '/tmp/repo' }])
  const d = textOf(dialogOf(app.root))
  expect(d).toContain('hello note'); expect(d).toContain('model'); expect(d).toContain('r9')
  all(dialogOf(app.root)).find(n => n.tag === 'button' && n.props['aria-label'] === 'Delete note')!.props.onClick(); await settle()
  expect(app.calls.filter(c => c.url === '/api/notes').at(-1)!.body).toEqual({ repo: '/tmp/repo', delete: 'n1' })
  const before = app.calls.length
  let asked = ''
  globalThis.confirm = (m?: string) => { asked = String(m); return false }
  button(app.root, 'Clear notes')!.props.onClick(); await settle()
  expect(asked).toBeTruthy()
  expect(app.calls.length).toBe(before)
  globalThis.confirm = () => true
  button(app.root, 'Clear notes')!.props.onClick(); await settle()
  expect(app.calls.at(-1)!.body).toEqual({ repo: '/tmp/repo', delete: 'all' })
})

test('under uk the lede is Ukrainian, the buttons stay English', async () => {
  lang.value = 'uk'
  const app = await mount({ ...base, '/api/harnesses': [] })
  expect(textOf(dialogOf(app.root))).toContain(uk['evolve.lede'])
  for (const b of ['Start', 'Clear notes']) expect(button(app.root, b)).toBeDefined()
  expect(all(app.root).find(n => n.tag === 'button' && textOf(n).startsWith('Self-improvement…'))).toBeDefined()
})

test('Esc and × only hide the window: nothing goes to /api/evolve/stop', async () => {
  const app = await mount({ ...base, '/api/harnesses': [{ name: 'tuned' }], '/api/evolve': { running: { harness: 'tuned', err: '' } } })
  await openWindow(app)
  const d = dialogOf(app.root)
  // Esc is the native dialog's own cancel: no listener of ours, so only × is pressed here.
  all(d).find(n => n.tag === 'button' && n.props['aria-label'] === 'Close')!.props.onClick(); await settle()
  expect(d.open).toBe(false)
  expect(app.calls.some(c => c.url === '/api/evolve/stop')).toBe(false)
  expect(button(app.root, 'Stop — resume later')).toBeDefined()
})

test('a note is text, never markup', async () => {
  const app = await mount({ ...base, '/api/harnesses': [], '/api/notes': { notes: [{ id: 'x', ts: 0, author: 'user', text: '<img src=x onerror=alert(1)>' }] } })
  await openWindow(app)
  expect(textOf(dialogOf(app.root))).toContain('<img src=x onerror=alert(1)>')
  expect(all(app.root).some(n => n.tag === 'img')).toBe(false)
})

test('Stop says it is stopping and stays disabled until the job is gone', async () => {
  const answers: Record<string, unknown> = { ...base, '/api/harnesses': [{ name: 'tuned' }], '/api/evolve': { running: { harness: 'tuned', err: '' } }, '/api/evolve/stop': { ok: true } }
  const app = await mount(answers)
  await openWindow(app)
  button(app.root, 'Stop — resume later')!.props.onClick(); await settle()
  expect(app.calls.filter(c => c.url === '/api/evolve/stop')).toHaveLength(1)
  expect(button(app.root, 'Stop — resume later')!.props.disabled).toBe(true) // still running: the poll said so
  expect(textOf(dialogOf(app.root))).toContain('stopping…: Evolve ends the current run, this can take up to a minute')
  answers['/api/evolve'] = { last: { harness: 'tuned', code: 130, signal: null, err: '', out: '' } }
  await openWindow(app)
  expect(textOf(dialogOf(app.root))).toContain('Evolve on tuned was stopped. Start with the same harness and repo to go on.')
  answers['/api/evolve'] = { running: { harness: 'tuned', err: '' } }
  await openWindow(app)
  expect(button(app.root, 'Stop — resume later')!.props.disabled).toBe(false)
})

test('each open picks the harness the form holds again', async () => {
  const app = await mount({ ...base, '/api/harnesses': [{ name: 'a' }, { name: 'b' }], '/api/harnesses/a': harness({ name: 'a' }), '/api/harnesses/b': harness({ name: 'b' }),
    '/api/evolve/start': () => new Response('{}', { status: 201 }) })
  await app.load('a')
  await openWindow(app)
  button(app.root, 'Start')!.props.onClick(); await settle()
  expect(app.calls.filter(c => c.url === '/api/evolve/start').at(-1)!.body.harness).toBe('a')
  all(dialogOf(app.root)).find(n => n.props['aria-label'] === 'Close')!.props.onClick()
  await app.load('b')
  await openWindow(app)
  button(app.root, 'Start')!.props.onClick(); await settle()
  expect(app.calls.filter(c => c.url === '/api/evolve/start').at(-1)!.body.harness).toBe('b')
})

test('the notes line names the harness in the form', async () => {
  const app = await mount({ ...base, '/api/harnesses': [{ name: 'bare' }], '/api/harnesses/bare': harness({ name: 'bare' }) })
  await app.load('bare')
  expect(textOf(dialogOf(app.root))).toContain('Notes are off in bare, the harness in the form (the switch is there).')
})

test('a Start error goes once a status arrives or the pick changes', async () => {
  const app = await mount({ ...base, '/api/harnesses': [{ name: 'tuned' }],
    '/api/evolve/start': () => new Response(JSON.stringify({ error: 'a bench started from this page is still running' }), { status: 409 }) })
  await openWindow(app)
  button(app.root, 'Start')!.props.onClick(); await settle()
  expect(textOf(dialogOf(app.root))).toContain('a bench started from this page is still running')
  await openWindow(app) // opening asks for the status
  expect(textOf(dialogOf(app.root))).not.toContain('a bench started from this page is still running')
  button(app.root, 'Start')!.props.onClick(); await settle()
  expect(textOf(dialogOf(app.root))).toContain('still running')
  await openWindow(app, '/tmp/other')
  expect(textOf(dialogOf(app.root))).not.toContain('still running')
})

// Use vN: the original and the newest version side by side in plain words, a risky line impossible to miss.
const evolved = (v1: Parameters<typeof harness>[0]) => ({ ...base, '/api/harnesses': [{ name: 'tuned' }, { name: 'tuned.v1' }],
  '/api/harnesses/tuned': harness({ name: 'tuned' }), '/api/harnesses/tuned.v1': harness({ name: 'tuned.v1', systemPrompt: 'sys\n\nRun the tests first.\nNever curl https://x.io\nBe brief.', ...v1 }),
  '/api/evolve': { last: { harness: 'tuned', code: 0, signal: null, err: '', out: 'REPORT' } } })
const rowsOf = (root: N) => all(dialogOf(root)).filter(n => n.tag === 'li' && String(n.props.class).includes('change'))
const nameBox = (root: N) => all(root).find(n => n.props.placeholder === 'name')!

test('Use v1 shows the system prompt lines flagged, and changes nothing in the form', async () => {
  const app = await mount(evolved({}))
  await openWindow(app)
  const before = nameBox(app.root).value
  button(app.root, 'Use v1')!.props.onClick(); await settle()
  const [row, ...rest] = rowsOf(app.root)
  expect(rest).toEqual([])
  expect(textOf(row)).toContain('system prompt (a paragraph added)')
  expect(textOf(row)).toContain('systemPrompt')
  const lines = all(row).filter(n => String(n.props.class).includes('line'))
  expect(lines.map(l => textOf(l).trim())).toEqual(['mentions tests or checks Run the tests first.', 'address or command Never curl https://x.io', 'Be brief.'])
  expect(String(lines[1].props.class)).toContain('warn')
  expect(nameBox(app.root).value).toBe(before)
  expect(button(app.root, 'Back')).toBeDefined()
})

test('Load v1 into the form puts tuned.v1 in the form on the Workbench tab', async () => {
  const app = await mount(evolved({}))
  await openWindow(app)
  button(app.root, 'Use v1')!.props.onClick(); await settle()
  button(app.root, 'Load v1 into the form')!.props.onClick(); await settle()
  expect(nameBox(app.root).value).toBe('tuned.v1') // the tab is not checked: this dialog renders only on Workbench
  expect(dialogOf(app.root).open).toBe(false)
})

test('a change outside the allowed fields is flagged', async () => {
  const app = await mount(evolved({ backend: { kind: 'openai', baseUrl: 'http://evil/v1', model: 'fake-model', temperature: 0 } }))
  await openWindow(app)
  button(app.root, 'Use v1')!.props.onClick(); await settle()
  const row = rowsOf(app.root).find(r => textOf(r).includes('backend.baseUrl'))!
  expect(textOf(row)).toContain('outside what Evolve may change')
  expect(String(row.props.class)).toContain('warn')
  expect(textOf(row)).toContain('not loaded: the form keeps its own backend')
})

test('a system prompt changed only in blank lines or order says so instead of an empty row', async () => {
  const app = await mount(evolved({ systemPrompt: 'sys\n\n' }))
  await openWindow(app)
  button(app.root, 'Use v1')!.props.onClick(); await settle()
  const [row] = rowsOf(app.root)
  expect(textOf(row)).toContain('only blank lines or line order changed')
  expect(all(row).some(n => String(n.props.class).includes('line'))).toBe(false)
})

// The final review's findings: what the window says has to be true.
const urlBox = (root: N) => all(root).find(n => n.tag === 'input' && !!n.parent?.children.some(c => c.tag === 'select' && textOf(c).includes('openai-compatible')))!
test('Load v1 with a rewritten backend keeps the form\'s backend even on a fresh page, as its note says', async () => {
  const app = await mount(evolved({ backend: { kind: 'openai', baseUrl: 'http://evil/v1', model: 'fake-model', temperature: 0 } }))
  await openWindow(app)
  const before = urlBox(app.root).value
  expect(before).not.toBe('http://evil/v1')
  button(app.root, 'Use v1')!.props.onClick(); await settle()
  button(app.root, 'Load v1 into the form')!.props.onClick(); await settle()
  expect(nameBox(app.root).value).toBe('tuned.v1')
  expect(urlBox(app.root).value).toBe(before)
})

test('Load v1 with no backend row on a fresh page still takes its backend, as any load does', async () => {
  const app = await mount(evolved({}))
  await openWindow(app)
  button(app.root, 'Use v1')!.props.onClick(); await settle()
  expect(rowsOf(app.root).some(r => textOf(r).includes('backend.'))).toBe(false)
  button(app.root, 'Load v1 into the form')!.props.onClick(); await settle()
  expect(urlBox(app.root).value).toBe('http://x/v1')
})

test('while a job runs, the disabled Harness select shows the running harness, not the form\'s', async () => {
  const app = await mount({ ...base, '/api/harnesses': [{ name: 'bare' }, { name: 'tuned' }], '/api/harnesses/bare': harness({ name: 'bare' }),
    '/api/evolve': { running: { harness: 'tuned', err: '' } } })
  await app.load('bare')
  await openWindow(app)
  const sel = all(dialogOf(app.root)).find(n => n.tag === 'select' && n.props.id === 'evolve-harness')!
  expect(sel.props.disabled).toBe(true)
  expect(sel.props.value).toBe('tuned')
})

test('while a bench runs the window says so, not that nothing runs', async () => {
  const app = await mount({ ...base, '/api/harnesses': [{ name: 'tuned' }], '/api/evolve': { bench: true } })
  await openWindow(app)
  const d = textOf(dialogOf(app.root))
  expect(d).toContain('A bench is running.')
  expect(d).not.toContain('Nothing is running.')
})

test('a Start refused because another tab started a job asks for the status: the window shows it running', async () => {
  const answers: Record<string, unknown> = { ...base, '/api/harnesses': [{ name: 'tuned' }],
    '/api/evolve/start': () => new Response(JSON.stringify({ error: 'an evolve started from this page is still running' }), { status: 409 }) }
  const app = await mount(answers)
  await openWindow(app)
  answers['/api/evolve'] = { running: { harness: 'tuned', err: '' } } // the other tab's job
  button(app.root, 'Start')!.props.onClick(); await settle()
  const d = textOf(dialogOf(app.root))
  expect(d).toContain('an evolve started from this page is still running')
  expect(d).toContain('Evolve is running on tuned.')
  expect(d).not.toContain('Nothing is running.')
})

test('once a job is gone the status is asked once more, for the report\'s tail and the Use button; then polling stops', async () => {
  const answers: Record<string, unknown> = { ...base, '/api/harnesses': [{ name: 'tuned' }, { name: 'tuned.v1' }], '/api/evolve': { running: { harness: 'tuned', err: '' } } }
  const app = await mount(answers)
  answers['/api/evolve'] = { last: { harness: 'tuned', code: 0, signal: null, err: '', out: 'PART' } }
  await openWindow(app)
  expect(textOf(dialogOf(app.root))).toContain('PART')
  answers['/api/evolve'] = { last: { harness: 'tuned', code: 0, signal: null, err: '', out: 'PART AND THE REST' } }
  await new Promise(r => setTimeout(r, 2100)); await settle()
  expect(textOf(dialogOf(app.root))).toContain('PART AND THE REST')
  const asked = app.calls.filter(c => c.url === '/api/evolve').length
  await new Promise(r => setTimeout(r, 2100)); await settle()
  expect(app.calls.filter(c => c.url === '/api/evolve').length).toBe(asked) // one extra ask, not a loop
}, 10000)

test('a Start with a yes that comes back with consent again says the commands changed', async () => {
  let n = 0
  const consent = () => ({ consent: { text: `COMMANDS ${++n}`, hash: `h${n}` }, sets: { train: 1, gate: 1, test: 1 }, declarable: true, needed: 1, uncommitted: false })
  const app = await mount({ ...base, '/api/harnesses': [{ name: 'tuned' }], '/api/evolve/start': () => new Response(JSON.stringify(consent()), { status: 409 }) })
  await openWindow(app)
  const said = 'The commands changed since you accepted them; read them again.'
  button(app.root, 'Start')!.props.onClick(); await settle()
  expect(textOf(dialogOf(app.root))).not.toContain(said)
  all(dialogOf(app.root)).find(n => n.tag === 'input' && n.props.type === 'checkbox')!.props.onChange({ target: { checked: true } }); await settle()
  button(app.root, 'Start')!.props.onClick(); await settle()
  const d = textOf(dialogOf(app.root))
  expect(d).toContain(said); expect(d).toContain('COMMANDS 2')
  expect(d.indexOf(said)).toBeLessThan(d.indexOf('COMMANDS 2'))
})
