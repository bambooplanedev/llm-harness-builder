import { ref } from 'vue'
import { uk } from './uk'

export type Lang = 'en' | 'uk'
export const LANGS: readonly Lang[] = ['en', 'uk']

/** The English catalog: the source of truth for keys and the fallback for anything `uk` lacks. */
export const en = {
  'lang.name': 'English',
  'settings.title': 'Settings',
  'settings.language': 'Language',
  'settings.close': 'Close',
}
export type Key = keyof typeof en

const catalog: Record<Lang, Partial<Record<Key, string>>> = { en, uk }
/** Starts at English whatever the browser says: main.ts sets the real one, so tests render English. */
export const lang = ref<Lang>('en')

/** A stored en/uk wins; anything else follows the browser. */
export function initialLang(stored: string | null | undefined, navigatorLanguage: string | undefined): Lang {
  if (stored === 'en' || stored === 'uk') return stored
  return navigatorLanguage?.toLowerCase().startsWith('uk') ? 'uk' : 'en'
}
export function readLang(storage?: Pick<Storage, 'getItem'>): string | null {
  try { return (storage ?? localStorage).getItem('lhb.lang') } catch { return null }
}
export function setLang(l: Lang, storage?: Pick<Storage, 'setItem'>): void {
  lang.value = l
  try { (storage ?? localStorage).setItem('lhb.lang', l) } catch { /* private window: the choice lasts until reload */ }
}
export function t(key: Key, params?: Record<string, string | number>): string {
  const s = catalog[lang.value][key] ?? en[key]
  return params ? s.replace(/\{(\w+)\}/g, (m, n) => (n in params ? String(params[n]) : m)) : s
}
export const langName = (l: Lang): string => catalog[l]['lang.name'] ?? en['lang.name']
