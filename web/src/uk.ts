import type { Key } from './i18n'

/** The Ukrainian catalog: the only source file besides hints.ts where Cyrillic is allowed. */
export const uk: Partial<Record<Key, string>> = {
  'lang.name': 'Українська',
  'settings.title': 'Налаштування',
  'settings.language': 'Мова',
  'settings.close': 'Закрити',
}
