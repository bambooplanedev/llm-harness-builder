import { test, expect, afterEach, vi } from 'vitest'
import { createRenderer, nextTick, type App as VueApp } from 'vue'
// @ts-expect-error -- vue SFC, no .d.ts; typechecked separately by vue-tsc
import Proxy from '../web/src/Proxy.vue'

// Runs in the `dom` project (vitest.config.ts), on the same DOM-less renderer as app-vue.test.ts.
type N = { tag: string; text: string; value?: unknown; props: Record<string, any>; on: Record<string, ((e: object) => void)[]>; children: N[]; parent?: N
  addEventListener(type: string, fn: (e: object) => void): void; removeEventListener(): void }
const node = (tag: string, text = ''): N => ({ tag, text, props: {}, on: {}, children: [],
  addEventListener(type, fn) { (this.on[type] ??= []).push(fn) }, removeEventListener() {} })
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

const saved = globalThis.fetch
const apps: VueApp[] = []
afterEach(() => { apps.splice(0).forEach(a => a.unmount()); globalThis.fetch = saved; vi.restoreAllMocks() })
const settle = async () => { for (let i = 0; i < 5; i++) { await new Promise(r => setTimeout(r, 0)); await nextTick() } }

const item = (o: object) => ({ id: 'a', name: 'one', upstream: 'http://127.0.0.1:11434', port: 8090, started: 1000, lines: [], tail: '', ...o })
const run = (o: object) => ({ id: 'r', harness: 'one', task: 't', workdir: '', started: 2000, active: false, ...o })

/** Mounts Proxy against a fetch that answers by "METHOD url"; a function answer gets the body and may return a Response. */
async function mount(answers: Record<string, unknown>) {
  const calls: { key: string; body?: any }[] = []
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url}`, body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ key, body })
    const a = await (typeof answers[key] === 'function' ? (answers[key] as (b: any) => unknown)(body) : answers[key])
    return a instanceof Response ? a : new Response(JSON.stringify(a ?? {}))
  }) as typeof fetch
  const root = node('root'), opened: any[] = []
  const app = createApp(Proxy, { onOpen: (r: unknown) => opened.push(r) }); apps.push(app); app.mount(root)
  await settle()
  const find = (f: (n: N) => boolean) => all(root).find(f)!
  const button = (label: string, i = 0) => all(root).filter(n => n.tag === 'button' && textOf(n) === label)[i]
  const type = async (placeholder: string, v: string, i = 0) => {
    const box = all(root).filter(n => n.props.placeholder === placeholder)[i]
    box.value = v; box.on.input?.forEach(f => f({ target: box })); await settle()
  }
  return { root, calls, opened, find, button, type, text: () => textOf(root) }
}

test('Start posts exactly the form, drops empty "+ more" fields, and refreshes the list', async () => {
  const m = await mount({ 'GET /api/proxies': [], 'GET /api/runs': [], 'POST /api/proxies': item({}) })
  await m.type('http://127.0.0.1:11434', 'http://127.0.0.1:11434')
  await m.type('0', '8090'); await m.type('name', 'one')
  await m.type('/abs/path/dialect.mjs', '/abs/d1.mjs')
  m.button('+ more', 0).props.onClick(); await settle()
  await m.type('/abs/path/dialect.mjs', '/abs/d2.mjs', 1)
  m.button('+ more', 0).props.onClick(); await settle() // a third, left empty
  await m.type('/abs/path/connection.json', '/abs/c.json')
  m.button('Start').props.onClick(); await settle()
  expect(m.calls.find(c => c.key === 'POST /api/proxies')!.body).toEqual({
    upstream: 'http://127.0.0.1:11434', port: 8090, name: 'one', dialects: ['/abs/d1.mjs', '/abs/d2.mjs'], connections: ['/abs/c.json'] })
  expect(m.calls.filter(c => c.key === 'GET /api/proxies').length).toBeGreaterThan(1)
})

test('a 502 shows its error under the form and the list stays as it was', async () => {
  const one = item({})
  const m = await mount({ 'GET /api/proxies': [one], 'GET /api/runs': [], 'POST /api/proxies': new Response(JSON.stringify({ error: 'dialect x: no such file' }), { status: 502 }) })
  m.button('Start').props.onClick(); await settle()
  expect(m.find(n => n.props.class === 'err form-err').children.map(textOf).join('')).toContain('dialect x: no such file')
  expect(all(m.root).filter(n => n.props.class === 'proxy-card')).toHaveLength(1)
})

test('each item is a card with its lines, tail and its own sessions; Stop calls stopProxy(id) and disables itself while pending', async () => {
  const a = item({ id: 'a', name: 'one', started: 1000, lines: ['dialect d from /abs/d.mjs (replaces built-in)'], tail: 'record problem' })
  const b = item({ id: 'b', name: 'two', started: 1000, port: 8091 })
  const runs = [run({ id: 'run-late', harness: 'one', started: 2000 }), run({ id: 'run-edge', harness: 'one', started: 1000 }), run({ id: 'run-early', harness: 'one', started: 999 }), run({ id: 'run-othr', harness: 'two', started: 2000 })]
  let release!: () => void
  const gate = new Promise<void>(r => (release = r))
  const m = await mount({ 'GET /api/proxies': [a, b], 'GET /api/runs': runs, 'POST /api/proxies/a/stop': () => gate.then(() => ({ ok: true })) })
  const cards = all(m.root).filter(n => n.props.class === 'proxy-card')
  expect(cards).toHaveLength(2)
  const [c1, c2] = cards.map(textOf)
  expect(c1).toContain('dialect d from /abs/d.mjs (replaces built-in)'); expect(c1).toContain('record problem')
  expect(c1).toContain('run-late'); expect(c1).toContain('run-edge'); expect(c1).not.toContain('run-early'); expect(c1).not.toContain('run-othr')
  expect(c2).not.toContain('run-late'); expect(c2).toContain('run-othr')
  // clicking a session opens it
  all(cards[0]).find(n => n.props.class === 'session')!.props.onClick(); expect(m.opened.map(r => r.id)).toEqual(['run-late'])
  const stop = all(cards[0]).find(n => n.tag === 'button' && /^Stop|stopping/.test(textOf(n)))!
  stop.props.onClick(); await settle()
  expect(textOf(stop)).toBe('stopping…'); expect(stop.props.disabled).toBe(true)
  stop.props.onClick(); await settle()
  expect(m.calls.filter(c => c.key === 'POST /api/proxies/a/stop')).toHaveLength(1)
  release(); await settle()
})

test('a dead item shows its exit code and signal', async () => {
  const m = await mount({ 'GET /api/proxies': [item({ exit: { code: 1, signal: null }, tail: 'boom' }), item({ id: 'k', name: 'k', exit: { code: null, signal: 'SIGKILL' } })], 'GET /api/runs': [] })
  expect(m.text()).toContain('exited 1'); expect(m.text()).toContain('boom'); expect(m.text()).toContain('SIGKILL')
})

test('storage is never touched, and the poll stops on unmount', async () => {
  const get = vi.fn(), set = vi.fn()
  vi.stubGlobal('localStorage', { getItem: get, setItem: set, removeItem: set }); vi.stubGlobal('sessionStorage', { getItem: get, setItem: set, removeItem: set })
  const clear = vi.spyOn(globalThis, 'clearInterval')
  const m = await mount({ 'GET /api/proxies': [item({})], 'GET /api/runs': [] })
  m.button('Start').props.onClick(); await settle()
  apps.splice(0).forEach(a => a.unmount())
  expect(clear).toHaveBeenCalled()
  expect(get).not.toHaveBeenCalled(); expect(set).not.toHaveBeenCalled()
  vi.unstubAllGlobals()
})

test('a serve without a cli says start is unavailable and offers no Start', async () => {
  const m = await mount({ 'GET /api/proxies': new Response('{"error":"not found"}', { status: 404 }), 'GET /api/runs': [] })
  expect(m.text()).toContain('unavailable'); expect(m.button('Start')).toBeUndefined()
})

test('a failed Stop shows its error on its card, not under the form', async () => {
  const m = await mount({ 'GET /api/proxies': [item({ id: 'a' }), item({ id: 'b', name: 'two' })], 'GET /api/runs': [], 'POST /api/proxies/a/stop': new Response('{"error":"gone"}', { status: 404 }) })
  m.button('Stop', 0).props.onClick(); await settle()
  const cards = all(m.root).filter(n => n.props.class === 'proxy-card')
  expect(textOf(cards[0])).toContain('gone'); expect(textOf(cards[1])).not.toContain('gone')
  expect(all(m.root).filter(n => n.props.class === 'err form-err')).toHaveLength(0)
})
