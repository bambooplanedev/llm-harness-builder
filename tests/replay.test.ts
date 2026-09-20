import { test, expect } from 'vitest'
import { replayPayload, replySignature, recordedTurn } from '../src/core/replay.js'

test('replayPayload overrides sampling where each backend keeps it and touches nothing else', () => {
  const openai = { model: 'm', messages: [{ role: 'user', content: 'hi' }], temperature: 0.2, stream: true }
  expect(replayPayload(openai, 'openai', {})).toEqual(openai)
  expect(replayPayload(openai, 'openai', { temperature: 1, maxTokens: 400 })).toEqual({ ...openai, temperature: 1, max_tokens: 400 })
  const ollama = { model: 'm', messages: [], stream: true, options: { temperature: 0.2, num_ctx: 8192 } }
  expect(replayPayload(ollama, 'ollama', {})).toEqual(ollama)
  expect(replayPayload(ollama, 'ollama', { temperature: 0, maxTokens: 400 })).toEqual({ ...ollama, options: { temperature: 0, num_ctx: 8192, num_predict: 400 } })
  expect(openai.temperature).toBe(0.2) // the recorded payload is not mutated
})

test('replySignature reads content and native calls from either raw shape, and ignores call ids and thinking', () => {
  const a = { choices: [{ message: { content: '', reasoning_content: 'hm', tool_calls: [{ id: 'x1', function: { name: 'bash', arguments: '{"command":"ls"}' } }] } }] }
  const b = { choices: [{ message: { content: '', reasoning_content: 'other', tool_calls: [{ id: 'x2', function: { name: 'bash', arguments: '{"command":"ls"}' } }] } }] }
  expect(replySignature(a)).toBe(replySignature(b))
  expect(replySignature({ message: { content: '', tool_calls: [{ function: { name: 'bash', arguments: { command: 'ls' } } }] } })).toBe(replySignature(a))
  expect(replySignature({ message: { content: '{"calls":[]}' } })).not.toBe(replySignature({ message: { content: '{"calls":[],"final":"ok"}' } }))
})

test('recordedTurn finds the request of a turn and the response that answered it', () => {
  const lines = [
    { meta: { id: 'abc' } },
    { seq: 0, turn: 1, type: 'llm_request', payload: { n: 1 } }, { seq: 1, turn: 1, type: 'llm_response', raw: { message: { content: 'one' } }, content: 'one' },
    { seq: 2, turn: 2, type: 'llm_request', payload: { n: 2 } }, { seq: 3, turn: 2, type: 'error', message: 'down' },
  ]
  expect(recordedTurn(lines, 1)).toEqual({ payload: { n: 1 }, raw: { message: { content: 'one' } } })
  expect(recordedTurn(lines, 2)).toEqual({ payload: { n: 2 }, raw: undefined }) // the backend failed: a request with no reply still replays
  expect(() => recordedTurn(lines, 3)).toThrow('no llm_request at turn 3 (the run has turns 1–2)')
})
