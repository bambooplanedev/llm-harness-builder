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

test('format is optional; hermes + enforceSchema is valid; unknown format is an error', () => {
  const noFormat = structuredClone(validConfig) as any
  expect(validateConfig(noFormat)).toEqual([])

  const hermes = structuredClone(validConfig) as any
  hermes.toolCalls.mode = 'prompted'
  hermes.toolCalls.format = 'hermes'
  hermes.toolCalls.enforceSchema = true
  expect(validateConfig(hermes)).toEqual([])

  const bad = structuredClone(validConfig) as any
  bad.toolCalls.format = 'xml'
  expect(validateConfig(bad).some(e => e.includes('format'))).toBe(true)
})

test('mcpServers is optional and validated per server', () => {
  const ok = structuredClone(validConfig) as any
  ok.mcpServers = { fs: { command: 'npx', args: ['-y', 'x', '.'], tools: ['read_file'] } }
  expect(validateConfig(ok)).toEqual([])

  const noServers = structuredClone(validConfig) as any
  noServers.mcpServers = undefined
  expect(validateConfig(noServers)).toEqual([])

  const bad = structuredClone(validConfig) as any
  bad.mcpServers = { fs: { command: '', args: 'nope', tools: [1] }, '': { command: 'x' } }
  const errs = validateConfig(bad)
  expect(errs).toContain('mcpServers.fs.command must be a non-empty string')
  expect(errs).toContain('mcpServers.fs.args must be an array of strings')
  expect(errs).toContain('mcpServers.fs.tools must be an array of strings')
  expect(errs).toContain('mcpServers key must be a non-empty string')

  const notObj = structuredClone(validConfig) as any
  notObj.mcpServers = []
  expect(validateConfig(notObj)).toContain('mcpServers must be an object')
})
