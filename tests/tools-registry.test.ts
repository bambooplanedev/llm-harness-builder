import { test, expect } from 'vitest'

import { join } from 'node:path'
import { tmp } from './helpers.js'
import { runTool, TOOL_SCHEMAS } from '../src/core/tools/index.js'
import { TOOL_NAMES } from '../src/core/config.js'

test('every tool has a schema with required params', () => {
  for (const n of TOOL_NAMES) expect(TOOL_SCHEMAS[n].parameters).toHaveProperty('required')
})

test('unknown or disabled tool is a tool error, not a throw', async () => {
  const ctx = { workdir: await tmp('lhb-reg-'), maxToolOutputChars: 100 }
  const r1 = await runTool('grep', { q: 'x' }, ctx, ['read_file'])
  expect(r1.error).toBe(true); expect(r1.output).toMatch(/unknown tool grep.*available: read_file/)
  const r2 = await runTool('bash', { command: 'ls' }, ctx, ['read_file'])
  expect(r2.error).toBe(true)
})

test('missing required arg is a tool error', async () => {
  const ctx = { workdir: await tmp('lhb-reg-'), maxToolOutputChars: 100 }
  const r = await runTool('read_file', {}, ctx, ['read_file'])
  expect(r.error).toBe(true); expect(r.output).toMatch(/path/)
})

test('tool failure is returned as error text', async () => {
  const ctx = { workdir: await tmp('lhb-reg-'), maxToolOutputChars: 100 }
  const r = await runTool('read_file', { path: 'nope' }, ctx, ['read_file'])
  expect(r.error).toBe(true); expect(r.output).toMatch(/ENOENT|no such file/i)
})

test('an mcp tool is dispatched to the session, and unknown names list both sources', async () => {
  const ctx = { workdir: await tmp('lhb-reg-'), maxToolOutputChars: 100 }
  const calls: string[] = []
  const mcp = {
    tools: [{ name: 'echo', description: '', parameters: {} }], servers: [],
    has: (n: string) => n === 'echo',
    call: async (n: string) => { calls.push(n); return { output: 'from mcp', error: false } },
    close: () => {},
  }
  const hit = await runTool('echo', { text: 'x' }, ctx, ['read_file'], mcp as any)
  expect(hit).toEqual({ output: 'from mcp', error: false })
  expect(calls).toEqual(['echo'])

  const miss = await runTool('nope', {}, ctx, ['read_file'], mcp as any)
  expect(miss.error).toBe(true)
  expect(miss.output).toMatch(/unknown tool nope.*read_file.*echo/)
})

test('a built-in wins over an mcp tool of the same name', async () => {
  const ctx = { workdir: await tmp('lhb-reg-'), maxToolOutputChars: 100 }
  const mcp = { tools: [], servers: [], has: () => true, call: async () => ({ output: 'mcp', error: false }), close: () => {} }
  const r = await runTool('read_file', { path: 'nope' }, ctx, ['read_file'], mcp as any)
  expect(r.output).not.toBe('mcp')
})
