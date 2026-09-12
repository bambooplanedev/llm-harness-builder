import { test, expect } from 'vitest'
import { parsePrompted } from '../src/core/parse.js'

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
