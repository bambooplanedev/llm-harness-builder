import { test, expect, afterEach } from 'vitest'
import { createSSRApp } from 'vue'
import { renderToString } from 'vue/server-renderer'
// @ts-expect-error -- vue SFC, no .d.ts; typechecked separately by vue-tsc
import App from '../web/src/App.vue'
// @ts-expect-error -- vue SFC, no .d.ts; typechecked separately by vue-tsc
import Bench from '../web/src/Bench.vue'
import { NEW_HARNESS } from '../web/src/advanced'
import { lang, initialLang, readLang, setLang, langName, t, tn, en, type Key } from '../web/src/i18n'
import { uk } from '../web/src/uk'
import { keyNote, type HarnessConfig } from '../src/core/config.js'
import { knobsOff } from '../src/core/knobs.js'
import { autoApproves } from '../src/core/bench.js'
import type { ServerInfo } from '../src/core/backends/types.js'
import { harness } from './helpers.js'

afterEach(() => { lang.value = 'en' })

test('tests render English: the page never reads the browser language by itself', () => expect(lang.value).toBe('en'))

test('initialLang: a stored en or uk wins; anything else falls back to the browser; uk-* is uk, the rest en', () => {
  expect(initialLang('en', 'uk-UA')).toBe('en')
  expect(initialLang('uk', 'en-US')).toBe('uk')
  for (const s of [null, undefined, '', 'de', 'UK', '"uk"']) expect(initialLang(s, 'uk-UA')).toBe('uk')
  expect(initialLang(null, 'UK')).toBe('uk')
  for (const n of ['en-US', 'ru-RU', undefined]) expect(initialLang(null, n)).toBe('en')
})

test('the choice survives a reload; a storage that throws switches anyway and reads as nothing', () => {
  const m = new Map<string, string>()
  const s = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }
  setLang('uk', s)
  expect(lang.value).toBe('uk'); expect(m.get('lhb.lang')).toBe('uk')
  expect(initialLang(readLang(s), 'en-US')).toBe('uk')
  const bad = { getItem: (): string | null => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } }
  expect(() => setLang('en', bad)).not.toThrow()
  expect(lang.value).toBe('en'); expect(readLang(bad)).toBeNull()
})

test('Settings: a native dialog with one radio per language, each named in its own language, the current one checked', async () => {
  const html = await renderToString(createSSRApp(App))
  expect(html).toMatch(/<dialog[^>]*>/)
  expect(html).toMatch(/<input type="radio" name="lang" value="en"[^>]*checked/)
  expect(html).toContain(langName('en')); expect(html).toContain(langName('uk'))
  lang.value = 'uk'
  const uk = await renderToString(createSSRApp(App))
  expect(uk).toMatch(/value="uk"[^>]*checked/)
  expect(uk).toContain(t('settings.title'))
})

const plain = (html: string) => html.replace(/<!--[\s\S]*?-->/g, '')

test('t fills {params}; a {name} with no param stays as written', () => {
  expect(t('bench.runsUnasked', { cmd: 'loop.untilBash: npm test' })).toBe('runs unasked · loop.untilBash: npm test')
  expect(t('bench.runsUnasked')).toBe('runs unasked · {cmd}')
})

test('Start here keeps its buttons inside the sentence, word for word as before', async () => {
  const html = plain(await renderToString(createSSRApp(App)))
  expect(html).toContain('Open an example run: <button class="link">PASS</button> and <button class="link">FAIL</button> — no model needed.')
  expect(html).toContain('Open the <button class="link">example bench</button>: the PASS table, intervals, ⇄ Diff.')
})

test('the empty Bench page keeps its <code> and its button inside the sentence', async () => {
  const html = plain(await renderToString(createSSRApp(Bench, { backend: NEW_HARNESS.backend, example: false })))
  expect(html).toContain('no benches yet: run <code>llm-harness-builder bench</code> or New bench, or open the <button class="link">Examples</button>')
  expect(html).toContain('this page reads only <code>runs/*.json</code> — a bench written with <code>--out</code> elsewhere will not show up here')
})

test('no v-html and no innerHTML in the page source: translated text never becomes markup', async () => {
  const { readFile } = await import('node:fs/promises')
  const { execFileSync } = await import('node:child_process')
  const root = new URL('..', import.meta.url).pathname
  const files = execFileSync('git', ['ls-files', 'web/src'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean)
  for (const f of files) expect(await readFile(new URL(`../${f}`, import.meta.url), 'utf8'), f).not.toMatch(/v-html|innerHTML/)
})

const hintKeys = (Object.keys(en) as Key[]).filter(k => k.startsWith('h.'))

test('all 44 hover hints have both sides, with the same line breaks', () => {
  expect(hintKeys).toHaveLength(44)
  for (const k of hintKeys) {
    expect(uk[k], k).toBeTruthy()
    expect(en[k].split('\n').length, k).toBe(uk[k]!.split('\n').length)
  }
})

test('a hint keeps its key names, commands and product names: every Latin word of the uk side is in the en side', () => {
  for (const k of hintKeys) for (const w of (uk[k]!.match(/[A-Za-z_][\w./<>{}]*/g) ?? []).map(w => w.replace(/\.+$/, ''))) expect(en[k], `${k}: ${w}`).toContain(w)
})

test('uk and en have exactly the same keys', () => expect(Object.keys(uk).sort()).toEqual(Object.keys(en).sort()))

test('every {placeholder} of a key is in both languages', () => {
  const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort()
  for (const k of Object.keys(en) as Key[]) expect(ph(uk[k]), k).toEqual(ph(en[k]))
})

test('under uk, Start here and a hint read in Ukrainian; buttons and labels stay English', async () => {
  lang.value = 'uk'
  const html = plain(await renderToString(createSSRApp(App)))
  expect(html).toContain(uk['start.title'])
  expect(html).toContain(`title="${uk['h.task']}">Task</label>`)
  expect(html).toContain('<button class="link">PASS</button>')
  expect(html).toContain('>Run</button>')
})

test('t falls back to English for a key the current language lacks, and still fills its {params}', () => {
  const u = uk as Partial<Record<Key, string>>, saved = u['bench.runsUnasked']
  delete u['bench.runsUnasked']
  try {
    lang.value = 'uk'
    expect(t('bench.runsUnasked', { cmd: 'npm test' })).toBe('runs unasked · npm test')
  } finally { u['bench.runsUnasked'] = saved }
})

test('tn: English one/other; Ukrainian one/few/many on 1, 2, 5, 11, 21', () => {
  expect([0, 1, 2].map(n => tn('diff.knobs', n))).toEqual(['config: 0 knobs differ', 'config: 1 knob differs', 'config: 2 knobs differ'])
  lang.value = 'uk'
  const f = (form: 'one' | 'few' | 'many', n: number) => uk[`diff.knobs.${form}`].replace('{n}', String(n))
  expect([1, 2, 5, 11, 21].map(n => tn('diff.knobs', n))).toEqual([f('one', 1), f('few', 2), f('many', 5), f('many', 11), f('one', 21)])
  expect([22, 25, 0].map(n => tn('diff.knobs', n))).toEqual([f('few', 22), f('many', 25), f('many', 0)])
})

test("the page's own copies of CLI lines read, in English, exactly as the CLI prints them", () => {
  expect(t('bench.autoApproves')).toBe(autoApproves('bench'))
  expect(t('form.keyNote', { env: 'X_API_KEY', host: '127.0.0.1:8080' })).toBe(keyNote({ apiKeyEnv: 'X_API_KEY', baseUrl: 'http://127.0.0.1:8080/v1' }))
  const h = harness() // native, tools on, model 'fake-model'
  const cases: [HarnessConfig, ServerInfo | undefined][] = [
    [h, { takes: { tools: false }, takesFrom: 'src' }],
    [h, { takes: { tools: false } }],
    [{ ...h, toolCalls: { ...h.toolCalls, mode: 'prompted', enforceSchema: true } }, { takes: { responseSchema: false }, takesFrom: 'src' }],
    [{ ...h, backend: { ...h.backend, kind: 'anthropic' } }, undefined],
  ]
  for (const [c, info] of cases) {
    const r = knobsOff(c, info)
    expect(t(`refuse.${r.refuseKind!}`, { model: 'fake-model', from: info?.takesFrom ? ` (${info.takesFrom})` : '' })).toBe(r.refuse)
  }
})
