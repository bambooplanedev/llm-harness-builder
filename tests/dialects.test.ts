import { test, expect } from 'vitest'
import { DIALECTS, openaiChat, anthropic } from '../src/core/proxy/dialects/index.js'

test('matches routes as apiOf did', () => {
  expect(openaiChat.matches('POST', '/v1/chat/completions')).toBe(true)
  expect(openaiChat.matches('POST', '/chat/completions')).toBe(true)
  expect(openaiChat.matches('GET', '/v1/chat/completions')).toBe(false)
  expect(anthropic.matches('POST', '/v1/messages')).toBe(true)
  expect(anthropic.matches('POST', '/v1/messages/count_tokens')).toBe(false)
  expect(DIALECTS.find(d => d.matches('POST', '/v1/models'))).toBeUndefined()
})

test("labels are today's", () => {
  expect(openaiChat.label).toBe('POST /chat/completions')
  expect(anthropic.label).toBe('POST /v1/messages')
})

test('anthropic keyOf skips the first system block and ignores cache_control', () => {
  const p = (attr: string, user: object) => ({ model: 'm', system: [{ type: 'text', text: attr }, { type: 'text', text: 'sys' }], messages: [{ role: 'user', content: [user, { type: 'text', text: 'two' }] }] })
  const a = anthropic.keyOf(p('attr v1', { type: 'text', text: 'one' }))
  const b = anthropic.keyOf(p('attr v2', { type: 'text', text: 'one', cache_control: { type: 'ephemeral' } }))
  expect(a.key).toBe(b.key)
  expect(a.taskText).toBe('one\ntwo')
})

test('partial empty values', async () => {
  expect(await openaiChat.partial([], 'text/event-stream')).toBe('')
  expect(await anthropic.partial([], 'text/event-stream')).toBeUndefined()
})
