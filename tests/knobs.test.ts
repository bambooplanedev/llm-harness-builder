import { test, expect } from 'vitest'
import { knobsOff } from '../src/core/knobs.js'
import { harness } from './helpers.js'

const h = harness({ backend: { kind: 'openai', baseUrl: 'https://or.example/api/v1', model: 'm/x', temperature: 0.2, apiKeyEnv: 'OR_API_KEY' } })
const from = 'OpenRouter supported_parameters'

test('without info nothing is off', () => {
  expect(knobsOff(h, undefined)).toEqual({ off: [] })
  expect(knobsOff(h, { router: false })).toEqual({ off: [] })
})

test('a temperature the model does not take is off, with its value and where that is known from', () => {
  const { off, refuse } = knobsOff(h, { takes: { temperature: false }, takesFrom: from })
  expect(refuse).toBeUndefined()
  expect(off).toHaveLength(1)
  expect(off[0]).toMatchObject({ knob: 'temperature', value: 0.2 })
  expect(off[0].reason).toContain('m/x'); expect(off[0].reason).toContain(from)
})

test('loop.repeatTemperature goes off with temperature', () => {
  const c = { ...h, loop: { ...h.loop, maxRepeats: 2, repeatTemperature: 0.9 } }
  expect(knobsOff(c, { takes: { temperature: false }, takesFrom: from }).off.map(o => [o.knob, o.value])).toEqual([['temperature', 0.2], ['repeatTemperature', 0.9]])
})

test('think and maxTokens are off only when the harness sets them', () => {
  const info = { takes: { think: false, maxTokens: false } as const, takesFrom: 'Ollama /api/show' }
  expect(knobsOff(h, info).off).toEqual([])
  const c = { ...h, backend: { ...h.backend, think: false, maxTokens: 512 } }
  expect(knobsOff(c, info).off.map(o => [o.knob, o.value])).toEqual([['maxTokens', 512], ['think', false]])
})

test('native tool calls to a model that takes no tools refuse the run and point to prompted', () => {
  const r = knobsOff(h, { takes: { tools: false }, takesFrom: from })
  expect(r.refuse).toContain('mode: "prompted"'); expect(r.refuse).toContain(from)
})

test('native with no tools at all is fine when the model takes no tools', () => {
  expect(knobsOff({ ...h, tools: { enabled: [], approveBash: false } }, { takes: { tools: false } })).toEqual({ off: [] })
})

test('a schema the model does not take refuses the run when the harness enforces one', () => {
  const c = { ...h, toolCalls: { ...h.toolCalls, mode: 'prompted' as const, enforceSchema: true } }
  expect(knobsOff(c, { takes: { responseSchema: false }, takesFrom: from }).refuse).toContain('enforceSchema: false')
  expect(knobsOff({ ...c, toolCalls: { ...c.toolCalls, enforceSchema: false } }, { takes: { responseSchema: false } })).toEqual({ off: [] })
})

test('anthropic needs a max_tokens: from the harness or from the server', () => {
  const a = { ...h, backend: { ...h.backend, kind: 'anthropic' as const, model: 'claude-haiku-5-5' } }
  expect(knobsOff(a, { router: false }).refuse).toContain('set backend.maxTokens')
  expect(knobsOff(a, undefined).refuse).toContain('set backend.maxTokens')
  expect(knobsOff(a, { maxOutput: 64000 }).refuse).toBeUndefined()
  expect(knobsOff({ ...a, backend: { ...a.backend, maxTokens: 1024 } }, undefined).refuse).toBeUndefined()
})
