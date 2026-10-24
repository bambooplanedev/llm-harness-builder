import { test, expect } from 'vitest'
import { createRenderer, nextTick } from 'vue'
// @ts-expect-error -- vue SFC, no .d.ts; typechecked separately by vue-tsc
import App from '../web/src/App.vue'
import { harness } from './helpers.js'

// Runs in the `dom` project (vitest.config.ts): .vue files compiled for the browser, so App mounts on the renderer below.
const anthropic = harness({ backend: { kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-x', temperature: 0.2, maxTokens: 1024, apiKeyEnv: 'ANTHROPIC_API_KEY' } })

/** A DOM-less renderer, enough to mount App and press its buttons: no component-testing dependency. */
type N = { tag: string; text: string; props: Record<string, any>; children: N[]; parent?: N; options: N[]; addEventListener(): void; removeEventListener(): void; getRootNode(): object }
const node = (tag: string, text = ''): N => ({ tag, text, props: {}, children: [], options: [], addEventListener() {}, removeEventListener() {}, getRootNode: () => ({}) })
const all = (n: N): N[] => [n, ...n.children.flatMap(all)]
const textOf = (n: N): string => n.text + n.children.map(textOf).join('')

test('with a key the app asks what the model takes only on the refresh button, never by itself', async () => {
  const { createApp } = createRenderer<N, N>({
    createElement: tag => node(tag), createText: t => node('#text', t), createComment: t => node('#comment', t),
    setText: (n, t) => { n.text = t }, setElementText: (n, t) => { n.children = [node('#text', t)] },
    insert: (c, p, anchor) => { c.parent?.children.splice(c.parent.children.indexOf(c), 1); c.parent = p; const i = anchor ? p.children.indexOf(anchor) : -1; i < 0 ? p.children.push(c) : p.children.splice(i, 0, c) },
    remove: c => { c.parent?.children.splice(c.parent.children.indexOf(c), 1); c.parent = undefined },
    parentNode: n => n.parent ?? null, nextSibling: n => n.parent?.children[n.parent.children.indexOf(n) + 1] ?? null,
    patchProp: (n, k, _, v) => { n.props[k] = v },
  })
  const calls: { url: string; body?: any }[] = []
  const answers: Record<string, unknown> = { '/api/harnesses': [{ name: 'k' }], '/api/harnesses/k': anthropic, '/api/runs': [], '/api/models': [], '/api/model-info': { takes: { temperature: false }, takesFrom: 'src' } }
  const saved = globalThis.fetch
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    return new Response(JSON.stringify(answers[url] ?? {}))
  }) as typeof fetch
  const settle = async () => { for (let i = 0; i < 5; i++) { await new Promise(r => setTimeout(r, 0)); await nextTick() } }
  try {
    const root = node('root')
    createApp(App).mount(root)
    await settle()
    expect(calls.map(c => c.url)).not.toContain('/api/model-info') // no model yet
    const load = all(root).find(n => n.tag === 'select')!
    load.props.onChange({ target: { value: 'k' } })
    await settle()
    const asked = () => calls.filter(c => c.url === '/api/model-info' || c.url === '/api/models').length
    const before = asked()
    expect(calls.at(-1)?.url).toBe('/api/harnesses/k')
    all(root).find(n => n.tag === 'button' && textOf(n) === '↻')!.props.onClick()
    await settle()
    expect(asked()).toBeGreaterThan(before)
    expect(calls.find(c => c.url === '/api/model-info')?.body).toEqual({ kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-x', apiKeyEnv: 'ANTHROPIC_API_KEY' })
    expect(textOf(root)).toContain('this knob is not available for this model')
    expect(textOf(root)).not.toContain('takes no tools')
    // A structural knob is not a box to lock: the run would be refused, so the warning stands above Run.
    answers['/api/model-info'] = { takes: { tools: false }, takesFrom: 'src' }
    all(root).find(n => n.tag === 'button' && textOf(n) === '↻')!.props.onClick()
    await settle()
    expect(textOf(root)).toMatch(/claude-x takes no tools \(src\): set toolCalls.mode: "prompted"Run/)
  } finally { globalThis.fetch = saved }
})
