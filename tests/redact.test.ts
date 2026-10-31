import { test, expect, vi } from 'vitest'
import { keyRedactor, redactor } from '../src/core/redact.js'
import { apiKey } from '../src/core/config.js'

const KEY = 'sk-or-v1-' + 'a1'.repeat(16)

test('every occurrence in a string becomes the mark', () => {
  const r = redactor(KEY, 'OPENROUTER_API_KEY')
  expect(r.text(`A=${KEY}\nB=${KEY}`)).toBe('A=[redacted: OPENROUTER_API_KEY]\nB=[redacted: OPENROUTER_API_KEY]')
  expect(r.text('nothing here')).toBe('nothing here')
})

test('deep: a new structure with every string redacted, arrays and nesting included; the input is left as it was', () => {
  const r = redactor(KEY, 'K_API_KEY')
  const input = { a: KEY, n: 3, ok: true, none: null, list: [`x${KEY}`, { b: [KEY] }], nested: { c: { d: `${KEY}!` } } }
  const before = structuredClone(input)
  const out = r.deep(input)
  expect(out).toEqual({ a: '[redacted: K_API_KEY]', n: 3, ok: true, none: null, list: ['x[redacted: K_API_KEY]', { b: ['[redacted: K_API_KEY]'] }], nested: { c: { d: '[redacted: K_API_KEY]!' } } })
  expect(input).toEqual(before)
  expect(out).not.toBe(input); expect(out.list).not.toBe(input.list); expect(out.nested.c).not.toBe(input.nested.c)
  expect(r.deep({ [`k${KEY}`]: 1 })).toEqual({ 'k[redacted: K_API_KEY]': 1 }) // an object key too
})

test('a key with regex metacharacters is replaced literally, every time; a near miss is left alone', () => {
  const key = 'sk-or-v1-a+b/c=d.e*f$g^h(i)j[k]l{m}n|o\\p?q'
  const r = redactor(key, 'K_API_KEY')
  expect(r.text(`${key} and ${key}`)).toBe('[redacted: K_API_KEY] and [redacted: K_API_KEY]')
  expect(r.text(key.replace('.', 'X'))).toBe(key.replace('.', 'X'))
})

test('20 characters is redacted; 19, 19 left after the trim apiKey does, and no value at all pass as they are', () => {
  const twenty = 'k'.repeat(20), nineteen = 'k'.repeat(19)
  expect(redactor(twenty, 'K_API_KEY').text(`<${twenty}>`)).toBe('<[redacted: K_API_KEY]>')
  expect(redactor(nineteen, 'K_API_KEY').text(`<${nineteen}>`)).toBe(`<${nineteen}>`)
  const padded = apiKey({ apiKeyEnv: 'K_API_KEY' }, { K_API_KEY: `  ${nineteen}  ` })
  expect(padded).toBe(nineteen)
  expect(redactor(padded, 'K_API_KEY').text(`  ${nineteen}  `)).toBe(`  ${nineteen}  `)
  const none = { a: 'x' }
  expect(redactor(undefined, 'K_API_KEY').deep(none)).toBe(none)
})

test('keyRedactor: the value the name holds, trimmed, marked with the name; no name or no usable value redacts nothing', () => {
  vi.stubEnv('K_API_KEY', `  ${KEY}  `)
  try {
    expect(keyRedactor({ apiKeyEnv: 'K_API_KEY' }).text(`x${KEY}y`)).toBe('x[redacted: K_API_KEY]y')
    expect(keyRedactor({}).text(KEY)).toBe(KEY)
    expect(keyRedactor({ apiKeyEnv: 'UNSET_API_KEY' }).text(KEY)).toBe(KEY)
    vi.stubEnv('K_API_KEY', '')
    expect(keyRedactor({ apiKeyEnv: 'K_API_KEY' }).text(KEY)).toBe(KEY)
  } finally { vi.unstubAllEnvs() }
})
