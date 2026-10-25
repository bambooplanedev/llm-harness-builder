// web/src/film.ts — ?film=1: a screen to record. Model names, server addresses and machine paths are replaced on display
// only (the trace and its files stay as they are). A display convenience, not privacy protection.
import { ref } from 'vue'
import type { HarnessEvent } from './api'

export type FilmNames = { models: string[]; urls: string[] }

export const film = ref(false)

/** Sets film mode; the page's CSS keys off <html data-film>. */
export function setFilm(on: boolean): void {
  film.value = on
  if (typeof document !== 'undefined') document.documentElement.toggleAttribute('data-film', on)
}

const replace = (s: string, from: string, to: string) => from && s.includes(from) ? s.split(from).join(to) : s
/** Absolute paths of two segments or more, a file:// url's too; one-segment ones (/no_think, /v1), relative paths, regex
 *  literals and other urls stay. */
const PATH = /(?:(?<![\w.:/~-])|(?<=file:\/\/))\/(?:[\w.@+-]+\/)+[\w.@+-]*/g

/** `s` with every url (and its host) as `server`, every model name of 3+ chars (longest first) as `model`, and absolute paths as `…/`. */
export function filmText(s: string, n: FilmNames): string {
  for (const u of n.urls) {
    s = replace(s, u, 'server')
    try { s = replace(s, new URL(u).host, 'server') } catch { /* not a url */ }
  }
  for (const m of n.models.filter(m => m.length >= 3).sort((a, b) => b.length - a.length)) s = replace(s, m, 'model')
  return s.replace(PATH, '…/')
}

/** A copy with every string (keys too) through filmText: plain objects and arrays, as redactor's walk. The input is never changed. */
export function filmDeep<T>(x: T, n: FilmNames): T {
  const walk = (x: unknown): unknown => {
    if (typeof x === 'string') return filmText(x, n)
    if (Array.isArray(x)) return x.map(walk)
    if (x !== null && typeof x === 'object' && Object.getPrototypeOf(x) === Object.prototype) {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(x)) out[filmText(k, n)] = walk(v)
      return out
    }
    return x
  }
  return walk(x) as T
}

/** Every model a trace names: payload.model, raw.model and a proxy note's model (Claude Code mixes a main and an auxiliary one). */
export function namesIn(events: HarnessEvent[]): FilmNames {
  const models = new Set<string>()
  for (const e of events as any[]) for (const m of [e.payload?.model, e.raw?.model, e.model]) if (typeof m === 'string') models.add(m)
  return { models: [...models], urls: [] }
}

/** `s` as the screen shows it. */
export const shown = (s: string, n: FilmNames) => film.value ? filmText(s, n) : s
