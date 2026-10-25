import { test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { anatomy, anatomies, anatomyLine } from '../src/core/anatomy.js'
import { normalizeRequest } from '../src/core/normalize.js'
import type { HarnessEvent } from '../src/core/events.js'

const trace = (id: string): HarnessEvent[] => readFileSync(`example-runs/${id}.jsonl`, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(e => !('meta' in e))
const S = 'S'.repeat(40), U = 'U'.repeat(20), R = 'R'.repeat(100)
const openai = { model: 'm', tools: [{ type: 'function', function: { name: 'read_file', description: 'd', parameters: { type: 'object' } } }], messages: [
  { role: 'system', content: S }, { role: 'user', content: U },
  { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] },
  { role: 'tool', tool_call_id: 'c1', content: R } ] }

test('openai: chars per layer, scaled to the server prompt_tokens', () => {
  const a = anatomy(openai, { promptTokens: 500, completionTokens: 1 })!
  expect(a.chars).toEqual({ system: 40, tools: JSON.stringify(normalizeRequest(openai)!.tools).length, history: 20 + 9 + 12, results: 100 })
  expect([a.format, a.total, a.exact, a.toolsInSystem, a.thinkingBlocks]).toEqual(['openai', 500, true, false, 0])
  expect(Math.abs(Object.values(a.tokens).reduce((x, y) => x + y) - 500)).toBeLessThanOrEqual(2)
})

test('no usage, or promptTokens 0: chars/4 marked as an estimate', () => {
  for (const u of [undefined, { promptTokens: 0, completionTokens: 0 }]) {
    const a = anatomy(openai, u)!
    const sum = Object.values(a.chars).reduce((x, y) => x + y)
    expect([a.exact, a.total]).toEqual([false, Math.ceil(sum / 4)])
    expect(anatomyLine(a)).toMatch(/ · ≈\d+ tok$/)
  }
})

test('developer role is system; content-part arrays are counted, not read as empty', () => {
  const a = anatomy({ messages: [{ role: 'developer', content: 'D'.repeat(10) }, { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: 'x' } }] }] })!
  expect([a.chars.system, a.chars.history]).toEqual([10, 2])
})

test('anthropic: system blocks, tool_use in history, tool_result blocks in results, thinking flagged and not counted', () => {
  const p = { model: 'm', max_tokens: 5, system: [{ type: 'text', text: 'x'.repeat(8) }, { type: 'text', text: S, cache_control: { type: 'ephemeral' } }],
    tools: [{ name: 'read_file', description: 'd', input_schema: { type: 'object' } }], messages: [
      { role: 'user', content: U },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'T'.repeat(50), signature: 's' }, { type: 'text', text: 'ok' }, { type: 'tool_use', id: 'c1', name: 'read_file', input: { path: 'a' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: [{ type: 'text', text: R }] }] } ] }
  const a = anatomy(p, { promptTokens: 900, completionTokens: 1 })!
  expect([a.format, a.chars.system, a.chars.history, a.chars.results, a.thinkingBlocks]).toEqual(['anthropic', 48, 20 + 2 + 9 + 12, 100, 1])
  expect(anatomyLine(a)).toMatch(/ · 900 tok · thinking not counted$/)
})

test('prompted ollama (shipped example): one system + tools layer, every turn exact', () => {
  const xs = anatomies(trace('059867d3'))
  expect(xs.map(x => x.turn)).toEqual([1, 2, 3, 4, 5])
  expect(xs[0].a.total).toBe(651)
  expect(xs.every(x => x.a.exact && x.a.toolsInSystem && x.a.chars.tools === 0)).toBe(true)
  expect(anatomyLine(xs[0].a)).toMatch(/^system \+ tools \d+% · history \d+% · tool results \d+% · 651 tok$/)
})

test('native ollama (shipped example): tools are their own layer', () => {
  const xs = anatomies(trace('590eb245'))
  expect(xs).toHaveLength(8)
  expect(xs.every(x => !x.a.toolsInSystem && x.a.chars.tools > 0)).toBe(true)
})

test('an empty body has no anatomy and no entry', () => {
  expect(anatomy({})).toBeUndefined()
  expect(anatomies([{ seq: 0, turn: 1, ts: 0, type: 'llm_request', payload: {} }])).toEqual([])
})
