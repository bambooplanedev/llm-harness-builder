// src/core/redact.ts — the value of the backend key, taken out of text the harness records or shows. Replaced by its
// variable's name, wherever it occurs; a value shorter than REDACT_MIN is not looked for (see config.ts).
import { REDACT_MIN } from './config.js'

export type Redactor = { text(s: string): string; deep<T>(x: T): T }

const NONE: Redactor = { text: s => s, deep: x => x }

/** Replaces `value` with `[redacted: <name>]`: in a string, or in a new copy of plain objects and arrays, string by
 *  string — never by serialising and replacing, which would miss a value JSON escapes. The input is never changed. */
export function redactor(value: string | undefined, name: string): Redactor {
  if (!value || value.length < REDACT_MIN) return NONE
  const mark = `[redacted: ${name}]`
  const text = (s: string) => s.includes(value) ? s.split(value).join(mark) : s
  const walk = (x: unknown): unknown => {
    if (typeof x === 'string') return text(x)
    if (Array.isArray(x)) return x.map(walk)
    if (x !== null && typeof x === 'object' && Object.getPrototypeOf(x) === Object.prototype) {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(x)) out[k] = walk(v)
      return out
    }
    return x
  }
  return { text, deep: <T>(x: T) => walk(x) as T }
}
