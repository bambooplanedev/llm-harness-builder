import { test, expect } from 'vitest'
import { validateConfig } from '../src/core/config.js'
import { harness } from './helpers.js'

const validConfig = harness()

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

  // Test non-object server values
  const serverString = structuredClone(validConfig) as any
  serverString.mcpServers = { fs: 'nope' }
  expect(validateConfig(serverString)).toContain('mcpServers.fs must be an object')

  const serverNumber = structuredClone(validConfig) as any
  serverNumber.mcpServers = { fs: 42 }
  expect(validateConfig(serverNumber)).toContain('mcpServers.fs must be an object')

  const serverArray = structuredClone(validConfig) as any
  serverArray.mcpServers = { fs: [] }
  expect(validateConfig(serverArray)).toContain('mcpServers.fs must be an object')
})

test('requireReadBeforeEdit and explainEditMiss are optional and must be booleans', () => {
  expect(validateConfig(validConfig)).toEqual([])
  for (const key of ['requireReadBeforeEdit', 'explainEditMiss']) {
    const on = structuredClone(validConfig) as any
    on.tools[key] = true
    expect(validateConfig(on)).toEqual([])
    const bad = structuredClone(validConfig) as any
    bad.tools[key] = 'yes'
    expect(validateConfig(bad).some(e => e.includes(key))).toBe(true)
  }
})

test('loop.maxRepeats is optional and must be a non-negative integer', () => {
  for (const ok of [0, 3]) {
    const c = structuredClone(validConfig) as any
    c.loop.maxRepeats = ok
    expect(validateConfig(c)).toEqual([])
  }
  for (const bad of [-1, 1.5, '3', true]) {
    const c = structuredClone(validConfig) as any
    c.loop.maxRepeats = bad
    expect(validateConfig(c).some(e => e.includes('maxRepeats'))).toBe(true)
  }
})

test('backend.maxTokens is optional and must be a positive integer', () => {
  const ok = structuredClone(validConfig) as any
  ok.backend.maxTokens = 1024
  expect(validateConfig(ok)).toEqual([])
  for (const bad of [0, -1, 1.5, '1024']) {
    const c = structuredClone(validConfig) as any
    c.backend.maxTokens = bad
    expect(validateConfig(c).some(e => e.includes('maxTokens'))).toBe(true)
  }
})

test('loop rejects a key it does not know: a misspelt knob would otherwise be silently off', () => {
  const c = structuredClone(validConfig) as any
  c.loop.freshcontext = 2
  expect(validateConfig(c).some(e => e.includes('loop.freshcontext'))).toBe(true)
})

test('loop.repeatTemperature is a number in [0, 2] and needs loop.maxRepeats', () => {
  for (const ok of [0, 0.7, 2]) {
    const c = structuredClone(validConfig) as any
    c.loop.maxRepeats = 3; c.loop.repeatTemperature = ok
    expect(validateConfig(c)).toEqual([])
  }
  for (const bad of [-0.1, 2.1, NaN, '1', true]) {
    const c = structuredClone(validConfig) as any
    c.loop.maxRepeats = 3; c.loop.repeatTemperature = bad
    expect(validateConfig(c).some(e => e.includes('repeatTemperature'))).toBe(true)
  }
  const alone = structuredClone(validConfig) as any
  alone.loop.repeatTemperature = 1
  expect(validateConfig(alone).some(e => e.includes('repeatTemperature') && e.includes('maxRepeats'))).toBe(true)
})

test('loop.freshContext is an integer from 1 to maxRepeats and needs loop.maxRepeats', () => {
  for (const ok of [1, 3]) {
    const c = structuredClone(validConfig) as any
    c.loop.maxRepeats = 3; c.loop.freshContext = ok
    expect(validateConfig(c)).toEqual([])
  }
  // above maxRepeats the run has ended before the reset could fire; with maxRepeats 0 nothing fits
  for (const [bad, max] of [[0, 3], [4, 3], [1.5, 3], ['2', 3], [1, 0]] as const) {
    const c = structuredClone(validConfig) as any
    c.loop.maxRepeats = max; c.loop.freshContext = bad
    expect(validateConfig(c).some(e => e.includes('freshContext'))).toBe(true)
  }
  const alone = structuredClone(validConfig) as any
  alone.loop.freshContext = 1
  expect(validateConfig(alone).some(e => e.includes('freshContext') && e.includes('maxRepeats'))).toBe(true)
})
