import { test, expect } from 'vitest'
import { validateConfig, type HarnessConfig } from '../src/core/config.js'

export const validConfig: HarnessConfig = {
  name: 'test',
  backend: { kind: 'openai', baseUrl: 'http://localhost:8080/v1', model: 'm', temperature: 0 },
  systemPrompt: 'You are a coding agent.',
  tools: { enabled: ['read_file', 'bash'], approveBash: true },
  toolCalls: { mode: 'native', enforceSchema: false, promptedTemplate: 'Tools:\n{{tools}}', parseErrorHint: 'Reply with valid JSON.' },
  context: { maxToolOutputChars: 4000, budgetTokens: 0 },
  loop: { maxTurns: 10 },
}

test('valid config has no errors', () => {
  expect(validateConfig(validConfig)).toEqual([])
})

test('reports missing model, bad tool, bad mode', () => {
  const bad = structuredClone(validConfig) as any
  bad.backend.model = ''
  bad.tools.enabled.push('grep')
  bad.toolCalls.mode = 'magic'
  const errs = validateConfig(bad)
  expect(errs.some(e => e.includes('model'))).toBe(true)
  expect(errs.some(e => e.includes('grep'))).toBe(true)
  expect(errs.some(e => e.includes('mode'))).toBe(true)
})

test('non-object is an error', () => {
  expect(validateConfig(null).length).toBe(1)
})

test('prompted mode requires {{tools}} in promptedTemplate; native mode does not', () => {
  const prompted = structuredClone(validConfig) as any
  prompted.toolCalls.mode = 'prompted'
  prompted.toolCalls.promptedTemplate = ''
  expect(validateConfig(prompted).some(e => e.includes('{{tools}}'))).toBe(true)

  const native = structuredClone(validConfig) as any
  native.toolCalls.mode = 'native'
  native.toolCalls.promptedTemplate = ''
  expect(validateConfig(native)).toEqual([])
})
