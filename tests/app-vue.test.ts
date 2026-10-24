import { test, expect, afterEach } from 'vitest'
import { createRenderer, nextTick } from 'vue'
// @ts-expect-error -- vue SFC, no .d.ts; typechecked separately by vue-tsc
import App from '../web/src/App.vue'
import { harness } from './helpers.js'

// Runs in the `dom` project (vitest.config.ts): .vue files compiled for the browser, so App mounts on the renderer below.
const anthropic = harness({ backend: { kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-x', temperature: 0.2, maxTokens: 1024, apiKeyEnv: 'ANTHROPIC_API_KEY' } })
const llama = harness({ backend: { kind: 'openai', baseUrl: 'http://127.0.0.1:8080/v1', model: 'qwen', temperature: 0.2 } })

/** A DOM-less renderer, enough to mount App, press its buttons and type into v-model boxes: no component-testing dependency. */
type N = { tag: string; text: string; value?: unknown; props: Record<string, any>; on: Record<string, ((e: object) => void)[]>; children: N[]; parent?: N; options: N[]
  addEventListener(type: string, fn: (e: object) => void): void; removeEventListener(): void; getRootNode(): object }
const node = (tag: string, text = ''): N => ({ tag, text, props: {}, on: {}, children: [], options: [],
  addEventListener(type, fn) { (this.on[type] ??= []).push(fn) }, removeEventListener() {}, getRootNode: () => ({}) })
const all = (n: N): N[] => [n, ...n.children.flatMap(all)]
const textOf = (n: N): string => n.text + n.children.map(textOf).join('')
const { createApp } = createRenderer<N, N>({
  createElement: tag => node(tag), createText: t => node('#text', t), createComment: t => node('#comment', t),
  setText: (n, t) => { n.text = t }, setElementText: (n, t) => { n.children = [node('#text', t)] },
  insert: (c, p, anchor) => { c.parent?.children.splice(c.parent.children.indexOf(c), 1); c.parent = p; const i = anchor ? p.children.indexOf(anchor) : -1; i < 0 ? p.children.push(c) : p.children.splice(i, 0, c) },
  remove: c => { c.parent?.children.splice(c.parent.children.indexOf(c), 1); c.parent = undefined },
  parentNode: n => n.parent ?? null, nextSibling: n => n.parent?.children[n.parent.children.indexOf(n) + 1] ?? null,
  patchProp: (n, k, _, v) => { n.props[k] = v },
})

const saved = globalThis.fetch
afterEach(() => { globalThis.fetch = saved })
const settle = async () => { for (let i = 0; i < 5; i++) { await new Promise(r => setTimeout(r, 0)); await nextTick() } }
/** Mounts App against a fetch that answers by URL; `infos` counts what the form asked of /api/model-info. */
async function mount(answers: Record<string, unknown>) {
  const calls: { url: string; body?: any }[] = []
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    return new Response(JSON.stringify(answers[url] ?? {}))
  }) as typeof fetch
  const root = node('root')
  createApp(App).mount(root)
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
