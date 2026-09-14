import { test, expect } from 'vitest'
import { parsePrompted, parseHermes } from '../src/core/parse.js'

const obj = { calls: [{ name: 'read_file', args: { path: 'a.ts' } }], final: null }

test('bare json', () => {
  const r = parsePrompted(JSON.stringify(obj))
  expect(r.ok && r.calls[0].name).toBe('read_file')
})

test('fenced json with text around', () => {
  const r = parsePrompted('Sure.\n```json\n' + JSON.stringify(obj) + '\n```\nDone.')
  expect(r.ok && r.calls.length).toBe(1)
})

test('json object embedded in prose', () => {
  const r = parsePrompted('I will read it: ' + JSON.stringify(obj) + ' ok?')
  expect(r.ok && r.calls.length).toBe(1)
})

test('final without calls', () => {
  const r = parsePrompted(JSON.stringify({ calls: [], final: 'All done.' }))
  expect(r.ok && r.final).toBe('All done.')
})

test('prose without json is a parse error', () => {
  const r = parsePrompted('Sure, let me read the file first.')
  expect(r.ok).toBe(false)
})

test('json of wrong shape is a parse error', () => {
  const r = parsePrompted('{"tool": "read_file"}')
  expect(r.ok).toBe(false)
})

test('inline <think> block is stripped before parsing', () => {
  const r = parsePrompted('<think>maybe {"calls": []} hmm</think>\n{"calls":[{"name":"read_file","args":{"path":"a"}}],"final":null}')
  expect(r.ok && r.calls.length).toBe(1)
  expect(r.ok && r.calls[0].name).toBe('read_file')
})

const tc = (o: unknown) => `<tool_call>\n${JSON.stringify(o)}\n</tool_call>`
const rf = { name: 'read_file', arguments: { path: 'a.ts' } }

test.each<[string, string, { ok: boolean; calls?: number; name?: string; final?: string | null; args?: unknown }]>([
  ['one block', tc(rf), { ok: true, calls: 1, name: 'read_file', final: null }],
  ['two blocks', tc(rf) + '\n' + tc({ name: 'bash', arguments: { command: 'ls' } }), { ok: true, calls: 2 }],
  ['text around blocks', 'Let me look.\n' + tc(rf) + '\nThen I will fix it.', { ok: true, calls: 1, final: null }],
  ['closed think before block', '<think>hmm</think>\n' + tc(rf), { ok: true, calls: 1 }],
  ['unclosed think', '<think>still thinking ' + tc(rf), { ok: false }],
  ['broken json inside block', '<tool_call>{oops</tool_call>', { ok: false }],
  ['block without name', '<tool_call>{"arguments":{}}</tool_call>', { ok: false }],
  ['unclosed tool_call', '<tool_call>' + JSON.stringify(rf), { ok: false }],
  ['plain text is final', 'All done, tests pass.', { ok: true, calls: 0, final: 'All done, tests pass.' }],
  ['empty', '  \n ', { ok: false }],
  ['parameters alias', tc({ name: 'read_file', parameters: { path: 'b' } }), { ok: true, calls: 1, args: { path: 'b' } }],
  ['missing arguments -> {}', tc({ name: 'list_dir' }), { ok: true, calls: 1, args: {} }],
])('parseHermes: %s', (_, text, want) => {
  const r = parseHermes(text)
  expect(r.ok).toBe(want.ok)
  if (!r.ok) return
  if (want.calls !== undefined) expect(r.calls).toHaveLength(want.calls)
  if (want.name) expect(r.calls[0].name).toBe(want.name)
  if (want.final !== undefined) expect(r.final).toBe(want.final)
  if (want.args) expect(r.calls[0].args).toEqual(want.args)
})
