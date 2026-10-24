import { test, expect } from 'vitest'
import { normalizeRequest } from '../src/core/normalize.js'

test('an OpenAI body is openai, its messages at the positions they were sent', () => {
  const payload = {
    model: 'm', tools: [{ type: 'function', function: { name: 'read_file', description: 'd', parameters: { type: 'object' } } }],
    messages: [
      { role: 'system', content: 'S' }, { role: 'user', content: 'U' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'A' },
    ],
  }
  expect(normalizeRequest(payload)).toEqual({
    format: 'openai', system: 'S', tools: [{ name: 'read_file', description: 'd', parameters: { type: 'object' } }],
    messages: [
      { role: 'system', text: 'S' }, { role: 'user', text: 'U' },
      { role: 'assistant', text: '', toolCalls: [{ name: 'read_file', args: { path: 'a' } }] },
      { role: 'tool', text: 'A' },
    ],
  })
})

test('an OpenAI body with max_tokens and content parts is still openai; parts read as empty text', () => {
  const n = normalizeRequest({ max_tokens: 10, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })
  expect(n).toMatchObject({ format: 'openai', messages: [{ role: 'user', text: '' }] })
})

test('an Anthropic body: system is message 0, tool_result and text blocks are one message each, in order', () => {
  const payload = {
    model: 'm', max_tokens: 5, system: 'S', tools: [{ name: 'read_file', description: 'd', input_schema: { type: 'object' } }],
    messages: [
      { role: 'user', content: 'U' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 't', signature: 'x' }, { type: 'text', text: 'ok' }, { type: 'tool_use', id: 'c1', name: 'read_file', input: { path: 'a' } }, { type: 'tool_use', id: 'c2', name: 'read_file', input: { path: 'b' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'A' }, { type: 'tool_result', tool_use_id: 'c2', content: 'B', is_error: true }, { type: 'text', text: 'more' }] },
    ],
  }
  expect(normalizeRequest(payload)).toEqual({
    format: 'anthropic', system: 'S', tools: [{ name: 'read_file', description: 'd', parameters: { type: 'object' } }],
    messages: [
      { role: 'system', text: 'S' }, { role: 'user', text: 'U' },
      { role: 'assistant', text: 'ok', toolCalls: [{ name: 'read_file', args: { path: 'a' } }, { name: 'read_file', args: { path: 'b' } }] },
      { role: 'tool', text: 'A' }, { role: 'tool', text: 'B' }, { role: 'user', text: 'more' },
    ],
  })
})

test('a system given as an array of blocks is joined into one text', () => {
  const n = normalizeRequest({ system: [{ type: 'text', text: 'one ' }, { type: 'text', text: 'two' }], messages: [{ role: 'user', content: 'U' }] })
  expect(n).toMatchObject({ format: 'anthropic', system: 'one two', messages: [{ role: 'system', text: 'one two' }, { role: 'user', text: 'U' }] })
})

test('a payload with no messages array is no request', () => {
  for (const p of [null, 'x', { messages: 5 }]) expect(normalizeRequest(p)).toBeUndefined()
})
