import { test, expect, afterEach } from 'vitest'
import { createSSRApp } from 'vue'
import { renderToString } from 'vue/server-renderer'
// @ts-expect-error -- vue SFC, no .d.ts; typechecked separately by vue-tsc
import App from '../web/src/App.vue'
import { lang, initialLang, readLang, setLang, langName, t } from '../web/src/i18n'

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
